import * as db from "./db.js";
import { computePriority } from "./rules.js";
import { analyzeEmail, draftReply, fillTemplate, dailyRoundup, interpretCommand } from "./ai.js";
import { fetchNewEmailsFor } from "./mailer.js";
import { config } from "./config.js";
import { maybeScamCheck } from "./scamcheck.js";
import { submitLog, explorerTxUrl } from "./chain.js";

const PRIORITY_ICON = { high: "🔴", normal: "🟢", low: "⚪" };

// who a drafted reply is going to — same options as the dashboard's relation-picker
// pills (public/dashboard.html), matching ai.js's RELATIONSHIP_GUIDANCE codes
const RELATIONS = [
  { code: "exec", label: "CEO/Exec" },
  { code: "jobapp", label: "Job App" },
  { code: "care", label: "Customer Care" },
  { code: "client", label: "Client/Partner" },
  { code: "colleague", label: "Colleague" },
  { code: "family", label: "Family" },
  { code: "friend", label: "Friend" },
  { code: "other", label: "Other" },
];

// per-user conversation state
// userId -> null | {mode:'awaiting_instruction'|'awaiting_approval'|'tpl_name'|'tpl_body', emailId?, draft?, name?, nudge?, awaitingId?, relationship?}
const convos = new Map();

// channel senders registered at boot: { telegram: fn(chatId,text,options), whatsapp: fn(number,text,options) }
const senders = {};
export function registerSender(name, fn) {
  senders[name] = fn;
}

// html=true only for messages built with escapeHtml()+real <b> tags (emailCard) —
// every other message here is plain text, and turning on HTML parsing for those too
// would break delivery the moment a real subject/name contains a bare "&" or "<".
export async function sendToUser(user, text, options, html = false) {
  // WhatsApp first — it's Mailer's primary channel
  if (user.whatsapp_number && senders.whatsapp) {
    return senders.whatsapp(user.whatsapp_number, text, options);
  }
  if (user.telegram_chat_id && senders.telegram) {
    return senders.telegram(user.telegram_chat_id, text, options, html);
  }
  // no channel bound yet — email stays in dashboard; nothing lost
}

/* ---------- mute hours ---------- */
function isMuted(user) {
  if (user.mute_start == null || user.mute_end == null) return false;
  const h = new Date().getHours();
  const s = user.mute_start, e = user.mute_end;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e; // handles overnight wrap (e.g. 21 → 7)
}

/* ---------- team fan-out ---------- */
async function recipientsFor(owner) {
  const members = await db.teamMembers(owner.id);
  return [owner, ...members];
}
async function fanOut(owner, text, options, html = false) {
  for (const r of await recipientsFor(owner)) await sendToUser(r, text, options, html);
}

/* ---------- formatting ---------- */
// escapes text for Telegram's HTML parse mode — required for every dynamic value
// (email subject/sender/etc.) that goes into a card built with real <b> tags below.
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function emailCard(e) {
  const p = e.priority || "normal";
  let text = `${PRIORITY_ICON[p]} ${p.toUpperCase()} — <b>${escapeHtml(e.from)}</b>\n📧 <b>${escapeHtml(e.subject)}</b>\n\n${escapeHtml(e.summary || (e.body || "").slice(0, 200))}`;
  if (e.highlights?.length) text += `\n\n📌 ${escapeHtml(e.highlights.join(" · "))}`;
  if (e.action) {
    text += `\n\n➡️ Action: ${escapeHtml(e.action)}`;
    if (e.actionLink) text += ` — <a href="${escapeHtml(e.actionLink)}">open link ↗</a>`;
  }
  if (e.attachments?.length) text += `\n📎 ${escapeHtml(e.attachments.join(", "))}`;
  if (e.scam && e.scam.risk >= 0.5) {
    text += `\n\n⚠️ <b>POSSIBLE SCAM</b> (risk ${Math.round(e.scam.risk * 100)}%) — ${escapeHtml((e.scam.reasons || [])[0] || "flagged by security agent")}. Mailer had a security agent check this sender. Verify before acting.`;
  }
  return text;
}
function emailButtons(e, hasTeam = false) {
  const b = [
    { label: "✍️ Draft reply", action: `d:${e.id}` },
    { label: "📋 Fill template", action: `t:${e.id}` },
    { label: "✅ Done", action: `ok:${e.id}` },
    { label: "⏰ Snooze", action: `sn:${e.id}` },
    { label: "🚫 Blacklist sender", action: `bl:${e.id}` },
  ];
  if (hasTeam) b.unshift({ label: "🙋 Claim", action: `cl:${e.id}` });
  return b;
}
function snoozeButtons(e) {
  return [
    { label: "⏰ 1h", action: `s1:${e.id}` },
    { label: "⏰ Tmrw 9am", action: `st:${e.id}` },
    { label: "⏰ 3 days", action: `s3:${e.id}` },
    { label: "« Back", action: `snb:${e.id}` },
  ];
}

