import express from "express";
import { config } from "./config.js";
import * as db from "./db.js";
import { hashPassword, verifyPassword, signSession, verifySession, encrypt, randomCode } from "./crypto.js";
import { testImap } from "./mailer.js";

export function apiRouter() {
  const r = express.Router();
  r.use(express.json());

  /* ---------- auth middleware ---------- */
  function auth(req, res, next) {
    const userId = verifySession(req.cookies?.xm);
    if (!userId) return res.status(401).json({ error: "Not signed in" });
    const user = db.userById(userId);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    req.user = user;
    next();
  }

  /* ---------- auth ---------- */
  r.post("/signup", (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: "Email and a password of 8+ characters required." });
    }
    if (db.userByEmail(email.toLowerCase())) return res.status(400).json({ error: "Account already exists — log in." });
    const info = db.createUser(email.toLowerCase(), hashPassword(password));
    res.cookie("xm", signSession(Number(info.lastInsertRowid)), { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ ok: true });
  });

  r.post("/login", (req, res) => {
    const { email, password } = req.body || {};
    const user = db.userByEmail((email || "").toLowerCase());
    if (!user || !verifyPassword(password || "", user.pass_hash)) {
      return res.status(401).json({ error: "Wrong email or password." });
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
    db.setInbox(req.user.id, mailUser, encrypt(mailPass), ih, ip, sh, sp);
    res.json({ ok: true });
  });

  r.delete("/inbox", auth, (req, res) => {
    db.disconnectInbox(req.user.id);
    res.json({ ok: true });
  });

  /* ---------- rules ---------- */
  r.get("/rules", auth, (req, res) => res.json(db.rulesFor(req.user.id)));
  r.post("/rules", auth, (req, res) => {
    const { type, value, level } = req.body || {};
    if (!["sender", "domain", "keyword"].includes(type) || !["high", "low"].includes(level) || !value?.trim()) {
      return res.status(400).json({ error: "Invalid rule." });
    }
    db.addRule(req.user.id, type, value.trim(), level);
    res.json({ ok: true });
  });
  r.delete("/rules/:id", auth, (req, res) => {
    db.delRule(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- templates ---------- */
  r.get("/templates", auth, (req, res) => res.json(db.templatesFor(req.user.id)));
  r.post("/templates", auth, (req, res) => {
    const { name, content } = req.body || {};
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: "Name and content required." });
    db.addTemplate(req.user.id, name.trim().slice(0, 60), content.trim());
    res.json({ ok: true });
  });
  r.delete("/templates/:id", auth, (req, res) => {
    db.delTemplate(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- connect Telegram: magic link ---------- */
  r.post("/link/telegram", auth, (req, res) => {
    const code = randomCode(12);
    db.createLinkCode(code, req.user.id);
    res.json({ link: `https://t.me/${config.telegramBotUsername}?start=${code}` });
  });

  /* ---------- connect WhatsApp: magic link (primary flow) ---------- */
  r.post("/link/whatsapp/start", auth, (req, res) => {
    if (!config.twilio.enabled) return res.status(400).json({ error: "WhatsApp isn't enabled on this server yet." });
    const code = randomCode(12);
    db.createLinkCode(code, req.user.id);
    const digits = config.twilio.from.replace(/[^\d]/g, ""); // whatsapp:+1415... -> 1415...
    const link = `https://wa.me/${digits}?text=${encodeURIComponent("start " + code)}`;
    res.json({ link, number: "+" + digits });
  });

  /* ---------- connect WhatsApp: manual number entry (fallback) ---------- */
  r.post("/link/whatsapp", auth, (req, res) => {
    if (!config.twilio.enabled) return res.status(400).json({ error: "WhatsApp isn't enabled on this server yet." });
    let { number } = req.body || {};
    number = (number || "").replace(/[^+\d]/g, "");
    if (!/^\+\d{8,15}$/.test(number)) return res.status(400).json({ error: "Use international format, e.g. +2348012345678." });
    db.setWhatsApp(req.user.id, `whatsapp:${number}`);
    res.json({ ok: true, sandboxFrom: config.twilio.from });
  });

  /* ---------- mute hours ---------- */
  r.post("/settings/mute", auth, (req, res) => {
    const { start, end } = req.body || {};
    if (start === null || end === null || start === "" || end === "") {
      db.setMuteHours(req.user.id, null, null);
      return res.json({ ok: true });
    }
    const s = Number(start), e = Number(end);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || s > 23 || e < 0 || e > 23 || s === e) {
      return res.status(400).json({ error: "Hours must be 0–23 and different." });
    }
    db.setMuteHours(req.user.id, s, e);
    res.json({ ok: true });
  });

  /* ---------- recent emails (dashboard view) ---------- */
  r.get("/emails", auth, (req, res) => res.json(db.recentEmailsFor(req.user.id, 50)));

  return r;
}
