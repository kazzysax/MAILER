import express from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import * as db from "./db.js";
import { hashPassword, verifyPassword, signSession, verifySession, encrypt, randomCode } from "./crypto.js";
import { testImap, fetchNewEmailsFor, sendReplyFor } from "./mailer.js";
import { processIncoming } from "./engine.js";
import { extractFields, draftReply, fillTemplate, interpretCommand } from "./ai.js";

const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

export function apiRouter() {
  const r = express.Router();
  r.use(express.json());

  /* ---------- auth middleware ---------- */
  async function auth(req, res, next) {
    const userId = verifySession(req.cookies?.xm);
    if (!userId) return res.status(401).json({ error: "Not signed in" });
    const user = await db.userById(userId);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    req.user = user;
    next();
  }

  /* ---------- public config (safe to expose: OAuth client IDs are not secret) ---------- */
  r.get("/config", (req, res) => {
    res.json({ googleClientId: config.googleClientId || null });
  });

  /* ---------- auth ---------- */
  r.post("/signup", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: "Email and a password of 8+ characters required." });
    }
    if (await db.userByEmail(email.toLowerCase())) return res.status(400).json({ error: "Account already exists — log in." });
    const info = await db.createUser(email.toLowerCase(), hashPassword(password));
    const userId = Number(info.lastInsertRowid);
    await db.seedDefaultCategories(userId);
    res.cookie("xm", signSession(userId), { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ ok: true });
  });

  r.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    const user = await db.userByEmail((email || "").toLowerCase());
    if (!user || !verifyPassword(password || "", user.pass_hash)) {
      return res.status(401).json({ error: "Wrong email or password." });
    }
    res.cookie("xm", signSession(user.id), { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ ok: true });
  });

  r.post("/auth/google", async (req, res) => {
    if (!googleClient) return res.status(400).json({ error: "Google sign-in isn't enabled on this server." });
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: "Missing Google credential." });
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: "Could not verify Google sign-in. Please try again." });
    }
    if (!payload?.email || !payload.email_verified) {
      return res.status(401).json({ error: "Your Google account has no verified email." });
    }
    const email = payload.email.toLowerCase();
    let user = await db.userByGoogleId(payload.sub);
    if (!user) {
      user = await db.userByEmail(email);
      if (user) {
        await db.linkGoogleId(user.id, payload.sub);
      } else {
        const info = await db.createGoogleUser(email, hashPassword(randomCode(32)), payload.sub);
        const userId = Number(info.lastInsertRowid);
        await db.seedDefaultCategories(userId);
        user = await db.userById(userId);
      }
    }
    res.cookie("xm", signSession(user.id), { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ ok: true });
  });

  r.post("/logout", (req, res) => {
    res.clearCookie("xm");
    res.json({ ok: true });
  });

  /* ---------- status ---------- */
  r.get("/me", auth, (req, res) => {
    const u = req.user;
    res.json({
      email: u.email,
      inboxConnected: !!u.mail_user,
      inboxUser: u.mail_user || null,
      telegramLinked: !!u.telegram_chat_id,
      whatsappNumber: u.whatsapp_number || null,
      whatsappEnabled: config.twilio.enabled,
      muteStart: u.mute_start,
      muteEnd: u.mute_end,
    });
  });

  /* ---------- inbox connect (verifies IMAP live before saving) ---------- */
  r.post("/inbox", auth, async (req, res) => {
    let { mailUser, mailPass, imapHost, imapPort, smtpHost, smtpPort } = req.body || {};
    if (!mailUser || !mailPass) return res.status(400).json({ error: "Email address and app password required." });
    // Google displays App Passwords as "abcd efgh ijkl mnop" — reject pastes with spaces and tell the user to fix it.
    if (/\s/.test(mailPass)) {
      return res.status(400).json({ error: "Your app password contains spaces. Remove ALL spaces (Google shows it as 4 groups, but the real password has none) and try again." });
    }
    mailUser = mailUser.trim();
    const ih = imapHost || "imap.gmail.com", ip = Number(imapPort || 993);
    const sh = smtpHost || "smtp.gmail.com", sp = Number(smtpPort || 465);
    try {
      await testImap(mailUser, mailPass, ih, ip);
    } catch (e) {
      return res.status(400).json({ error: "Could not connect to that inbox: " + e.message + " (Gmail: use an App Password, not your normal password.)" });
    }
    await db.setInbox(req.user.id, mailUser, encrypt(mailPass), ih, ip, sh, sp);
    res.json({ ok: true });
  });

  r.delete("/inbox", auth, async (req, res) => {
    await db.disconnectInbox(req.user.id);
    res.json({ ok: true });
  });

  /* ---------- rules ---------- */
  r.get("/rules", auth, async (req, res) => res.json(await db.rulesFor(req.user.id)));
  r.post("/rules", auth, async (req, res) => {
    const { type, value, level } = req.body || {};
    if (!["sender", "domain", "keyword"].includes(type) || !["high", "low"].includes(level) || !value?.trim()) {
      return res.status(400).json({ error: "Invalid rule." });
    }
    await db.addRule(req.user.id, type, value.trim(), level);
    res.json({ ok: true });
  });
  r.delete("/rules/:id", auth, async (req, res) => {
    await db.delRule(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- templates ---------- */
  r.get("/templates", auth, async (req, res) => res.json(await db.templatesFor(req.user.id)));
  r.post("/templates", auth, async (req, res) => {
    const { name, content } = req.body || {};
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: "Name and content required." });
    await db.addTemplate(req.user.id, name.trim().slice(0, 60), content.trim());
    res.json({ ok: true });
  });
  r.delete("/templates/:id", auth, async (req, res) => {
    await db.delTemplate(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- categories (customizable, seeded with defaults) ---------- */
  r.get("/categories", auth, async (req, res) => {
    let cats = await db.categoriesFor(req.user.id);
    if (!cats.length) {
      await db.seedDefaultCategories(req.user.id);
      cats = await db.categoriesFor(req.user.id);
    }
    res.json(cats);
  });
  r.post("/categories", auth, async (req, res) => {
    const name = (req.body?.name || "").trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: "Category name required." });
    const existing = await db.categoriesFor(req.user.id);
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "That category already exists." });
    }
    await db.addCategory(req.user.id, name);
    res.json({ ok: true });
  });
  r.delete("/categories/:id", auth, async (req, res) => {
    const existing = await db.categoriesFor(req.user.id);
    if (existing.length <= 1) return res.status(400).json({ error: "Keep at least one category." });
    await db.delCategory(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- businesses (sender organizations the merchant tracks) ---------- */
  r.get("/businesses", auth, async (req, res) => {
    let list = await db.businessesFor(req.user.id);
    if (!list.length) {
      await db.seedBusinessesFromEmails(req.user.id);
      list = await db.businessesFor(req.user.id);
    }
    res.json(list);
  });
  r.post("/businesses", auth, async (req, res) => {
    const name = (req.body?.name || "").trim().slice(0, 40);
    const domain = (req.body?.domain || "").trim().toLowerCase().replace(/^@/, "").slice(0, 80);
    if (!name) return res.status(400).json({ error: "Business name required." });
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: "Enter a valid domain, e.g. acme.com." });
    const existing = await db.businessesFor(req.user.id);
    if (existing.some((b) => b.domain === domain)) return res.status(400).json({ error: "That domain is already tracked." });
    await db.addBusiness(req.user.id, name, domain);
    res.json({ ok: true });
  });
  r.delete("/businesses/:id", auth, async (req, res) => {
    await db.delBusiness(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- custom data tables (merchant-defined extraction folders) ---------- */
  r.get("/dbtables", auth, async (req, res) => {
    const tables = await db.dataTablesFor(req.user.id);
    const withCounts = await Promise.all(tables.map(async (t) => ({ ...t, rowCount: (await db.rowsForTable(req.user.id, t.id)).length })));
    res.json(withCounts);
  });
  r.post("/dbtables", auth, async (req, res) => {
    const name = (req.body?.name || "").trim().slice(0, 40);
    const fields = Array.isArray(req.body?.fields)
      ? [...new Set(req.body.fields.map((f) => String(f || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
      : [];
    if (!name) return res.status(400).json({ error: "Folder name required." });
    if (!fields.length) return res.status(400).json({ error: "Add at least one field to store." });
    await db.createDataTable(req.user.id, name, fields);
    res.json({ ok: true });
  });
  r.delete("/dbtables/:id", auth, async (req, res) => {
    await db.delDataTable(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  r.get("/dbtables/:id/rows", auth, async (req, res) => {
    const table = await db.dataTableById(req.user.id, Number(req.params.id));
    if (!table) return res.status(404).json({ error: "Folder not found." });
    res.json({ table, rows: await db.rowsForTable(req.user.id, table.id) });
  });
  r.delete("/dbtables/:id/rows/:rowId", auth, async (req, res) => {
    await db.delDataRow(req.user.id, Number(req.params.rowId));
    res.json({ ok: true });
  });

  /* ---------- the per-email "add to database" portal ---------- */
  r.post("/emails/:id/extract", auth, async (req, res) => {
    const email = await db.emailById(req.params.id);
    if (!email || email.userId !== req.user.id) return res.status(404).json({ error: "Email not found." });
    const table = await db.dataTableById(req.user.id, Number(req.body?.tableId));
    if (!table) return res.status(404).json({ error: "Database folder not found." });
    try {
      const values = await extractFields(email, table.fields);
      await db.addDataRow(req.user.id, table.id, email.id, values);
      res.json({ ok: true, values });
    } catch (e) {
      res.status(500).json({ error: "Extraction failed: " + e.message });
    }
  });

  /* ---------- connect Telegram: magic link ---------- */
  r.post("/link/telegram", auth, async (req, res) => {
    const code = randomCode(12);
    await db.createLinkCode(code, req.user.id);
    res.json({ link: `https://t.me/${config.telegramBotUsername}?start=${code}` });
  });

  /* ---------- connect WhatsApp: magic link (primary flow) ---------- */
  r.post("/link/whatsapp/start", auth, async (req, res) => {
    if (!config.twilio.enabled) return res.status(400).json({ error: "WhatsApp isn't enabled on this server yet." });
    const code = randomCode(12);
    await db.createLinkCode(code, req.user.id);
    const digits = config.twilio.from.replace(/[^\d]/g, ""); // whatsapp:+1415... -> 1415...
    const link = `https://wa.me/${digits}?text=${encodeURIComponent("start " + code)}`;
    res.json({ link, number: "+" + digits });
  });

  /* ---------- connect WhatsApp: manual number entry (fallback) ---------- */
  r.post("/link/whatsapp", auth, async (req, res) => {
    if (!config.twilio.enabled) return res.status(400).json({ error: "WhatsApp isn't enabled on this server yet." });
    let { number } = req.body || {};
    number = (number || "").replace(/[^+\d]/g, "");
    if (!/^\+\d{8,15}$/.test(number)) return res.status(400).json({ error: "Use international format, e.g. +2348012345678." });
    await db.setWhatsApp(req.user.id, `whatsapp:${number}`);
    res.json({ ok: true, sandboxFrom: config.twilio.from });
  });

  /* ---------- mute hours ---------- */
  r.post("/settings/mute", auth, async (req, res) => {
    const { start, end } = req.body || {};
    if (start === null || end === null || start === "" || end === "") {
      await db.setMuteHours(req.user.id, null, null);
      return res.json({ ok: true });
    }
    const s = Number(start), e = Number(end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23 || s === e) {
      return res.status(400).json({ error: "Hours must be 0–23 and different." });
    }
    await db.setMuteHours(req.user.id, s, e);
    res.json({ ok: true });
  });

  /* ---------- recent emails (dashboard view) ---------- */
  r.get("/emails", auth, async (req, res) => res.json(await db.recentEmailsFor(req.user.id, 50)));

  /* ---------- force an immediate inbox check (dashboard refresh button) ---------- */
  r.post("/emails/refresh", auth, async (req, res) => {
    if (!req.user.mail_user) return res.status(400).json({ error: "Connect your inbox first." });
    try {
      const fresh = await fetchNewEmailsFor(req.user);
      for (const email of fresh) await processIncoming(req.user, email);
      res.json({ ok: true, new: fresh.length });
    } catch (e) {
      res.status(500).json({ error: "Could not check your inbox: " + e.message });
    }
  });

  /* ---------- reply portal (dashboard): draft, fill template, send for real ---------- */
  r.post("/emails/:id/draft", auth, async (req, res) => {
    const email = await db.emailById(req.params.id);
    if (!email || email.userId !== req.user.id) return res.status(404).json({ error: "Email not found." });
    const instruction = (req.body?.instruction || "").trim();
    if (!instruction) return res.status(400).json({ error: "Tell me what you want the reply to say." });
    try {
      const draft = await draftReply(email, instruction);
      res.json({ draft });
    } catch (e) {
      res.status(500).json({ error: "Drafting failed: " + e.message });
    }
  });

  r.post("/emails/:id/fill-template", auth, async (req, res) => {
    const email = await db.emailById(req.params.id);
    if (!email || email.userId !== req.user.id) return res.status(404).json({ error: "Email not found." });
    const tpl = await db.templateById(req.user.id, Number(req.body?.templateId));
    if (!tpl) return res.status(404).json({ error: "Template not found." });
    try {
      const draft = await fillTemplate(email, tpl);
      res.json({ draft });
    } catch (e) {
      res.status(500).json({ error: "Template fill failed: " + e.message });
    }
  });

  r.post("/emails/:id/send", auth, async (req, res) => {
    const email = await db.emailById(req.params.id);
    if (!email || email.userId !== req.user.id) return res.status(404).json({ error: "Email not found." });
    const body = (req.body?.body || "").trim();
    if (!body) return res.status(400).json({ error: "Reply can't be empty." });
    if (!req.user.mail_user) return res.status(400).json({ error: "Connect your inbox first." });
    try {
      await sendReplyFor(req.user, email, body);
      await db.updateEmail(email.id, { sentReply: body, status: "done" });
      await db.addAwaiting(req.user.id, email.fromAddr || email.from, email.subject);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Send failed: " + e.message });
    }
  });

  /* ---------- AI voice/text assistant (bottom-left dashboard widget) ---------- */
  r.post("/assistant", auth, async (req, res) => {
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Say or type a command." });
    let result;
    try {
      result = await interpretCommand(text);
    } catch (e) {
      return res.status(500).json({ error: "Assistant failed: " + e.message });
    }
    try {
      switch (result.action) {
        case "add_rule": {
          const type = result.type, level = result.level, value = String(result.value || "").trim();
          if (["sender", "domain", "keyword"].includes(type) && ["high", "low"].includes(level) && value) {
            await db.addRule(req.user.id, type, value, level);
          } else {
            result = { action: "unknown", message: "I wasn't sure how to set that rule up — try 'mark emails containing invoice as high priority'." };
          }
          break;
        }
        case "add_category": {
          const name = String(result.name || "").trim().slice(0, 30);
          if (name) {
            const existing = await db.categoriesFor(req.user.id);
            if (!existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
              await db.addCategory(req.user.id, name);
            }
          } else {
            result = { action: "unknown", message: "What should the category be called?" };
          }
          break;
        }
        case "create_folder": {
          const name = String(result.name || "").trim().slice(0, 40);
          const fields = Array.isArray(result.fields)
            ? [...new Set(result.fields.map((f) => String(f || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 12)
            : [];
          if (name && fields.length) {
            await db.createDataTable(req.user.id, name, fields);
          } else {
            result = { action: "unknown", message: "Tell me the folder name and which fields to store, e.g. 'create a folder called Invoices with sender, amount, and due date'." };
          }
          break;
        }
        case "add_template": {
          const name = String(result.name || "").trim().slice(0, 60);
          const content = String(result.content || "").trim();
          if (name && content) {
            await db.addTemplate(req.user.id, name, content);
          } else {
            result = { action: "unknown", message: "Give me a template name and the text to save." };
          }
          break;
        }
        case "add_business": {
          const name = String(result.name || "").trim().slice(0, 40);
          const domain = String(result.domain || "").trim().toLowerCase().replace(/^@/, "").slice(0, 80);
          if (name && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
            const existing = await db.businessesFor(req.user.id);
            if (!existing.some((b) => b.domain === domain)) await db.addBusiness(req.user.id, name, domain);
          } else {
            result = { action: "unknown", message: "Tell me the business name and its email domain, e.g. 'add a business called Acme at acme.com'." };
          }
          break;
        }
        default:
          break; // view_emails/view_category/view_tier/search/refresh_inbox/unknown are handled client-side
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Couldn't do that: " + e.message });
    }
  });

  return r;
}