/* ---------- clamp the AI's category guess to the user's actual list ---------- */
function pickCategory(guess, categoryNames) {
  if (!categoryNames.length) return null;
  const match = categoryNames.find((c) => c.toLowerCase() === (guess || "").toLowerCase());
  if (match) return match;
  return categoryNames.includes("Other") ? "Other" : categoryNames[0];
}

/* ---------- process a newly fetched email for a user ---------- */
export async function processIncoming(user, email) {
  const blocked = email.fromAddr ? await db.isBlacklisted(user.id, email.fromAddr) : false;
  email.blocked = blocked;
  const categories = await db.categoriesFor(user.id);
  const categoryNames = categories.map((c) => c.name);

  if (blocked) {
    // still fully tracked (no mail left behind) — just never analyzed or pushed
    email.priority = "low";
    email.summary = "🚫 Blacklisted sender — auto-filtered, not pushed.";
    email.highlights = [];
    email.category = categoryNames.includes("Other") ? "Other" : categoryNames[0] || null;
    await db.insertEmail(email);
    if (email.fromAddr) await db.clearAwaiting(user.id, email.fromAddr);
    return;
  }

  const rules = await db.rulesFor(user.id);
  const pr = computePriority(email, rules);
  email.priority = pr.level;
  try {
    const a = await analyzeEmail(email, categoryNames);
    email.summary = a.summary;
    email.action = a.action;
    email.actionLink = a.actionLink;
    email.highlights = a.highlights;
    email.category = pickCategory(a.category, categoryNames);
  } catch (err) {
    console.error("Analyze failed:", err.message);
    email.summary = (email.body || "").slice(0, 200);
    email.highlights = [];
    email.category = categoryNames.includes("Other") ? "Other" : categoryNames[0] || null;
  }
  await db.insertEmail(email);

  // scam-risk scoring for suspicious mail (never blocks — flags only)
  try {
    const known = await db.knownSendersFor(user.id);
    const businesses = await db.businessesFor(user.id);
    const trustedDomains = new Set(businesses.map((b) => b.domain.toLowerCase()));
    const scam = await maybeScamCheck(email, known, trustedDomains);
    if (scam) {
      email.scam = scam;
      await db.updateEmail(email.id, { scamRisk: scam.risk, scamReasons: JSON.stringify(scam.reasons) });
      // system-detected, no button click to gate it on — log automatically, no approval prompt
      const logId = await db.createChainLog(user.id, email.id, "flagged", "submitting");
      submitLog(logId, { userId: user.id, emailId: email.id, eventType: "flagged", onBehalfOfAddress: user.wallet_address || null });
    }
  } catch (e) {
    console.error("scam-check error:", e.message);
  }

  // silence catcher: they replied — stop waiting on them
  if (email.fromAddr) await db.clearAwaiting(user.id, email.fromAddr);

  const shouldPush = pr.level === "high" || (pr.level === "normal" && config.pushNormal);
  if (!shouldPush) return; // low priority waits for the roundup — nothing gets left out

  if (isMuted(user)) {
    await db.setPendingPush(email.id, true); // queued for the "while you were away" batch
    return;
  }
  const hasTeam = (await db.teamMembers(user.id)).length > 0;
  await fanOut(user, emailCard(email), emailButtons(email, hasTeam), true);
}

/* ---------- flush queued pushes when mute ends ---------- */
export async function flushPending() {
  for (const user of await db.usersWithInbox()) {
    if (isMuted(user)) continue;
    const pending = await db.pendingPushFor(user.id);
    if (!pending.length) continue;
    const hasTeam = (await db.teamMembers(user.id)).length > 0;
    await sendToUser(user, `🌙 While you were away — ${pending.length} email${pending.length > 1 ? "s" : ""} came in:`);
    for (const e of pending) {
      await db.setPendingPush(e.id, false);
      await fanOut(user, emailCard(e), emailButtons(e, hasTeam), true);
    }
  }
}

