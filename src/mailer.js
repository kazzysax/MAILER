import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { decrypt } from "./crypto.js";
import { config } from "./config.js";
import * as db from "./db.js";

const uid = () => Math.random().toString(36).slice(2, 12);

function creds(user) {
  return {
    mailUser: user.mail_user,
    mailPass: decrypt(user.mail_pass_enc),
    imapHost: user.imap_host || "imap.gmail.com",
    imapPort: user.imap_port || 993,
    smtpHost: user.smtp_host || "smtp.gmail.com",
    smtpPort: user.smtp_port || 465,
  };
}

/* ---------- verify a user's credentials at connect time ---------- */
export async function testImap(mailUser, mailPass, imapHost, imapPort) {
  const client = new ImapFlow({
    host: imapHost, port: imapPort, secure: true,
    auth: { user: mailUser, pass: mailPass }, logger: false,
  });
  await client.connect();
  await client.logout();
}

/* ---------- fetch this user's new emails ---------- */
export async function fetchNewEmailsFor(user) {
  const c = creds(user);
  const client = new ImapFlow({
    host: c.imapHost, port: c.imapPort, secure: true,
    auth: { user: c.mailUser, pass: c.mailPass }, logger: false,
  });

  const results = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const uids = await client.search({ since }, { uid: true });
      const seenChecks = await Promise.all((uids || []).map((u) => db.isSeen(user.id, u)));
      const fresh = (uids || []).filter((u, i) => !seenChecks[i]);

      for (const u of fresh) {
        const msg = await client.fetchOne(u, { source: true }, { uid: true });
        await db.markSeen(user.id, u);
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0]?.address || "";
        if (fromAddr.toLowerCase() === c.mailUser.toLowerCase()) continue; // own mail

        results.push({
          id: uid(),
          userId: user.id,
          uid: u,
          from: parsed.from?.text || fromAddr || "unknown",
          fromAddr,
          subject: parsed.subject || "(no subject)",
          body: (parsed.text || "").trim() || (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""),
          attachments: (parsed.attachments || []).map((a) => a.filename).filter(Boolean),
          messageId: parsed.messageId || null,
          receivedAt: parsed.date ? parsed.date.getTime() : Date.now(),
          status: "new",
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error(`IMAP poll failed for user ${user.id}:`, e.message);
    try { await client.logout(); } catch {}
  }
  return results;
}

/* ---------- the shared forward-to-MAILER inbox ---------- */
export async function fetchForwardInbox() {
  if (!config.forward.enabled) return [];
  const client = new ImapFlow({
    host: config.forward.imapHost, port: config.forward.imapPort, secure: true,
    auth: { user: config.forward.user, pass: config.forward.password }, logger: false,
  });
  const results = []; // [{user, email}]
  const FORWARD_UID_OWNER = 0; // seen_uids slot for the shared inbox
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const uids = await client.search({ since }, { uid: true });
      const seenChecks = await Promise.all((uids || []).map((u) => db.isSeen(FORWARD_UID_OWNER, u)));
      const fresh = (uids || []).filter((u, i) => !seenChecks[i]);
      for (const u of fresh) {
        const msg = await client.fetchOne(u, { source: true }, { uid: true });
        await db.markSeen(FORWARD_UID_OWNER, u);
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const forwarder = parsed.from?.value?.[0]?.address || "";
        const user = await db.userByAnyEmail(forwarder);
        if (!user) continue; // forwarder isn't an MAILER user — ignore

        results.push({
          user,
          email: {
            id: uid(),
            userId: user.id,
            uid: null,
            from: forwarder,
            fromAddr: forwarder,
            subject: (parsed.subject || "(no subject)").replace(/^(fwd?:)\s*/i, "Fwd: "),
            body: (parsed.text || "").trim() || (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : ""),
            attachments: (parsed.attachments || []).map((a) => a.filename).filter(Boolean),
            messageId: parsed.messageId || null,
            receivedAt: parsed.date ? parsed.date.getTime() : Date.now(),
            status: "new",
          },
        });
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    console.error("Forward-inbox poll failed:", e.message);
    try { await client.logout(); } catch {}
  }
  return results;
}

/* ---------- send an approved reply from this user's address ---------- */
export async function sendReplyFor(user, email, bodyText) {
  const c = creds(user);
  const transporter = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465,
    auth: { user: c.mailUser, pass: c.mailPass },
    connectionTimeout: 15000, // fail fast instead of hanging ~2min on a blocked port
    greetingTimeout: 15000,
  });
  const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
  const mail = { from: c.mailUser, to: email.fromAddr || email.from, subject, text: bodyText };
  if (email.messageId) {
    mail.inReplyTo = email.messageId;
    mail.references = email.messageId;
  }
  try {
    await transporter.sendMail(mail);
  } catch (e) {
    if (/timeout|ETIMEDOUT|ESOCKET|ECONNREFUSED/i.test(e.message || e.code || "")) {
      throw new Error(
        `Could not reach ${c.smtpHost}:${c.smtpPort} — your network, firewall, or antivirus is likely blocking outbound SMTP. ` +
        `Try a different network (e.g. mobile hotspot), or if port ${c.smtpPort} is blocked, try the other common port (587 or 465, whichever you're not already on) in Advanced settings when reconnecting your inbox.`
      );
    }
    throw e;
  }
}
