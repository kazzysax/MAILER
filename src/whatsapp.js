import { config } from "./config.js";
import * as db from "./db.js";
import { registerSender, onText, onAction } from "./engine.js";

/*
WhatsApp — MAILER's primary channel.
One Twilio WhatsApp number serves every user; inbound messages are routed
to accounts by the sender's number.

Binding (magic link, mirrors Telegram):
  Dashboard -> "Connect WhatsApp" -> wa.me link opens WhatsApp with
  "start <CODE>" pre-filled -> user hits send -> we bind their number.

No inline buttons on WhatsApp — options render as a numbered list and the
user replies with the number.
*/
const lastOptions = new Map(); // whatsapp number -> [{label, action}]
const MAX_LEN = 1500; // Twilio WhatsApp body limit is 1600 — stay under

function splitMessage(body) {
  if (body.length <= MAX_LEN) return [body];
  const parts = [];
  let rest = body;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function twilioSend(to, body) {
  for (const part of splitMessage(body)) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`;
    const params = new URLSearchParams({ From: config.twilio.from, To: to, Body: part });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) console.error("Twilio send failed:", res.status, (await res.text()).slice(0, 200));
  }
}

export function initWhatsApp(app) {
  if (!config.twilio.enabled) {
    console.log("WhatsApp disabled (no Twilio credentials).");
    return;
  }

  registerSender("whatsapp", async (number, text, options) => {
    let body = text;
    if (options && options.length) {
      lastOptions.set(number, options);
      body += "\n\n" + options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") + "\n\nReply with a number.";
    }
    await twilioSend(number, body);
  });

  app.post("/hooks/whatsapp", async (req, res) => {
    res.type("text/xml").send("<Response></Response>");
    const from = req.body.From || ""; // e.g. whatsapp:+234...
    const text = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    if (!from) return;

    // voice notes: transcribe -> treat the transcript as the user's message
    if (numMedia > 0 && (req.body.MediaContentType0 || "").startsWith("audio")) {
      const user = db.userByWhatsApp(from);
      if (!user) return twilioSend(from, `Sign up at ${config.baseUrl} first, then link this number.`);
      const { voiceEnabled, transcribeVoiceNote } = await import("./voice.js");
      if (!voiceEnabled()) {
        return twilioSend(from, "🎤 I got your voice note, but transcription isn't enabled on this server yet — type it instead for now.");
      }
      try {
        const transcript = await transcribeVoiceNote(req.body.MediaUrl0, req.body.MediaContentType0);
        // too short/garbled to act on safely — ask instead of guessing
        if (!transcript || transcript.replace(/[^a-zA-Z0-9]/g, "").length < 3) {
          return twilioSend(from, "I couldn't make that out clearly — say it again, or type it?");
        }
        await twilioSend(from, `🎤 Heard: "${transcript}"\n(If that's wrong, just send it again — nothing happens without your approval.)`);
        // NOTE: transcripts are fed as plain text ONLY — they can never select a numbered option or approve a send.
        return onText(user, transcript);
      } catch (e) {
        console.error("Voice note failed:", e.message);
        return twilioSend(from, "Couldn't process that voice note — type it instead?");
      }
    }

    if (!text) return;

    // magic-link binding: "start CODE" (or "link CODE") from any number
    const m = text.match(/^(?:start|link)\s+(\S+)/i);
    if (m) {
      const userId = db.consumeLinkCode(m[1]);
      if (userId) {
        db.setWhatsApp(userId, from);
        const user = db.userById(userId);
        return onText(user, "/start");
      }
      return twilioSend(from, `That link expired. Get a fresh one from your MAILER dashboard → Connect WhatsApp.`);
    }

    const user = db.userByWhatsApp(from);
    if (!user) {
      return twilioSend(from, `This number isn't linked to an MAILER account yet.\n\nSign up at ${config.baseUrl} and tap "Connect WhatsApp" — it opens this chat with your personal link ready to send.`);
    }

    const opts = lastOptions.get(from) || [];
    const n = Number(text);
    if (opts.length && Number.isInteger(n) && n >= 1 && n <= opts.length) {
      lastOptions.delete(from);
      return onAction(user, opts[n - 1].action);
    }
    return onText(user, text);
  });

  console.log("WhatsApp channel up (primary) — webhook at POST /hooks/whatsapp.");
}
