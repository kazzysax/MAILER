import "dotenv/config";
import pg from "pg";

// BIGINT columns (our millisecond-epoch timestamps) come back as strings by default,
// since JS numbers can't safely hold all 64-bit values — but epoch-ms fits safely in a
// JS number for thousands of years, so parse them back to numbers to match prior SQLite behavior.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ---------- ?-placeholder SQL -> Postgres $1..$n, thin async wrappers ---------- */
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
async function run(sql, params = []) {
  const res = await pool.query(toPgParams(sql), params);
  return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id };
}
async function get(sql, params = []) {
  const res = await pool.query(toPgParams(sql), params);
  return res.rows[0];
}
async function all(sql, params = []) {
  const res = await pool.query(toPgParams(sql), params);
  return res.rows;
}

await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
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
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL, value TEXT NOT NULL, level TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  uid INTEGER,
  from_text TEXT, from_addr TEXT, subject TEXT, body TEXT,
  attachments TEXT, message_id TEXT, received_at BIGINT,
  priority TEXT, summary TEXT, action TEXT,
  status TEXT DEFAULT 'new',
  snoozed_until BIGINT,
  sent_reply TEXT
);
CREATE TABLE IF NOT EXISTS seen_uids (
  user_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  PRIMARY KEY (user_id, uid)
);
CREATE TABLE IF NOT EXISTS awaiting_replies (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  counterparty TEXT NOT NULL,
  subject TEXT,
  sent_at BIGINT NOT NULL,
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
  used_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_tables (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS data_rows (
  id SERIAL PRIMARY KEY,
  table_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  email_id TEXT,
  values_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_user ON emails(user_id, status);
CREATE INDEX IF NOT EXISTS idx_data_rows_table ON data_rows(table_id);
`);

/* schema upgrades for existing databases (no-ops on fresh ones) */
for (const sql of [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_start INTEGER",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS mute_end INTEGER",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS pending_push INTEGER DEFAULT 0",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS claimed_by INTEGER",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS scam_risk REAL",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS scam_reasons TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS category TEXT",
  "ALTER TABLE emails ADD COLUMN IF NOT EXISTS highlights TEXT",
]) {
  await pool.query(sql);
}

/* ---------- users ---------- */
export const createUser = (email, passHash) =>
  run("INSERT INTO users (email, pass_hash, created_at) VALUES (?,?,?) RETURNING id", [email, passHash, Date.now()]);
export const createGoogleUser = (email, passHash, googleId) =>
  run("INSERT INTO users (email, pass_hash, google_id, created_at) VALUES (?,?,?,?) RETURNING id", [email, passHash, googleId, Date.now()]);
export const userByEmail = (email) => get("SELECT * FROM users WHERE email = ?", [email]);
export const userByGoogleId = (googleId) => get("SELECT * FROM users WHERE google_id = ?", [googleId]);
export const linkGoogleId = (userId, googleId) => run("UPDATE users SET google_id=? WHERE id=?", [googleId, userId]);
export const userById = (id) => get("SELECT * FROM users WHERE id = ?", [id]);
export const userByChat = (chatId) => get("SELECT * FROM users WHERE telegram_chat_id = ?", [String(chatId)]);
export const userByWhatsApp = (num) => get("SELECT * FROM users WHERE whatsapp_number = ?", [num]);
export const usersWithInbox = () =>
  all("SELECT * FROM users WHERE mail_user IS NOT NULL AND mail_pass_enc IS NOT NULL");

export const setInbox = (userId, mailUser, passEnc, imapHost, imapPort, smtpHost, smtpPort) =>
  run("UPDATE users SET mail_user=?, mail_pass_enc=?, imap_host=?, imap_port=?, smtp_host=?, smtp_port=? WHERE id=?",
    [mailUser, passEnc, imapHost, imapPort, smtpHost, smtpPort, userId]);
export const disconnectInbox = (userId) =>
  run("UPDATE users SET mail_user=NULL, mail_pass_enc=NULL WHERE id=?", [userId]);
export const setTelegramChat = (userId, chatId) =>
  run("UPDATE users SET telegram_chat_id=? WHERE id=?", [String(chatId), userId]);
export const setWhatsApp = (userId, num) =>
  run("UPDATE users SET whatsapp_number=? WHERE id=?", [num, userId]);
export const setDigestDay = (userId, day) =>
  run("UPDATE users SET last_digest_day=? WHERE id=?", [day, userId]);
export const setMuteHours = (userId, start, end) =>
  run("UPDATE users SET mute_start=?, mute_end=? WHERE id=?", [start, end, userId]);

/* ---------- team ---------- */
export const teamAdd = (ownerId, memberId) =>
  run("INSERT INTO team_members (owner_id, member_id) VALUES (?,?) ON CONFLICT DO NOTHING", [ownerId, memberId]);
export const teamRemove = (ownerId, memberId) =>
  run("DELETE FROM team_members WHERE owner_id=? AND member_id=?", [ownerId, memberId]);
export const teamMembers = (ownerId) =>
  all("SELECT u.* FROM team_members t JOIN users u ON u.id=t.member_id WHERE t.owner_id=?", [ownerId]);
export const isTeamMember = async (ownerId, memberId) =>
  !!(await get("SELECT 1 FROM team_members WHERE owner_id=? AND member_id=?", [ownerId, memberId]));

/* ---------- awaiting replies (silence catcher) ---------- */
export const addAwaiting = (userId, counterparty, subject) =>
  run("INSERT INTO awaiting_replies (user_id, counterparty, subject, sent_at) VALUES (?,?,?,?)",
    [userId, counterparty.toLowerCase(), subject, Date.now()]);
export const clearAwaiting = (userId, counterparty) =>
  run("DELETE FROM awaiting_replies WHERE user_id=? AND counterparty=?", [userId, (counterparty || "").toLowerCase()]);
export const dueAwaiting = (days) =>
  all("SELECT * FROM awaiting_replies WHERE nudged=0 AND sent_at <= ?", [Date.now() - days * 24 * 3600 * 1000]);
export const awaitingById = (id) => get("SELECT * FROM awaiting_replies WHERE id=?", [id]);
export const markNudged = (id) => run("UPDATE awaiting_replies SET nudged=1 WHERE id=?", [id]);
export const dismissAwaiting = (id) => run("DELETE FROM awaiting_replies WHERE id=?", [id]);

/* ---------- link codes (magic links) ---------- */
export const createLinkCode = (code, userId) =>
  run(`INSERT INTO link_codes (code, user_id, created_at) VALUES (?,?,?)
       ON CONFLICT (code) DO UPDATE SET user_id=EXCLUDED.user_id, created_at=EXCLUDED.created_at`,
    [code, userId, Date.now()]);
export const consumeLinkCode = async (code) => {
  const row = await get("SELECT * FROM link_codes WHERE code = ?", [code]);
  if (!row) return null;
  if (Date.now() - Number(row.created_at) > 30 * 60 * 1000) return null; // 30-min expiry
  await run("DELETE FROM link_codes WHERE code = ?", [code]);
  return row.user_id;
};

/* ---------- rules ---------- */
export const rulesFor = (userId) => all("SELECT * FROM rules WHERE user_id = ?", [userId]);
export const addRule = (userId, type, value, level) =>
  run("INSERT INTO rules (user_id, type, value, level) VALUES (?,?,?,?)", [userId, type, value, level]);
export const delRule = (userId, id) => run("DELETE FROM rules WHERE id = ? AND user_id = ?", [id, userId]);

/* ---------- templates ---------- */
export const templatesFor = (userId) => all("SELECT * FROM templates WHERE user_id = ?", [userId]);
export const templateById = (userId, id) =>
  get("SELECT * FROM templates WHERE id = ? AND user_id = ?", [id, userId]);
export const addTemplate = (userId, name, content) =>
  run("INSERT INTO templates (user_id, name, content) VALUES (?,?,?)", [userId, name, content]);
export const delTemplate = (userId, id) => run("DELETE FROM templates WHERE id = ? AND user_id = ?", [id, userId]);

/* ---------- categories ---------- */
export const DEFAULT_CATEGORIES = ["Payment", "Complaint", "Request", "Update", "Other"];
export const seedDefaultCategories = async (userId) => {
  for (const name of DEFAULT_CATEGORIES) {
    await run("INSERT INTO categories (user_id, name, created_at) VALUES (?,?,?)", [userId, name, Date.now()]);
  }
};
export const categoriesFor = (userId) => all("SELECT * FROM categories WHERE user_id = ? ORDER BY id", [userId]);
export const addCategory = (userId, name) =>
  run("INSERT INTO categories (user_id, name, created_at) VALUES (?,?,?)", [userId, name, Date.now()]);
export const delCategory = (userId, id) => run("DELETE FROM categories WHERE id = ? AND user_id = ?", [id, userId]);

/* ---------- custom data tables (merchant-defined extraction folders) ---------- */
const hydrateTable = (row) => row && { id: row.id, userId: row.user_id, name: row.name, fields: JSON.parse(row.fields), createdAt: row.created_at };
const hydrateRow = (row) => row && { id: row.id, tableId: row.table_id, userId: row.user_id, emailId: row.email_id, values: JSON.parse(row.values_json), createdAt: row.created_at };

export const dataTablesFor = async (userId) =>
  (await all("SELECT * FROM data_tables WHERE user_id = ? ORDER BY id", [userId])).map(hydrateTable);
export const dataTableById = async (userId, id) =>
  hydrateTable(await get("SELECT * FROM data_tables WHERE id = ? AND user_id = ?", [id, userId]));
export const createDataTable = (userId, name, fields) =>
  run("INSERT INTO data_tables (user_id, name, fields, created_at) VALUES (?,?,?,?)",
    [userId, name, JSON.stringify(fields), Date.now()]);
export const delDataTable = async (userId, id) => {
  await run("DELETE FROM data_rows WHERE table_id = ? AND user_id = ?", [id, userId]);
  await run("DELETE FROM data_tables WHERE id = ? AND user_id = ?", [id, userId]);
};

export const rowsForTable = async (userId, tableId) =>
  (await all("SELECT * FROM data_rows WHERE table_id = ? AND user_id = ? ORDER BY id DESC", [tableId, userId])).map(hydrateRow);
export const addDataRow = (userId, tableId, emailId, values) =>
  run("INSERT INTO data_rows (table_id, user_id, email_id, values_json, created_at) VALUES (?,?,?,?,?)",
    [tableId, userId, emailId ?? null, JSON.stringify(values), Date.now()]);
export const delDataRow = (userId, id) => run("DELETE FROM data_rows WHERE id = ? AND user_id = ?", [id, userId]);

/* ---------- emails ---------- */
export const insertEmail = (e) =>
  run(`INSERT INTO emails (id, user_id, uid, from_text, from_addr, subject, body, attachments, message_id, received_at, priority, summary, action, status, snoozed_until, sent_reply, category, highlights)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.id, e.userId, e.uid ?? null, e.from ?? null, e.fromAddr ?? null, e.subject ?? null, e.body ?? null,
     JSON.stringify(e.attachments || []), e.messageId ?? null, e.receivedAt ?? Date.now(),
     e.priority ?? null, e.summary ?? null, e.action ?? null, e.status || "new",
     e.snoozedUntil ?? null, e.sentReply ?? null, e.category ?? null, JSON.stringify(e.highlights || [])]);

export const emailById = async (id) => hydrate(await get("SELECT * FROM emails WHERE id = ?", [id]));
export const openEmailsFor = async (userId) =>
  (await all("SELECT * FROM emails WHERE user_id = ? AND status != 'done' AND (snoozed_until IS NULL OR snoozed_until <= ?)",
    [userId, Date.now()])).map(hydrate);
export const dueSnoozed = async () =>
  (await all("SELECT * FROM emails WHERE status != 'done' AND snoozed_until IS NOT NULL AND snoozed_until <= ?",
    [Date.now()])).map(hydrate);
export const updateEmail = (id, fields) => {
  const map = { status: "status", snoozedUntil: "snoozed_until", sentReply: "sent_reply", summary: "summary", action: "action", priority: "priority", scamRisk: "scam_risk", scamReasons: "scam_reasons" };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return Promise.resolve();
  vals.push(id);
  return run(`UPDATE emails SET ${sets.join(", ")} WHERE id = ?`, vals);
};
export const recentEmailsFor = async (userId, limit = 50) =>
  (await all("SELECT * FROM emails WHERE user_id = ? ORDER BY received_at DESC LIMIT ?", [userId, limit])).map(hydrate);

export const knownSendersFor = async (userId) => {
  const rows = await all("SELECT DISTINCT from_addr FROM emails WHERE user_id=? AND sent_reply IS NOT NULL", [userId]);
  return new Set(rows.map((r) => (r.from_addr || "").toLowerCase()).filter(Boolean));
};

export const searchEmails = async (userId, q, limit = 5) =>
  (await all(`SELECT * FROM emails WHERE user_id = ? AND (subject ILIKE ? OR body ILIKE ? OR from_text ILIKE ?)
              ORDER BY received_at DESC LIMIT ?`,
    [userId, `%${q}%`, `%${q}%`, `%${q}%`, limit])).map(hydrate);

export const setPendingPush = (id, v) => run("UPDATE emails SET pending_push=? WHERE id=?", [v ? 1 : 0, id]);
export const pendingPushFor = async (userId) =>
  (await all("SELECT * FROM emails WHERE user_id=? AND pending_push=1 AND status != 'done'", [userId])).map(hydrate);
export const setClaimedBy = (id, memberId) => run("UPDATE emails SET claimed_by=? WHERE id=?", [memberId, id]);
export const claimedBy = async (id) => (await get("SELECT claimed_by FROM emails WHERE id=?", [id]))?.claimed_by || null;

export const weeklyStats = async (userId) => {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const total = Number((await get("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=?", [userId, weekAgo])).c);
  const high = Number((await get("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND priority='high'", [userId, weekAgo])).c);
  const done = Number((await get("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND status='done'", [userId, weekAgo])).c);
  const replies = Number((await get("SELECT COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? AND sent_reply IS NOT NULL", [userId, weekAgo])).c);
  const topSenders = await all("SELECT from_text f, COUNT(*) c FROM emails WHERE user_id=? AND received_at>=? GROUP BY from_text, from_addr ORDER BY c DESC LIMIT 3", [userId, weekAgo]);
  const open = Number((await get("SELECT COUNT(*) c FROM emails WHERE user_id=? AND status != 'done'", [userId])).c);
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
    pendingPush: row.pending_push, claimedBy: row.claimed_by, category: row.category,
    highlights: JSON.parse(row.highlights || "[]"),
  };
}

export const userByAnyEmail = (addr) => {
  const a = (addr || "").toLowerCase();
  return get("SELECT * FROM users WHERE email = ? OR mail_user = ?", [a, a]);
};

/* ---------- mainnet payment replay guard ---------- */
export const isTxUsed = async (txHash) => !!(await get("SELECT 1 FROM used_payments WHERE tx_hash = ?", [txHash]));
export const markTxUsed = (txHash, service, amount, payer) =>
  run("INSERT INTO used_payments (tx_hash, service, amount, payer, used_at) VALUES (?,?,?,?,?)",
    [txHash, service, amount, payer, Date.now()]);

/* ---------- seen uids ---------- */
export const isSeen = async (userId, uid) => !!(await get("SELECT 1 FROM seen_uids WHERE user_id = ? AND uid = ?", [userId, uid]));
export const markSeen = (userId, uid) =>
  run("INSERT INTO seen_uids (user_id, uid) VALUES (?,?) ON CONFLICT DO NOTHING", [userId, uid]);