/* ---------- silence catcher: nudge threads gone quiet ---------- */
export async function checkSilence() {
  for (const a of await db.dueAwaiting(config.nudgeDays)) {
    const user = await db.userById(a.user_id);
    if (!user) { await db.dismissAwaiting(a.id); continue; }
    await db.markNudged(a.id);
    const days = Math.round((Date.now() - a.sent_at) / (24 * 3600 * 1000));
    await sendToUser(user, `🔕 Still silent: you replied to ${a.counterparty} about "${a.subject}" ${days} day${days > 1 ? "s" : ""} ago — no answer yet.`, [
      { label: "✍️ Draft a nudge", action: `ng:${a.id}` },
      { label: "🗑 Dismiss", action: `nd:${a.id}` },
    ]);
  }
}

/* ---------- weekly report ---------- */
export async function sendWeeklyReport(user) {
  const s = await db.weeklyStats(user.id);
  const top = s.topSenders.map((t, i) => `${i + 1}. ${t.f} (${t.c})`).join("\n") || "—";
  await sendToUser(user,
    `📊 Mailer weekly report\n\nEmails processed: ${s.total} (${s.high} high priority)\nHandled: ${s.done} · Replies sent: ${s.replies}\nStill open: ${s.open}\n\nBusiest senders:\n${top}\n\nNothing got left out. 💪`);
}

/* ---------- roundup ---------- */
export async function sendRoundupFor(user) {
  const open = await db.openEmailsFor(user.id);
  try {
    const text = await dailyRoundup(open);
    await sendToUser(user, `☀️ Mailer morning digest\n\n${text}`);
  } catch (err) {
    console.error("Roundup failed:", err.message);
    await sendToUser(user, "Roundup failed — send /roundup to retry.");
  }
}

/* ---------- snooze wakeups (all users) ---------- */
export async function wakeSnoozed() {
  for (const e of await db.dueSnoozed()) {
    await db.updateEmail(e.id, { snoozedUntil: null });
    const user = await db.userById(e.userId);
    if (user) await sendToUser(user, `⏰ Back from snooze:\n\n${emailCard(e)}`, emailButtons(e), true);
  }
}

/* ---------- text handler (per user) ---------- */
const HELP = `Mailer — never miss an email.

/roundup — digest of everything open
/open — re-push open emails
/find <words> — search your emails
/mute 21 7 — quiet hours (9pm–7am) · /mute off
/report — your weekly numbers
/rules — list rules · /addrule keyword invoice high · /delrule <id>
/templates — list · /addtemplate — add one
/team add <email> · /team remove <email> · /team list
/cancel — cancel current flow

Or just type what you want — "show me what's open", "mute me till 8am",
"add a rule for invoices as high priority" — no need to remember the exact command.

You approve every reply before it sends.`;

