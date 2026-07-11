import { config } from "./config.js";

async function callClaude(system, user, maxTokens = 800) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function parseJSONSafe(t) {
  const clean = t.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const s = clean.indexOf("{");
    const e = clean.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try { return JSON.parse(clean.slice(s, e + 1)); } catch { return null; }
    }
    return null;
  }
}

export async function analyzeEmail(email, categories = []) {
  const sys =
    "You are MAILER, an inbox assistant for busy business owners. Concise, decision-ready. Respond ONLY with valid JSON, no fences, no preamble.";
  const catList = categories.length ? categories.join(", ") : "Other";
  const user = `Analyze this email. Return JSON exactly:
{"summary":"one or two short sentences: who wants what, any money or deadline at stake","action":"the single concrete action requested of the reader with any deadline, or null","category":"pick exactly one from this list: ${catList}"}

FROM: ${email.from}
SUBJECT: ${email.subject}
ATTACHMENTS: ${(email.attachments || []).join(", ") || "none"}
BODY:
${(email.body || "").slice(0, 6000)}`;
  const raw = await callClaude(sys, user, 400);
  const p = parseJSONSafe(raw);
  return {
    summary: p?.summary || raw.slice(0, 240),
    action: p?.action || null,
    category: p?.category || null,
  };
}

export async function draftReply(email, instruction) {
  const sys =
    "You draft email replies on behalf of a business owner. Follow the owner's instruction for tone and format exactly. Output only the reply email body — no subject line, no commentary, no signature placeholders unless asked.";
  const user = `Original email:
FROM: ${email.from}
SUBJECT: ${email.subject}
BODY:
${(email.body || "").slice(0, 6000)}

Owner's instruction for the reply: ${instruction}`;
  return callClaude(sys, user, 800);
}

export async function fillTemplate(email, template) {
  const sys =
    "You fill reply templates using details extracted from the original email. Keep the template's wording and structure intact; replace only placeholders (like [client name], [amount], [date]) with correct values found in the email. If a value is not present in the email, write [NEEDS INPUT: what is missing]. Output only the completed reply body.";
  const user = `Original email:
FROM: ${email.from}
SUBJECT: ${email.subject}
BODY:
${(email.body || "").slice(0, 6000)}

Template to fill:
${template.content}`;
  return callClaude(sys, user, 800);
}

export async function dailyRoundup(openEmails) {
  if (openEmails.length === 0) return "Inbox clear. Nothing waiting on you.";
  const listing = openEmails
    .map(
      (e, i) =>
        `${i + 1}. [${(e.priority || "normal").toUpperCase()}] From: ${e.from} | Subject: ${e.subject} | Summary: ${e.summary || (e.body || "").slice(0, 160)} | Action: ${e.action || "—"} | Attachments: ${(e.attachments || []).join(", ") || "none"}`
    )
    .join("\n");
  const sys =
    "You are MAILER. Write a short daily inbox roundup for a business owner reading it on their phone. Plain text only, no markdown. Lead with what needs them today (high priority first, name deadlines and money), then one compact paragraph covering everything else so nothing is left out. Under 140 words.";
  return callClaude(sys, `Open emails:\n${listing}`, 600);
}
