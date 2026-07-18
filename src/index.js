import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import * as db from "./db.js";
import { apiRouter } from "./api.js";
import { startTelegramBot } from "./bot.js";
import { initWhatsApp } from "./whatsapp.js";
import { fetchNewEmailsFor, fetchForwardInbox } from "./mailer.js";
import { processIncoming, sendRoundupFor, wakeSnoozed, flushPending, checkSilence, sendWeeklyReport } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- web server ---------- */
const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/api", apiRouter());
initWhatsApp(app);

app.use(express.static(path.join(__dirname, "..", "public")));
app.listen(config.port, () => console.log(`Mailer platform up at ${config.baseUrl} (port ${config.port})`));

/* ---------- the one official bot ---------- */
startTelegramBot();

/* ---------- self-ping heartbeat (keeps free-tier host awake) ---------- */
if (config.baseUrl.startsWith("http") && !config.baseUrl.includes("localhost")) {
  setInterval(() => {
    fetch(config.baseUrl).catch(() => {});
  }, 30 * 1000);
}

/* ---------- inbox poll loop (all users) ---------- */
let polling = false;
async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const user of await db.usersWithInbox()) {
      const fresh = await fetchNewEmailsFor(user);
      for (const email of fresh) {
        console.log(`[user ${user.id}] New email: ${email.from} — ${email.subject}`);
        await processIncoming(user, email);
      }
    }
    // the shared forward-to-Mailer inbox
    for (const { user, email } of await fetchForwardInbox()) {
      console.log(`[user ${user.id}] Forwarded email: ${email.subject}`);
      await processIncoming(user, email);
    }
  } catch (e) {
    console.error("Poll error:", e.message);
  }
  polling = false;
}
setInterval(pollAll, config.pollSeconds * 1000);
pollAll();

/* ---------- snooze wakeups + mute-end flush ---------- */
setInterval(() => wakeSnoozed().catch(() => {}), 60 * 1000);
setInterval(() => flushPending().catch(() => {}), 60 * 1000);

/* ---------- silence catcher (hourly) ---------- */
setInterval(() => checkSilence().catch(() => {}), 60 * 60 * 1000);

/* ---------- weekly report (Sundays at digest hour) ---------- */
setInterval(async () => {
  const now = new Date();
  if (now.getDay() !== 0 || now.getHours() !== config.digestHour || now.getMinutes() !== 30) return;
  for (const user of await db.usersWithInbox()) {
    if (user.telegram_chat_id || user.whatsapp_number) await sendWeeklyReport(user);
  }
}, 60 * 1000);

/* ---------- daily digest per user ---------- */
setInterval(async () => {
  const now = new Date();
  if (now.getHours() !== config.digestHour) return;
  const day = now.toISOString().slice(0, 10);
  for (const user of await db.usersWithInbox()) {
    if (user.last_digest_day === day) continue;
    if (!user.telegram_chat_id && !user.whatsapp_number) continue;
    await db.setDigestDay(user.id, day);
    await sendRoundupFor(await db.userById(user.id));
  }
}, 60 * 1000);
