import path from "path";
import { fileURLToPath } from "url";
import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import * as db from "./db.js";
import { registerSender, onText, onAction } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "..", "public", "assets", "mailer-logo.jpeg");

export function startTelegramBot() {
  const bot = new TelegramBot(config.telegramToken, { polling: true });

  registerSender("telegram", async (chatId, text, options) => {
    const opts = {};
    if (options && options.length) {
      const rows = [];
      for (let i = 0; i < options.length; i += 3) {
        rows.push(options.slice(i, i + 3).map((o) => ({ text: o.label, callback_data: o.action })));
      }
      opts.reply_markup = { inline_keyboard: rows };
    }
    try {
      await bot.sendMessage(chatId, text, opts);
    } catch (e) {
      console.error("Telegram send failed:", e.message);
    }
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    // voice notes: transcribe -> treat the transcript as the user's message
    if (msg.voice || msg.audio) {
      const user = await db.userByChat(chatId);
      if (!user) return bot.sendMessage(chatId, `Link this chat first — sign up at ${config.baseUrl} and tap "Connect Telegram".`);
      const { voiceEnabled, transcribeTelegramVoice } = await import("./voice.js");
      if (!voiceEnabled()) {
        return bot.sendMessage(chatId, "🎤 I got your voice note, but transcription isn't enabled on this server yet — type it instead for now.");
      }
      try {
        const fileId = (msg.voice || msg.audio).file_id;
        const fileUrl = await bot.getFileLink(fileId);
        const transcript = await transcribeTelegramVoice(fileUrl);
        // too short/garbled to act on safely — ask instead of guessing
        if (!transcript || transcript.replace(/[^a-zA-Z0-9]/g, "").length < 3) {
          return bot.sendMessage(chatId, "I couldn't make that out clearly — say it again, or type it?");
        }
        await bot.sendMessage(chatId, `🎤 Heard: "${transcript}"\n(If that's wrong, just send it again — nothing happens without your approval.)`);
        // NOTE: transcripts are plain text ONLY — inline buttons can't be pressed by voice, so voice can never approve a send.
        return onText(user, transcript);
      } catch (e) {
        console.error("Telegram voice note failed:", e.message);
        return bot.sendMessage(chatId, "Couldn't process that voice note — type it instead?");
      }
    }

    const text = (msg.text || "").trim();
    if (!text) return;

    // magic link: /start CODE binds this chat to a dashboard account
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      if (code) {
        const userId = await db.consumeLinkCode(code);
        if (userId) {
          await db.setTelegramChat(userId, chatId);
          try { await bot.sendPhoto(chatId, LOGO_PATH); } catch (e) { console.error("Telegram sendPhoto failed:", e.message); }
          const user = await db.userById(userId);
          return onText(user, "/start");
        }
        return bot.sendMessage(chatId, "That link expired. Get a fresh one from your MAILER dashboard → Connect Telegram.");
      }
    }

    const user = await db.userByChat(chatId);
    if (!user) {
      return bot.sendMessage(chatId, `This chat isn't linked to an MAILER account yet.\n\nSign up at ${config.baseUrl}, connect your inbox, then tap "Connect Telegram" — it opens me with your personal link.`);
    }
    await onText(user, text);
  });

  bot.on("callback_query", async (q) => {
    try { await bot.answerCallbackQuery(q.id); } catch {}
    const user = await db.userByChat(q.message.chat.id);
    if (!user) return;
    await onAction(user, q.data);
  });

  console.log(`Telegram bot @${config.telegramBotUsername} up (shared, multi-user).`);
}
