import "dotenv/config";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`,
  secret: req("SERVER_SECRET"),
  anthropicKey: req("ANTHROPIC_API_KEY"),
  model: "claude-sonnet-4-6",
  telegramToken: req("TELEGRAM_BOT_TOKEN"),
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || "MailerBot",
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || "",
    token: process.env.TWILIO_AUTH_TOKEN || "",
    from: process.env.TWILIO_WHATSAPP_FROM || "",
    enabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
  },
  pollSeconds: Number(process.env.POLL_SECONDS || 60),
  pushNormal: (process.env.PUSH_NORMAL || "true").toLowerCase() !== "false",
  digestHour: Number(process.env.DIGEST_HOUR || 8),
  nudgeDays: Number(process.env.NUDGE_DAYS || 3),

  // optional: voice-note transcription (OpenAI Whisper). Leave blank to disable.
  openaiKey: process.env.OPENAI_API_KEY || "",

  // optional: the shared "forward anything to MAILER" inbox. Leave blank to disable.
  forward: {
    user: process.env.FORWARD_MAIL_USER || "",
    password: process.env.FORWARD_MAIL_PASSWORD || "",
    imapHost: process.env.FORWARD_IMAP_HOST || "imap.gmail.com",
    imapPort: Number(process.env.FORWARD_IMAP_PORT || 993),
    enabled: !!(process.env.FORWARD_MAIL_USER && process.env.FORWARD_MAIL_PASSWORD),
  },
};
