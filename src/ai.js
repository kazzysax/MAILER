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
    "You are Mailer, an inbox assistant for busy business owners. Your summaries must be concise but complete — never drop a date, amount, deadline, order/invoice number, or named commitment. Respond ONLY with valid JSON, no fences, no preamble.";
  const catList = categories.length ? categories.join(", ") : "Other";
  const links = email.links || [];
  const linksBlock = links.length ? links.map((l, i) => `${i + 1}. ${l}`).join("\n") : "none";
  const user = `Analyze this email. Return JSON exactly:
{"summary":"2-4 short sentences covering who wants what and why — every date, amount, deadline, and reference number mentioned in the email must appear here, none omitted","action":"the single concrete action requested of the reader with its deadline, or null","actionLink":"if completing the action means clicking a link, copy that EXACT URL verbatim from the LINKS FOUND list below — never invent or modify one; null if no link applies or the list is empty","highlights":["short standalone facts worth calling out, e.g. 'Due Fri 18 Jul' or '$4,000 owed' or 'Invoice #2214' — empty array if the email has none"],"category":"pick exactly one from this list: ${catList}"}

FROM: ${email.from}
SUBJECT: ${email.subject}
ATTACHMENTS: ${(email.attachments || []).join(", ") || "none"}
LINKS FOUND IN EMAIL:
${linksBlock}
BODY:
${(email.body || "").slice(0, 6000)}`;
  const raw = await callClaude(sys, user, 500);
  const p = parseJSONSafe(raw);
  // never trust an AI-produced URL blindly — only accept it if it's genuinely one of
  // the links we actually extracted from this email
  const actionLink = typeof p?.actionLink === "string" && links.includes(p.actionLink) ? p.actionLink : null;
  return {
    summary: p?.summary || raw.slice(0, 240),
    action: p?.action || null,
    actionLink,
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

// Who the reply is going to changes what "appropriate" even means — the same
// instruction ("keep it brief") should read very differently to a CEO than to a
// friend. Picked by the user before drafting (dashboard pill picker / Telegram
// inline buttons) rather than guessed from the email itself.
const RELATIONSHIP_GUIDANCE = {
  exec: "The recipient is a CEO/senior executive — formal, respectful, concise, get to the point.",
  jobapp: "This is regarding a job application — professional, polished, put the best foot forward.",
  care: "The recipient is a customer support/care contact — clear, polite, specific about what's needed.",
  client: "The recipient is a business partner or client — professional but personable.",
  colleague: "The recipient is a colleague/coworker — professional, can be more direct/relaxed.",
  family: "The recipient is family — warm, casual, personal.",
  friend: "The recipient is a friend — casual, relaxed, friendly.",
  other: "Use best judgment for an appropriate professional tone.",
};

export async function draftReply(email, instruction, relationship) {
  const guidance = RELATIONSHIP_GUIDANCE[relationship] || RELATIONSHIP_GUIDANCE.other;
  const sys =
    `You draft email replies on behalf of a business owner. ${guidance} Follow the owner's instruction for tone and format exactly within that context. Output only the reply email body — no subject line, no commentary, no signature placeholders unless asked.`;
  const user = `Original email:
FROM: ${email.from}
SUBJECT: ${email.subject}
BODY:
${(email.body || "").slice(0, 6000)}

Owner's instruction for the reply: ${instruction}`;
  return callClaude(sys, user, 800);
}

// Standard English email formats — distinct from draftReply's relationship guidance
// above: this is about *format/register* (how formal the writing itself is), not who
// the recipient is, and it isn't tied to an existing inbox email — a from-scratch
// composer (dashboard's "Mail Format" tab) rather than a reply.
const MAIL_FORMAT_GUIDANCE = {
  formal: "Write in a strictly formal English business-letter register: a proper salutation (e.g. 'Dear Mr./Ms. [Name]' or 'Dear Sir/Madam' if no name is given), no contractions, precise and respectful language throughout, and a formal closing (e.g. 'Yours sincerely,').",
  semiformal: "Write in a semi-formal register: polite and professional but a little warmer than strictly formal — mild contractions are fine, still respectful, a friendly-but-professional closing (e.g. 'Best regards,').",
  informal: "Write in an informal, conversational register: relaxed and warm, contractions are fine, a casual greeting and sign-off (e.g. 'Hi [name],' ... 'Thanks!').",
  application: "Write as a formal job/opportunity application or cover letter: professional and confident, concisely highlights relevant strengths and intent, formal salutation and closing, persuasive without being overblown.",
};

export async function craftMail({ format, recipient, instruction }) {
  const guidance = MAIL_FORMAT_GUIDANCE[format] || MAIL_FORMAT_GUIDANCE.formal;
  const sys =
    `You write complete, polished emails from scratch, following standard English email-writing conventions. ${guidance} Output only the finished email body (including greeting and sign-off) — no subject line, no commentary, no placeholders unless information is genuinely missing.`;
  const user = `${recipient ? `Who this is for / context about them: ${recipient}\n\n` : ""}What the email needs to say: ${instruction}`;
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
    "You are Mailer. Write a daily inbox roundup for a business owner reading it on their phone. Plain text only — no markdown, no asterisks, no HTML tags. " +
    "Structure it clearly, NOT as one dense paragraph: use blank lines to separate sections, and put each item on its own line starting with '- '. " +
    "Start with a NEEDS YOU TODAY section (only if there are high-priority items) — one line per item, naming deadlines and money. " +
    "Leave a blank line, then an EVERYTHING ELSE section listing the rest the same way, one item per line, so nothing is left out. " +
    "Keep each line short and scannable. Under 160 words total.";
  return callClaude(sys, `Open emails:\n${listing}`, 700);
}

// Shared by the dashboard's "Ask Mailer" widget AND the Telegram bot's free-form chat
// (src/engine.js's handleChatMessage) — one brain, two renderers. view_category/view_tier
// only make sense where there are persistent tabs to switch (the dashboard); Telegram maps
// them to the closest thing it has (view_emails) since there's no tab to point at there.
const ASSISTANT_ACTIONS = [
  "view_emails", "view_category", "view_tier", "search", "refresh_inbox",
  "mute", "report", "help",
  "add_rule", "add_category", "create_folder", "add_template", "add_business", "unknown",
];

export async function interpretCommand(text) {
  const sys =
    "You are Mailer's voice/text assistant, used from both the web dashboard and the Telegram bot. Map the user's spoken or typed command to EXACTLY ONE action from the allowed list. " +
    "Only choose add_rule/add_category/create_folder/add_template/add_business when the user clearly asked to create/add something — never invent field values that weren't said. " +
    "For mute, set on:true with start/end hours (0-23) if they gave a quiet-hours range, or on:false to turn muting off. " +
    "If the command is unclear, ambiguous, or destructive (e.g. delete/remove/send), use \"unknown\" and ask a brief clarifying question instead of guessing. " +
    "Respond ONLY with valid JSON, no fences, no preamble.";
  const user = `Allowed actions: ${ASSISTANT_ACTIONS.join(", ")}

Command: "${text}"

Return JSON with exactly these keys (omit any not relevant to the chosen action):
{"action":"one of the allowed actions","message":"short friendly confirmation phrased as already done, or a brief clarifying question if action is unknown","query":"search text, for action=search only","type":"sender|domain|keyword, for action=add_rule only","value":"for action=add_rule only","level":"high|low, for action=add_rule only","name":"for action=add_category|create_folder|add_template|add_business","fields":["field names, for action=create_folder only"],"content":"for action=add_template only","domain":"the business's email domain e.g. acme.com, for action=add_business only","on":"true|false, for action=mute only","start":"0-23, for action=mute only when on=true","end":"0-23, for action=mute only when on=true"}`;
  const raw = await callClaude(sys, user, 300);
  const p = parseJSONSafe(raw);
  if (!p || !ASSISTANT_ACTIONS.includes(p.action)) {
    return { action: "unknown", message: "I didn't catch that — could you rephrase?" };
  }
  return p;
}