export async function onText(user, text) {
  const convo = convos.get(user.id) || null;

  if (convo?.mode === "awaiting_instruction" && !text.startsWith("/")) {
    const email = await db.emailById(convo.emailId);
    if (!email) { convos.delete(user.id); return sendToUser(user, "That email is gone."); }
    await sendToUser(user, "✍️ Drafting…");
    try {
      const draft = await draftReply(email, text, convo.relationship);
      convos.set(user.id, { mode: "awaiting_approval", emailId: email.id, draft });
      return sendToUser(user, `Draft reply to ${email.from}:\n\n${draft}`, [
        { label: "✅ Approve", action: "approve" },
        { label: "🔁 Redo", action: `d:${email.id}` },
        { label: "🗑 Discard", action: "discard" },
      ]);
    } catch (err) {
      convos.delete(user.id);
      return sendToUser(user, "Drafting failed: " + err.message);
    }
  }
  if (convo?.mode === "tpl_name" && !text.startsWith("/")) {
    convos.set(user.id, { mode: "tpl_body", name: text.slice(0, 60) });
    return sendToUser(user, `Template "${text.slice(0, 60)}". Now send the body — use placeholders like [client name], [amount], [date].`);
  }
  if (convo?.mode === "tpl_body" && !text.startsWith("/")) {
    await db.addTemplate(user.id, convo.name, text);
    convos.delete(user.id);
    return sendToUser(user, `✅ Template "${convo.name}" saved.`);
  }
  if (text.startsWith("/")) convos.delete(user.id);

  const [cmd, ...rest] = text.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/start":
      return sendToUser(user, `✅ Mailer is connected.\n\n${HELP}`);
    case "/help":
      return sendToUser(user, HELP);
    case "/cancel":
      convos.delete(user.id);
      return sendToUser(user, "Cancelled.");
    case "/roundup":
      return sendRoundupFor(user);
    case "/rules": {
      const rules = await db.rulesFor(user.id);
      if (!rules.length) return sendToUser(user, "No rules yet. Add one:\n/addrule keyword invoice high");
      return sendToUser(user, "Priority rules:\n" + rules.map((r) => `#${r.id} [${r.level.toUpperCase()}] ${r.type} contains "${r.value}"`).join("\n") + "\n\nRemove with /delrule <id>");
    }
    case "/addrule": {
      const [type, ...vp] = rest;
      const level = vp.pop();
      const value = vp.join(" ");
      if (!["sender", "domain", "keyword"].includes(type) || !["high", "low"].includes(level) || !value) {
        return sendToUser(user, "Format: /addrule <sender|domain|keyword> <value> <high|low>");
      }
      await db.addRule(user.id, type, value, level);
      return sendToUser(user, `✅ Rule added: ${type} "${value}" → ${level.toUpperCase()}`);
    }
    case "/delrule": {
      const id = Number(rest[0]);
      if (!id) return sendToUser(user, "Give the rule id from /rules.");
      await db.delRule(user.id, id);
      return sendToUser(user, "Removed (if it was yours).");
    }
    case "/templates": {
      const t = await db.templatesFor(user.id);
      if (!t.length) return sendToUser(user, "No templates yet. /addtemplate");
      return sendToUser(user, "Templates:\n" + t.map((x) => `#${x.id} ${x.name}`).join("\n"));
    }
    case "/addtemplate":
      convos.set(user.id, { mode: "tpl_name" });
      return sendToUser(user, "Name for this template?");
    case "/find": {
      const q = rest.join(" ").trim();
      if (!q) return sendToUser(user, "What should I search for? e.g. /find acme invoice");
      const hits = await db.searchEmails(user.id, q);
      if (!hits.length) return sendToUser(user, `Nothing found for "${q}".`);
      const hasTeam = (await db.teamMembers(user.id)).length > 0;
      for (const e of hits) await sendToUser(user, emailCard(e), emailButtons(e, hasTeam), true);
      return;
    }
    case "/mute": {
      if ((rest[0] || "").toLowerCase() === "off") {
        await db.setMuteHours(user.id, null, null);
        return sendToUser(user, "🔔 Mute hours off — pushes anytime.");
      }
      const s = Number(rest[0]), e = Number(rest[1]);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23 || s === e) {
        return sendToUser(user, "Format: /mute <start hour> <end hour> (0–23), e.g. /mute 21 7 — or /mute off");
      }
      await db.setMuteHours(user.id, s, e);
      return sendToUser(user, `🌙 Muted ${s}:00–${e}:00. Urgent mail queues and arrives as a "while you were away" batch when mute ends. Nothing gets left out.`);
    }
    case "/report":
      return sendWeeklyReport(user);
    case "/team": {
      const sub = (rest[0] || "").toLowerCase();
      if (sub === "list") {
        const m = await db.teamMembers(user.id);
        return sendToUser(user, m.length ? "Your team:\n" + m.map((x) => `• ${x.email}`).join("\n") : "No team members yet. /team add <their Mailer email>");
      }
      if (sub === "add" || sub === "remove") {
        const addr = (rest[1] || "").toLowerCase();
        const target = await db.userByEmail(addr);
        if (!target) return sendToUser(user, `No Mailer account for ${addr || "(missing email)"} — they need to sign up first.`);
        if (target.id === user.id) return sendToUser(user, "That's you.");
        if (sub === "add") {
          await db.teamAdd(user.id, target.id);
          await sendToUser(target, `👥 ${user.email} added you to their Mailer team — you'll now receive their inbox pushes and can claim emails.`);
          return sendToUser(user, `✅ ${addr} added. They'll receive your inbox pushes with a Claim button.`);
        }
        await db.teamRemove(user.id, target.id);
        return sendToUser(user, `Removed ${addr} from your team.`);
      }
      return sendToUser(user, "Usage: /team add <email> · /team remove <email> · /team list");
    }
    case "/open": {
      const open = (await db.openEmailsFor(user.id)).sort((a, b) => (a.priority === "high" ? -1 : 1) - (b.priority === "high" ? -1 : 1));
      if (!open.length) return sendToUser(user, "Inbox clear. Nothing open.");
      for (const e of open.slice(0, 10)) await sendToUser(user, emailCard(e), emailButtons(e), true);
      return;
    }
    default:
      if (text.startsWith("/")) return sendToUser(user, "Unknown command. /help");
      return handleChatMessage(user, text);
  }
}

