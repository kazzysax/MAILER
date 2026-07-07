import { DatabaseSync } from "node:sqlite";
import path from "path";

const db = new DatabaseSync(path.resolve("mailer.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- connected inbox (encrypted password)
  mail_user TEXT, mail_pass_enc TEXT,
  imap_host TEXT, imap_port INTEGER, smtp_host TEXT, smtp_port INTEGER,
  -- channels
  telegram_chat_id TEXT,
  whatsapp_number TEXT,
  -- state
  last_digest_day TEXT
);
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL, value TEXT NOT NULL, level TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  uid INTEGER,
  from_text TEXT, from_addr TEXT, subject TEXT, body TEXT,
  attachments TEXT, message_id TEXT, received_at INTEGER,
  priority TEXT, summary TEXT, action TEXT,
  status TEXT DEFAULT 'new',
  snoozed_until INTEGER,
  sent_reply TEXT
);
CREATE TABLE IF NOT EXISTS seen_uids (
  user_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  PRIMARY KEY (user_id, uid)
);
CREATE TABLE IF NOT EXISTS awaiting_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  counterparty TEXT NOT NULL,
  subject TEXT,
  sent_at INTEGER NOT NULL,
  nudged INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_members (
  owner_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  PRIMARY KEY (owner_id, member_id)
);
CREATE TABLE IF NOT EXISTS used_payments (
  tx_hash TEXT PRIMARY KEY,
  service TEXT,
  amount REAL,
  payer TEXT,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, status);
