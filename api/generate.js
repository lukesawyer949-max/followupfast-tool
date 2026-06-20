export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { businessName, customerName, jobType, scenarioLabel, tone } = req.body || {};

  if (!businessName || !customerName || !jobType || !scenarioLabel || !tone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const prompt = `You are a follow-up message writer for home service businesses. Generate 3 follow-up messages for the following situation:

Business name: ${businessName}
Customer name: ${customerName}
Job type: ${jobType}
Scenario: ${scenarioLabel}
Tone: ${tone}

Generate exactly 3 messages:
1. An EMAIL (with subject line)
2. An SMS text message (under 160 characters)
3. A VOICEMAIL script (15-20 seconds when spoken)

Respond ONLY in valid JSON with this exact structure, no markdown, no extra text:
{
  "email": { "subject": "...", "body": "..." },
  "sms": { "body": "..." },
  "voicemail": { "script": "..." }
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      return res.status(502).json({ error: "Upstream API error" });
    }

    const data = await response.json();
    const text = (data.content || []).map((c) => c.text || "").join("").trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Generate handler error:", err);
    return res.status(500).json({ error: "Something went wrong generating messages" });
  }
}