/* ---------- free-form chat ----------
   Anything typed that isn't a /command or an answer mid-flow lands here. Reuses the
   exact same interpretCommand() brain as the dashboard's "Ask Mailer" widget (src/ai.js)
   instead of a second bespoke prompt, then dispatches into the SAME command handlers
   above wherever one already exists — a "search for X" chat message becomes literally
   /find X under the hood, so behavior always matches typing the command by hand. */
export async function handleChatMessage(user, text) {
  let result;
  try {
    result = await interpretCommand(text);
  } catch (e) {
    return sendToUser(user, "Assistant failed: " + e.message);
  }

  switch (result.action) {
    // view_category/view_tier only make sense where there are persistent tabs to
    // switch (the dashboard) — Telegram's closest equivalent is just showing what's open
    case "view_emails":
    case "view_category":
    case "view_tier":
      return onText(user, "/open");
    case "refresh_inbox": {
      if (!user.mail_user) return sendToUser(user, "Connect your inbox first from the dashboard.");
      try {
        const fresh = await fetchNewEmailsFor(user);
        for (const email of fresh) await processIncoming(user, email);
      } catch (err) {
        return sendToUser(user, "Could not check your inbox: " + err.message);
      }
      return onText(user, "/open");
    }
    case "search":
      return onText(user, "/find " + (result.query || "").trim());
    case "mute":
      return onText(user, result.on === false || result.on === "false" ? "/mute off" : `/mute ${result.start} ${result.end}`);
    case "report":
      return onText(user, "/report");
    case "help":
      return onText(user, "/help");
    case "add_rule":
    case "add_category":
    case "create_folder":
    case "add_template":
    case "add_business": {
      const applied = await applyAssistantAction(user, result);
      return sendToUser(user, applied.message || "Done.");
    }
    default:
      return sendToUser(user, result.message || "Not sure what you mean — try /help.");
  }
}

/* ---------- assistant mutation actions (add_rule/add_category/create_folder/
   add_template/add_business) — shared by the dashboard's POST /assistant (src/api.js)
   and handleChatMessage above, so the logic lives once instead of twice. Returns the
   (possibly corrected) result, e.g. downgraded to "unknown" if the AI's fields didn't
   actually hold up. ---------- */
