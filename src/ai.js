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
    "You are MAILER, an inbox assistant for busy business owners. Your summaries must be concise but complete — never drop a date, amount, deadline, order/invoice number, or named commitment. Respond ONLY with valid JSON, no fences, no preamble.";
  const catList = categories.length ? categories.join(", ") : "Other";
  const user = `Analyze this email. Return JSON exactly:
{"summary":"2-4 short sentences covering who wants what and why — every date, amount, deadline, and reference number mentioned in the email must appear here, none omitted","action":"the single concrete action requested of the reader with its deadline, or null","highlights":["short standalone facts worth calling out, e.g. 'Due Fri 18 Jul' or '$4,000 owed' or 'Invoice #2214' — empty array if the email has none"],"category":"pick exactly one from this list: ${catList}"}

FROM: ${email.from}
SUBJECT: ${email.subject}
ATTACHMENTS: ${(email.attachments || []).join(", ") || "none"}
BODY:
${(email.body || "").slice(0, 6000)}`;
  const raw = await callClaude(sys, user, 500);
  const p = parseJSONSafe(raw);
  return {
    summary: p?.summary || raw.slice(0, 240),
    action: p?.action || null,
    highlights: Array.isArray(p?.highlights) ? p.highlights.filter((h) => typeof h === "string").slice(0, 6) : [],
    category: p?.category || null,
  };
}

export async function extractFields(email, fields) {
  const sys =
    "You extract structured data from business emails. Respond ONLY with valid JSON, no fences, no preamble. Only use information actually present in the email — never invent a value.";
  const user = `Extract these fields from the email below. Return a JSON object with exactly these keys: ${JSON.stringify(fields)}.
For each field, put the value found in the email as a short string. If a field isn't mentioned in the email, use an empty string "" for it.

FROM: ${email.from}
SUBJECT: ${email.subject}
BODY:
${(email.body || "").slice(0, 6000)}`;
  const raw = await callClaude(sys, user, 500);
  const p = parseJSONSafe(raw) || {};
  const out = {};
  for (const f of fields) out[f] = typeof p[f] === "string" ? p[f] : "";
  return out;
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
        `${i + 1}. [${(e.priority || "normal").toUpperCase()}] From: ${e.from} | Subject: ${e.subject} | Summary: ${e.summary || (e.body || "").slice(0, 160)} | Key facts: ${(e.highlights || []).join(", ") || "none"} | Action: ${e.action || "—"} | Attachments: ${(e.attachments || []).join(", ") || "none"}`
    )
    .join("\n");
  const sys =
    "You are MAILER. Write a short daily inbox roundup for a business owner reading it on their phone. Plain text only, no markdown. Lead with what needs them today (high priority first, name deadlines and money), then one compact paragraph covering everything else so nothing is left out. Under 140 words.";
  return callClaude(sys, `Open emails:\n${listing}`, 600);
}

const ASSISTANT_ACTIONS = [
  "view_emails", "view_category", "view_tier", "search", "refresh_inbox",
  "add_rule", "add_category", "create_folder", "add_template", "add_business", "unknown",
];

export async function interpretCommand(text) {
  const sys =
    "You are MAILER's dashboard voice/text assistant. Map the user's spoken or typed command to EXACTLY ONE action from the allowed list. " +
    "Only choose add_rule/add_category/create_folder/add_template/add_business when the user clearly asked to create/add something — never invent field values that weren't said. " +
    "If the command is unclear, ambiguous, or destructive (e.g. delete/remove/send), use \"unknown\" and ask a brief clarifying question instead of guessing. " +
    "Respond ONLY with valid JSON, no fences, no preamble.";
  const user = `Allowed actions: ${ASSISTANT_ACTIONS.join(", ")}

Command: "${text}"

Return JSON with exactly these keys (omit any not relevant to the chosen action):
{"action":"one of the allowed actions","message":"short friendly confirmation phrased as already done, or a brief clarifying question if action is unknown","query":"search text, for action=search only","type":"sender|domain|keyword, for action=add_rule only","value":"for action=add_rule only","level":"high|low, for action=add_rule only","name":"for action=add_category|create_folder|add_template|add_business","fields":["field names, for action=create_folder only"],"content":"for action=add_template only","domain":"the business's email domain e.g. acme.com, for action=add_business only"}`;
  const raw = await callClaude(sys, user, 300);
  const p = parseJSONSafe(raw);
  if (!p || !ASSISTANT_ACTIONS.includes(p.action)) {
    return { action: "unknown", message: "I didn't catch that — could you rephrase?" };
  }
  return p;
}