`);

/* schema upgrades for existing databases (no-ops on fresh ones) */
for (const sql of [
  "ALTER TABLE users ADD COLUMN mute_start INTEGER",
  "ALTER TABLE users ADD COLUMN mute_end INTEGER",
  "ALTER TABLE emails ADD COLUMN pending_push INTEGER DEFAULT 0",
  "ALTER TABLE emails ADD COLUMN claimed_by INTEGER",
  "ALTER TABLE emails ADD COLUMN scam_risk REAL",
  "ALTER TABLE emails ADD COLUMN scam_reasons TEXT",
]) {
  try { db.exec(sql); } catch {}
}

/* ---------- users ---------- */
export const createUser = (email, passHash) =>
  db.prepare("INSERT INTO users (email, pass_hash, created_at) VALUES (?,?,?)").run(email, passHash, Date.now());
export const userByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
export const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
export const userByChat = (chatId) => db.prepare("SELECT * FROM users WHERE telegram_chat_id = ?").get(String(chatId));
export const userByWhatsApp = (num) => db.prepare("SELECT * FROM users WHERE whatsapp_number = ?").get(num);
export const usersWithInbox = () =>
  db.prepare("SELECT * FROM users WHERE mail_user IS NOT NULL AND mail_pass_enc IS NOT NULL").all();

export const setInbox = (userId, mailUser, passEnc, imapHost, imapPort, smtpHost, smtpPort) =>
  db.prepare("UPDATE users SET mail_user=?, mail_pass_enc=?, imap_host=?, imap_port=?, smtp_host=?, smtp_port=? WHERE id=?")
    .run(mailUser, passEnc, imapHost, imapPort, smtpHost, smtpPort, userId);
export const disconnectInbox = (userId) =>
  db.prepare("UPDATE users SET mail_user=NULL, mail_pass_enc=NULL WHERE id=?").run(userId);
export const setTelegramChat = (userId, chatId) =>
  db.prepare("UPDATE users SET telegram_chat_id=? WHERE id=?").run(String(chatId), userId);
export const setWhatsApp = (userId, num) =>
  db.prepare("UPDATE users SET whatsapp_number=? WHERE id=?").run(num, userId);
export const setDigestDay = (userId, day) =>
  db.prepare("UPDATE users SET last_digest_day=? WHERE id=?").run(day, userId);
export const setMuteHours = (userId, start, end) =>
  db.prepare("UPDATE users SET mute_start=?, mute_end=? WHERE id=?").run(start, end, userId);

/* ---------- team ---------- */
export const teamAdd = (ownerId, memberId) =>
  db.prepare("INSERT OR IGNORE INTO team_members (owner_id, member_id) VALUES (?,?)").run(ownerId, memberId);
export const teamRemove = (ownerId, memberId) =>
  db.prepare("DELETE FROM team_members WHERE owner_id=? AND member_id=?").run(ownerId, memberId);
export const teamMembers = (ownerId) =>
  db.prepare("SELECT u.* FROM team_members t JOIN users u ON u.id=t.member_id WHERE t.owner_id=?").all(ownerId);
export const isTeamMember = (ownerId, memberId) =>
  !!db.prepare("SELECT 1 FROM team_members WHERE owner_id=? AND member_id=?").get(ownerId, memberId);

/* ---------- awaiting replies (silence catcher) ---------- */
export const addAwaiting = (userId, counterparty, subject) =>
  db.prepare("INSERT INTO awaiting_replies (user_id, counterparty, subject, sent_at) VALUES (?,?,?,?)")
    .run(userId, counterparty.toLowerCase(), subject, Date.now());
export const clearAwaiting = (userId, counterparty) =>
  db.prepare("DELETE FROM awaiting_replies WHERE user_id=? AND counterparty=?").run(userId, (counterparty || "").toLowerCase());
export const dueAwaiting = (days) =>
  db.prepare("SELECT * FROM awaiting_replies WHERE nudged=0 AND sent_at <= ?").all(Date.now() - days * 24 * 3600 * 1000);
export const awaitingById = (id) => db.prepare("SELECT * FROM awaiting_replies WHERE id=?").get(id);
export const markNudged = (id) => db.prepare("UPDATE awaiting_replies SET nudged=1 WHERE id=?").run(id);
export const dismissAwaiting = (id) => db.prepare("DELETE FROM awaiting_replies WHERE id=?").run(id);

/* ---------- link codes (magic links) ---------- */
export const createLinkCode = (code, userId) =>
  db.prepare("INSERT OR REPLACE INTO link_codes (code, user_id, created_at) VALUES (?,?,?)").run(code, userId, Date.now());
export const consumeLinkCode = (code) => {
  const row = db.prepare("SELECT * FROM link_codes WHERE code = ?").get(code);
  if (!row) return null;
  if (Date.now() - row.created_at > 30 * 60 * 1000) return null; // 30-min expiry
  db.prepare("DELETE FROM link_codes WHERE code = ?").run(code);
  return row.user_id;
};

/* ---------- rules ---------- */
export const rulesFor = (userId) => db.prepare("SELECT * FROM rules WHERE user_id = ?").all(userId);
export const addRule = (userId, type, value, level) =>
  db.prepare("INSERT INTO rules (user_id, type, value, level) VALUES (?,?,?,?)").run(userId, type, value, level);
export const delRule = (userId, id) => db.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").run(id, userId);

/* ---------- templates ---------- */
export const templatesFor = (userId) => db.prepare("SELECT * FROM templates WHERE user_id = ?").all(userId);
export const templateById = (userId, id) =>
  db.prepare("SELECT * FROM templates WHERE id = ? AND user_id = ?").get(id, userId);
export const addTemplate = (userId, name, content) =>
  db.prepare("INSERT INTO templates (user_id, name, content) VALUES (?,?,?)").run(userId, name, content);
export const delTemplate = (userId, id) => db.prepare("DELETE FROM templates WHERE id = ? AND user_id = ?").run(id, userId);

/* ---------- emails ---------- */
export const insertEmail = (e) =>
  db.prepare(`INSERT INTO emails (id, user_id, uid, from_text, from_addr, subject, body, attachments, message_id, received_at, priority, summary, action, status, snoozed_until, sent_reply)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(e.id, e.userId, e.uid ?? null, e.from ?? null, e.fromAddr ?? null, e.subject ?? null, e.body ?? null,
         JSON.stringify(e.attachments || []), e.messageId ?? null, e.receivedAt ?? Date.now(),
         e.priority ?? null, e.summary ?? null, e.action ?? null, e.status || "new",
         e.snoozedUntil ?? null, e.sentReply ?? null);

export const emailById = (id) => hydrate(db.prepare("SELECT * FROM emails WHERE id = ?").get(id));
export const openEmailsFor = (userId) =>
  db.prepare("SELECT * FROM emails WHERE user_id = ? AND status != 'done' AND (snoozed_until IS NULL OR snoozed_until <= ?)")
    .all(userId, Date.now()).map(hydrate);
