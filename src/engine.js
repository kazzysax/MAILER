import * as db from "./db.js";
import { computePriority } from "./rules.js";
import { analyzeEmail, draftReply, fillTemplate, dailyRoundup } from "./ai.js";
import { sendReplyFor } from "./mailer.js";
import { config } from "./config.js";
import { maybeScamCheck } from "./scamcheck.js";

const PRIORITY_ICON = { high: "🔴", normal: "🟢", low: "⚪" };

// per-user conversation state
// userId -> null | {mode:'awaiting_instruction'|'awaiting_approval'|'tpl_name'|'tpl_body', emailId?, draft?, name?, nudge?, awaitingId?}
const convos = new Map();

// channel senders registered at boot: { telegram: fn(chatId,text,options), whatsapp: fn(number,text,options) }
const senders = {};
export function registerSender(name, fn) {
  senders[name] = fn;
}

export async function sendToUser(user, text, options) {
  // WhatsApp first — it's MAILER's primary channel
  if (user.whatsapp_number && senders.whatsapp) {
    return senders.whatsapp(user.whatsapp_number, text, options);
  }
  if (user.telegram_chat_id && senders.telegram) {
    return senders.telegram(user.telegram_chat_id, text, options);
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
async function fanOut(owner, text, options) {
  for (const r of await recipientsFor(owner)) await sendToUser(r, text, options);
}

/* ---------- formatting ---------- */
function emailCard(e) {
  const p = e.priority || "normal";
  let text = `${PRIORITY_ICON[p]} ${p.toUpperCase()} — ${e.from}\n📧 ${e.subject}\n\n${e.summary || (e.body || "").slice(0, 200)}`;
  if (e.highlights?.length) text += `\n\n📌 ${e.highlights.join(" · ")}`;
  if (e.action) text += `\n\n➡️ Action: ${e.action}`;
  if (e.attachments?.length) text += `\n📎 ${e.attachments.join(", ")}`;
  if (e.scam && e.scam.risk >= 0.5) {
    text += `\n\n⚠️ POSSIBLE SCAM (risk ${Math.round(e.scam.risk * 100)}%) — ${(e.scam.reasons || [])[0] || "flagged by security agent"}. MAILER had a security agent check this sender. Verify before acting.`;
  }
  return text;
}
function emailButtons(e, hasTeam = false) {
  const b = [
    { label: "✍️ Draft reply", action: `d:${e.id}` },
    { label: "📋 Fill template", action: `t:${e.id}` },
    { label: "✅ Done", action: `ok:${e.id}` },
    { label: "⏰ 1h", action: `s1:${e.id}` },
    { label: "⏰ Tmrw 9am", action: `st:${e.id}` },
    { label: "⏰ 3 days", action: `s3:${e.id}` },
    { label: "🚫 Blacklist sender", action: `bl:${e.id}` },
  ];
  if (hasTeam) b.unshift({ label: "🙋 Claim", action: `cl:${e.id}` });
  return b;
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
  await fanOut(user, emailCard(email), emailButtons(email, hasTeam));
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
      await fanOut(user, emailCard(e), emailButtons(e, hasTeam));
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
    `📊 MAILER weekly report\n\nEmails processed: ${s.total} (${s.high} high priority)\nHandled: ${s.done} · Replies sent: ${s.replies}\nStill open: ${s.open}\n\nBusiest senders:\n${top}\n\nNothing got left out. 💪`);
}

/* ---------- roundup ---------- */
export async function sendRoundupFor(user) {
  const open = await db.openEmailsFor(user.id);
  try {
    const text = await dailyRoundup(open);
    await sendToUser(user, `☀️ MAILER morning digest\n\n${text}`);
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
    if (user) await sendToUser(user, `⏰ Back from snooze:\n\n${emailCard(e)}`, emailButtons(e));
  }
}

/* ---------- text handler (per user) ---------- */
const HELP = `MAILER — never miss an email.

/roundup — digest of everything open
/open — re-push open emails
/find <words> — search your emails
/mute 21 7 — quiet hours (9pm–7am) · /mute off
/report — your weekly numbers
/rules — list rules · /addrule keyword invoice high · /delrule <id>
/templates — list · /addtemplate — add one
/team add <email> · /team remove <email> · /team list
/cancel — cancel current flow

You approve every reply before it sends.`;

export async function onText(user, text) {
  const convo = convos.get(user.id) || null;

  if (convo?.mode === "awaiting_instruction" && !text.startsWith("/")) {
    const email = await db.emailById(convo.emailId);
    if (!email) { convos.delete(user.id); return sendToUser(user, "That email is gone."); }
    await sendToUser(user, "✍️ Drafting…");
    try {
      const draft = await draftReply(email, text);
      convos.set(user.id, { mode: "awaiting_approval", emailId: email.id, draft });
      return sendToUser(user, `Draft reply to ${email.from}:\n\n${draft}`, [
        { label: "✅ Approve & send", action: "approve" },
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
      return sendToUser(user, `✅ MAILER is connected.\n\n${HELP}`);
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
      for (const e of hits) await sendToUser(user, emailCard(e), emailButtons(e, hasTeam));
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
        return sendToUser(user, m.length ? "Your team:\n" + m.map((x) => `• ${x.email}`).join("\n") : "No team members yet. /team add <their MAILER email>");
      }
      if (sub === "add" || sub === "remove") {
        const addr = (rest[1] || "").toLowerCase();
        const target = await db.userByEmail(addr);
        if (!target) return sendToUser(user, `No MAILER account for ${addr || "(missing email)"} — they need to sign up first.`);
        if (target.id === user.id) return sendToUser(user, "That's you.");
        if (sub === "add") {
          await db.teamAdd(user.id, target.id);
          await sendToUser(target, `👥 ${user.email} added you to their MAILER team — you'll now receive their inbox pushes and can claim emails.`);
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
      for (const e of open.slice(0, 10)) await sendToUser(user, emailCard(e), emailButtons(e));
      return;
    }
    default:
      if (text.startsWith("/")) return sendToUser(user, "Unknown command. /help");
      return sendToUser(user, "Tap a button on an email, or /help.");
  }
}

/* ---------- action handler (per user) ---------- */
export async function onAction(user, action) {
  if (action === "approve") {
    const convo = convos.get(user.id);
    if (convo?.mode !== "awaiting_approval") return sendToUser(user, "No draft waiting for approval.");
    const draft = convo.draft;
    convos.delete(user.id);

    // nudge approval: fresh follow-up email, not a threaded reply
    if (convo.nudge) {
      const owner = await db.userById(convo.nudge.userId);
      if (!owner) return sendToUser(user, "Account not found.");
      try {
        await sendReplyFor(owner, { fromAddr: convo.nudge.counterparty, subject: convo.nudge.subject, messageId: null }, draft);
        await db.addAwaiting(owner.id, convo.nudge.counterparty, convo.nudge.subject); // keep watching for their answer
        return sendToUser(user, `📤 Nudge sent to ${convo.nudge.counterparty}.`);
      } catch (err) {
        return sendToUser(user, "Send failed: " + err.message);
      }
    }

    const email = await db.emailById(convo.emailId);
    if (!email) return sendToUser(user, "That email is gone.");
    const owner = await db.userById(email.userId); // replies always go out from the inbox owner's address
    try {
      await sendReplyFor(owner, email, draft);
      await db.updateEmail(email.id, { sentReply: draft, status: "done" });
      await db.addAwaiting(owner.id, email.fromAddr || email.from, email.subject); // silence catcher starts watching
      return sendToUser(user, `📤 Sent to ${email.fromAddr || email.from} and marked done.`);
    } catch (err) {
      return sendToUser(user, "Send failed: " + err.message);
    }
  }
  if (action === "discard") {
    convos.delete(user.id);
    return sendToUser(user, "Draft discarded.");
  }

  const [code, id, extra] = action.split(":");

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
        { label: "✅ Approve & send", action: "approve" },
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
      convos.set(user.id, { mode: "awaiting_instruction", emailId: id });
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
          { label: "✅ Approve & send", action: "approve" },
          { label: "🗑 Discard", action: "discard" },
        ]);
      } catch (err) {
        return sendToUser(user, "Template fill failed: " + err.message);
      }
    }
    case "ok":
      await db.updateEmail(id, { status: "done" });
      return sendToUser(user, `✅ Done: "${email.subject}"`);
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
      await db.addBlacklist(owner.id, email.fromAddr.toLowerCase());
      return sendToUser(user, `🚫 Blacklisted ${email.fromAddr} — future mail from this exact address won't reach you (still logged on the dashboard, never fully lost). Manage your list anytime from the dashboard.`);
    }
    default:
      return sendToUser(user, "Unknown action.");
  }
}