export async function applyAssistantAction(user, result) {
  try {
    switch (result.action) {
      case "add_rule": {
        const type = result.type, level = result.level, value = String(result.value || "").trim();
        if (["sender", "domain", "keyword"].includes(type) && ["high", "low"].includes(level) && value) {
          await db.addRule(user.id, type, value, level);
        } else {
          return { action: "unknown", message: "I wasn't sure how to set that rule up — try 'mark emails containing invoice as high priority'." };
        }
        break;
      }
      case "add_category": {
        const name = String(result.name || "").trim().slice(0, 30);
        if (name) {
          const existing = await db.categoriesFor(user.id);
          if (!existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
            await db.addCategory(user.id, name);
          }
        } else {
          return { action: "unknown", message: "What should the category be called?" };
        }
        break;
      }
      case "create_folder": {
        const name = String(result.name || "").trim().slice(0, 40);
        const fields = Array.isArray(result.fields)
          ? [...new Set(result.fields.map((f) => String(f || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
          : [];
        if (name && fields.length) {
          await db.createDataTable(user.id, name, fields);
        } else {
          return { action: "unknown", message: "Tell me the folder name and which fields to store, e.g. 'create a folder called Invoices with sender, amount, and due date'." };
        }
        break;
      }
      case "add_template": {
        const name = String(result.name || "").trim().slice(0, 60);
        const content = String(result.content || "").trim();
        if (name && content) {
          await db.addTemplate(user.id, name, content);
        } else {
          return { action: "unknown", message: "Give me a template name and the text to save." };
        }
        break;
      }
      case "add_business": {
        const name = String(result.name || "").trim().slice(0, 40);
        const domain = String(result.domain || "").trim().toLowerCase().replace(/^@/, "").slice(0, 80);
        if (name && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
          const existing = await db.businessesFor(user.id);
          if (!existing.some((b) => b.domain === domain)) await db.addBusiness(user.id, name, domain);
        } else {
          return { action: "unknown", message: "Tell me the business name and its email domain, e.g. 'add a business called Acme at acme.com'." };
        }
        break;
      }
      default:
        break;
    }
    return result;
  } catch (e) {
    return { action: "unknown", message: "Couldn't do that: " + e.message };
  }
}

/* ---------- on-chain log approval (done/blacklist actions) ----------
   Marking an email done, or blocking a sender, only actually takes effect once
   this transaction is confirmed on-chain (see chain.js's applyConfirmedAction) —
   signing isn't optional and there's no "skip"; the action simply doesn't apply
   until it's signed. */
const ACTION_LABEL = { handled: "mark this handled", blocked: "block this sender", flagged: "log this flag" };

export async function approveChainLog(user, logId) {
  const log = await db.chainLogById(Number(logId));
  if (!log) return sendToUser(user, "That on-chain log request is gone.");
  const canAccess = log.userId === user.id || await db.isTeamMember(log.userId, user.id);
  if (!canAccess) return sendToUser(user, "That on-chain log request is gone.");
  if (log.status !== "pending_approval") return sendToUser(user, "That one's already been handled.");
  await db.updateChainLog(log.id, { status: "submitting" });
  const owner = await db.userById(log.userId);
  const hash = await submitLog(log.id, {
    userId: log.userId, emailId: log.emailId, eventType: log.eventType,
    onBehalfOfAddress: owner?.wallet_address || null,
  });
  if (!hash) return sendToUser(user, "Couldn't log that on-chain — chain logging isn't set up yet, or the transaction failed.");
  return sendToUser(user, `📤 Submitted — <a href="${escapeHtml(explorerTxUrl(hash))}">view tx ↗</a>\nThis will take effect once confirmed.`, undefined, true);
}

async function promptChainApproval(user, logId, eventType) {
  return sendToUser(user, `⛓ Sign to ${ACTION_LABEL[eventType] || "log this on-chain"} — this only takes effect once the transaction is confirmed.`, [
    { label: "✅ Approve", action: `capp:${logId}` },
  ]);
}

/* creates the chain_logs row for a done/blacklist action — if the inbox owner has
   granted auto-sign permission (see /wallet/auto-sign), submits immediately with no
   prompt; otherwise asks the acting user to sign/approve. Either way, the actual
   status change (email marked done / sender blacklisted) is applied later, only
   once that transaction is confirmed on-chain — not here. */
async function logChainAction(user, owner, emailId, eventType) {
  const autoSign = !!owner.chain_auto_sign;
  const logId = await db.createChainLog(owner.id, emailId, eventType, autoSign ? "submitting" : "pending_approval");
  if (autoSign) {
    submitLog(logId, { userId: owner.id, emailId, eventType, onBehalfOfAddress: owner.wallet_address || null });
    return logId;
  }
  await promptChainApproval(user, logId, eventType);
  return logId;
}

/* ---------- action handler (per user) ---------- */
export async function onAction(user, action) {
  // Sending is temporarily unavailable — outbound SMTP is blocked on this host and
  // Resend was removed; on hold until the Gmail-send-API path clears Google's app
  // verification. Drafting still works fully — this just hands the draft back as a
  // message instead of attempting sendReplyFor, which would only fail anyway.
  if (action === "approve") {
    const convo = convos.get(user.id);
    if (convo?.mode !== "awaiting_approval") return sendToUser(user, "No draft waiting for approval.");
    const draft = convo.draft;
    convos.delete(user.id);
    return sendToUser(user, `${draft}\n\n⚠️ Sending is temporarily unavailable — awaiting Gmail auth approval. Copy this draft and send it yourself for now.`);
  }
  if (action === "discard") {
    convos.delete(user.id);
    return sendToUser(user, "Draft discarded.");
  }

  const [code, id, extra] = action.split(":");

  /* ----- on-chain log approval (id = chain_logs id, not an email id) ----- */
  if (code === "capp") return approveChainLog(user, id);

  /* ----- silence-catcher nudge buttons (id = awaiting id) ----- */
  if (code === "ng" || code === "nd") {
    const a = await db.awaitingById(Number(id));
    if (!a) return sendToUser(user, "That reminder is gone.");
    if (code === "nd") {
      await db.dismissAwaiting(a.id);
      return sendToUser(user, "Dismissed — I'll stop watching that thread.");
    }
    await sendToUser(user, "✍️ Drafting a follow-up nudge…");
    try {
      const pseudo = { from: a.counterparty, fromAddr: a.counterparty, subject: a.subject, body: "(No reply has been received to the owner's last message on this thread.)" };
      const draft = await draftReply(pseudo, "Write a brief, warm but professional follow-up nudge checking in on my previous email, making it easy for them to respond.");
      convos.set(user.id, { mode: "awaiting_approval", draft, nudge: { userId: a.user_id, counterparty: a.counterparty, subject: a.subject } });
      await db.dismissAwaiting(a.id);
      return sendToUser(user, `Nudge to ${a.counterparty}:\n\n${draft}`, [
        { label: "✅ Approve", action: "approve" },
        { label: "🗑 Discard", action: "discard" },
      ]);
    } catch (err) {
      return sendToUser(user, "Drafting failed: " + err.message);
    }
  }

  const email = await db.emailById(id);
  const canAccess = email && (email.userId === user.id || await db.isTeamMember(email.userId, user.id));
  if (!canAccess) return sendToUser(user, "That email is gone.");
  const owner = await db.userById(email.userId);

  switch (code) {
    case "cl": {
      const existing = await db.claimedBy(email.id);
      if (existing && existing !== user.id) {
        const who = await db.userById(existing);
        return sendToUser(user, `Already claimed by ${who?.email || "a teammate"}.`);
      }
      await db.setClaimedBy(email.id, user.id);
      const note = `🙋 ${user.email} claimed: "${email.subject}"`;
      for (const r of await recipientsFor(owner)) if (r.id !== user.id) await sendToUser(r, note);
      return sendToUser(user, `✅ Yours: "${email.subject}". Draft a reply when ready.`);
    }
    case "d":
      return sendToUser(user, "Who's this reply going to? Picking one helps me match the right tone.", RELATIONS.map((r) => ({ label: r.label, action: `dr:${id}:${r.code}` })));
    case "dr":
      convos.set(user.id, { mode: "awaiting_instruction", emailId: id, relationship: extra });
      return sendToUser(user, `Tell me the reply you want for "${email.subject}".\ne.g. "Polite but firm — payment by Friday".`);
    case "t": {
      const templates = await db.templatesFor(owner.id); // team members use the owner's templates
      if (!templates.length) return sendToUser(user, "No templates yet — /addtemplate or add one on the dashboard.");
      return sendToUser(user, `Pick a template for "${email.subject}":`, templates.map((t) => ({ label: t.name, action: `tf:${id}:${t.id}` })));
    }
    case "tf": {
      const tpl = await db.templateById(owner.id, Number(extra));
      if (!tpl) return sendToUser(user, "Template not found.");
      await sendToUser(user, `📋 Filling "${tpl.name}"…`);
      try {
        const draft = await fillTemplate(email, tpl);
        convos.set(user.id, { mode: "awaiting_approval", emailId: id, draft });
        return sendToUser(user, `Filled template for ${email.from}:\n\n${draft}`, [
          { label: "✅ Approve", action: "approve" },
          { label: "🗑 Discard", action: "discard" },
        ]);
      } catch (err) {
        return sendToUser(user, "Template fill failed: " + err.message);
      }
    }
    case "ok":
      return logChainAction(user, owner, id, "handled");
    case "sn":
      return sendToUser(user, `⏰ Snooze "${email.subject}" for how long?`, snoozeButtons(email));
    case "snb": {
      const hasTeam = (await db.teamMembers(owner.id)).length > 0;
      return sendToUser(user, emailCard(email), emailButtons(email, hasTeam), true);
    }
    case "s1":
    case "st":
    case "s3": {
      let until;
      if (code === "s1") until = Date.now() + 3600 * 1000;
      else if (code === "s3") until = Date.now() + 3 * 24 * 3600 * 1000;
      else {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        until = d.getTime();
      }
      await db.updateEmail(id, { snoozedUntil: until });
      return sendToUser(user, `⏰ Snoozed "${email.subject}" — I'll bring it back. Nothing gets left out.`);
    }
    case "bl": {
      if (!email.fromAddr) return sendToUser(user, "Can't blacklist — no sender address on this email.");
      return logChainAction(user, owner, id, "blocked");
    }
    default:
      return sendToUser(user, "Unknown action.");
  }
}
