// FollowUpFast — free trial endpoint
// - Keeps the Anthropic key server-side.
// - Requires an email and enforces a per-email generation limit in Supabase.
// - Fails closed: if trial storage isn't configured, nothing is generated.

import { createHash } from "node:crypto";

const MODEL = "claude-sonnet-5-5";
const TABLE = "trial_users";
const MAX_NEW_TRIALS_PER_IP_PER_DAY = 3;
const RESERVE_ATTEMPTS = 8;

const ALLOWED_SCENARIOS = [
  "No response after quote",
  "After completed job",
  "Missed call follow-up",
  "Overdue maintenance reminder",
  "Thank you + review request",
  "Availability nudge",
  "Schedule update",
];
const REVIEW_SCENARIO = "Thank you + review request";
const ALLOWED_TONES = ["friendly", "professional", "urgent"];
const ALLOWED_REFINE = ["shorter", "friendlier"];

// Best-effort burst limit: 10 requests per IP per 10 minutes (in memory; resets when an
// instance restarts). The Supabase trial limit and the Anthropic Console spend limit are
// the real backstops.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 10;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// Optional callback number. Anything that doesn't look like a phone number is dropped.
function cleanPhone(value) {
  const v = clean(value, 30);
  return /^[0-9 ()+.\-]{7,30}$/.test(v) && v.replace(/\D/g, "").length >= 7 ? v : "";
}

// Optional quote amount in dollars. Invalid or out-of-range values become 0 (not provided).
function cleanAmount(value) {
  const n = typeof value === "number" ? value : Number(String(value == null ? "" : value).replace(/[$,\s]/g, ""));
  return isFinite(n) && n > 0 && n <= 1000000 ? Math.round(n * 100) / 100 : 0;
}

// Optional review link. Only plain https links are accepted; anything else is dropped.
function cleanUrl(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v.length > 300 || /\s/.test(v)) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return "";
    return u.toString();
  } catch (_) {
    return "";
  }
}

function cleanEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (email.length > 254) return "";
  return /^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(email) ? email : "";
}

function clientIp(req) {
  const h = req.headers || {};
  const raw = h["x-real-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || (req.socket && req.socket.remoteAddress) || "";
  return String(raw).trim() || "unknown";
}

function hashIp(ip) {
  return createHash("sha256").update(ip + (process.env.IP_HASH_SALT || "followupfast")).digest("hex").slice(0, 32);
}

function config() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const limit = Math.max(1, parseInt(process.env.TRIAL_LIMIT || "5", 10) || 5);
  return { url, key, limit, ok: /^https?:\/\//.test(url) && key.length > 0 };
}

/* ---------- Supabase (PostgREST over fetch, no dependencies) ---------- */

function sbHeaders(key, prefer) {
  // New-style secret keys (sb_secret_...) go in `apikey` only. Legacy JWT keys (eyJ...) also need Bearer.
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function sb(cfg, method, query, body, prefer) {
  const res = await fetch(`${cfg.url}/rest/v1/${TABLE}${query ? "?" + query : ""}`, {