export const dueSnoozed = () =>
  db.prepare("SELECT * FROM emails WHERE status != 'done' AND snoozed_until IS NOT NULL AND snoozed_until <= ?")
    .all(Date.now()).map(hydrate);
export const updateEmail = (id, fields) => {
  const map = { status: "status", snoozedUntil: "snoozed_until", sentReply: "sent_reply", summary: "summary", action: "action", priority: "priority", scamRisk: "scam_risk", scamReasons: "scam_reasons" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE emails SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
};
export const recentEmailsFor = (userId, limit = 50) =>
  db.prepare("SELECT * FROM emails WHERE user_id = ? ORDER BY received_at DESC LIMIT ?").all(userId, limit).map(hydrate);

export const knownSendersFor = (userId) => {
  const rows = db.prepare("SELECT DISTINCT from_addr FROM emails WHERE user_id=? AND sent_reply IS NOT NULL").all(userId);
  return new Set(rows.map((r) => (r.from_addr || "").toLowerCase()).filter(Boolean));
};

export const searchEmails = (userId, q, limit = 5) =>
  db.prepare(`SELECT * FROM emails WHERE user_id = ? AND (subject LIKE ? OR body LIKE ? OR from_text LIKE ?)
              ORDER BY received_at DESC LIMIT ?`)
    .all(userId, `%${q}%`, `%${q}%`, `%${q}%`, limit).map(hydrate);

export const setPendingPush = (id, v) => db.prepare("UPDATE emails SET pending_push=? WHERE id=?").run(v ? 1 : 0, id);
export const pendingPushFor = (userId) =>
  db.prepare("SELECT * FROM emails WHERE user_id=? AND pending_push=1 AND status != 'done'").all(userId).map(hydrate);
export const setClaimedBy = (id, memberId) => db.prepare("UPDATE emails SET claimed_by=? WHERE id=?").run(memberId, id);
export const claimedBy = (id) => db.prepare("SELECT claimed_by FROM emails WHERE id=?").get(id)?.claimed_by || null;

export const weeklyStats = (userId) => {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const total = db.prepare("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=?").get(userId, weekAgo).c;
  const high = db.prepare("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND priority='high'").get(userId, weekAgo).c;
  const done = db.prepare("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND status='done'").get(userId, weekAgo).c;
  const replies = db.prepare("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND sent_reply IS NOT NULL").get(userId, weekAgo).c;
  const topSenders = db.prepare("SELECT from_text f, COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? GROUP BY from_addr ORDER BY c DESC LIMIT 3").all(userId, weekAgo);
  const open = db.prepare("SELECT COUNT(*) c FROM emails WHERE user_id=? AND status != 'done'").get(userId).c;
  return { total, high, done, replies, topSenders, open };
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, uid: row.uid,
    from: row.from_text, fromAddr: row.from_addr, subject: row.subject, body: row.body,
    attachments: JSON.parse(row.attachments || "[]"),
    messageId: row.message_id, receivedAt: row.received_at,
    priority: row.priority, summary: row.summary, action: row.action,
    status: row.status, snoozedUntil: row.snoozed_until, sentReply: row.sent_reply,
    pendingPush: row.pending_push, claimedBy: row.claimed_by,
  };
}

export const userByAnyEmail = (addr) => {
  const a = (addr || "").toLowerCase();
  return db.prepare("SELECT * FROM users WHERE email = ? OR mail_user = ?").get(a, a);
};

/* ---------- mainnet payment replay guard ---------- */
export const isTxUsed = (txHash) => !!db.prepare("SELECT 1 FROM used_payments WHERE tx_hash = ?").get(txHash);
export const markTxUsed = (txHash, service, amount, payer) =>
  db.prepare("INSERT INTO used_payments (tx_hash, service, amount, payer, used_at) VALUES (?,?,?,?,?)")
    .run(txHash, service, amount, payer, Date.now());

/* ---------- seen uids ---------- */
export const isSeen = (userId, uid) => !!db.prepare("SELECT 1 FROM seen_uids WHERE user_id = ? AND uid = ?").get(userId, uid);
export const markSeen = (userId, uid) =>
  db.prepare("INSERT OR IGNORE INTO seen_uids (user_id, uid) VALUES (?,?)").run(userId, uid);
