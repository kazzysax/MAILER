# Mailer Platform (v2) — hosted, multi-user

One server = the Mailer website + dashboard + the one official Telegram bot + WhatsApp routing + per-user inbox watching. Users onboard entirely from the site: sign up → connect inbox → set rules/templates → one tap to connect Telegram or WhatsApp. Nobody except you ever touches BotFather or Twilio.

## User flow (what your customers experience)

1. Land on your Mailer site → sign up (email + password)
2. Connect their inbox (Gmail App Password or any IMAP) — verified live before saving
3. Set priority rules and reply templates on the dashboard
4. Tap **Connect WhatsApp** (primary) → WhatsApp opens with their personal link message pre-filled → hit send → bound. Emails start flowing to their chat with summaries, actions and numbered options. (Sandbox users send the Twilio join code once first; production numbers skip that.)
5. Or/also tap **Connect Telegram** → opens the official Mailer bot with a magic link → press START → bound (with inline buttons).

If a user links both, Mailer delivers to WhatsApp first.

Replies are always: user asks → Mailer drafts → user approves → sent from *their own* email address.

## Operator setup (you, once)

### 1. Create the one official bot
- Telegram → **@BotFather** → `/newbot` → name it (e.g. Mailer) → username (e.g. `MailerBot`)
- Put the token in `TELEGRAM_BOT_TOKEN` and the username in `TELEGRAM_BOT_USERNAME`

### 2. Configure
```bash
cp .env.example .env
```
Fill in: `ANTHROPIC_API_KEY`, `SERVER_SECRET` (long random string — never change it after launch, it encrypts user inbox credentials), bot token + username, and `BASE_URL` (your public URL).

### 3. Run
```bash
npm install
npm start
```
Requires Node 22+ (uses the built-in `node:sqlite` — zero native builds, deploys anywhere).

### 4. Deploy for real (always-on)
Any Node host works — Railway, Render, Fly.io, or a small VPS:
- Set the env vars from `.env` in the host's dashboard
- Set `BASE_URL` to your public URL
- Persist the working directory (contains `mailer.db`) — on Railway/Render attach a volume
- One instance only (the bot uses long polling; two instances would conflict)

### 5. WhatsApp (optional)
- Twilio account → Messaging → WhatsApp sandbox (works today) or production number (after Meta business verification)
- Fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- In Twilio, set the inbound webhook to `POST {BASE_URL}/hooks/whatsapp`
- Sandbox users must send the join code to the sandbox number once (the dashboard tells them)

## In-chat commands
```
/roundup   /open   /find <words>   /report
/mute 21 7   /mute off
/rules   /addrule keyword invoice high   /delrule <id>
/templates   /addtemplate
/team add <email>   /team remove <email>   /team list
/cancel   /help
```

## Feature notes

- **Voice-note replies (WhatsApp AND Telegram):** send a voice note instead of typing your reply instruction — Mailer transcribes it and drafts. Requires `OPENAI_API_KEY` in `.env` (Whisper); politely declines if not set.
- **Quiet hours:** `/mute 21 7` or set on the dashboard. Pushes queue during mute and arrive as a "🌙 While you were away" batch when it ends.
- **Silence catcher:** every reply Mailer sends is watched; if the other side stays quiet for `NUDGE_DAYS` (default 3), you get "Still silent — draft a nudge?" with one-tap follow-up (approval-gated like everything else).
- **Team inboxes:** `/team add staff@biz.com` (they need an Mailer account with a linked chat). Your pushes fan out to the whole team with a 🙋 Claim button; claims are announced so two people never answer the same customer. Team replies go out from *your* address using *your* templates.
- **Search:** `/find acme invoice` returns matching emails with full action buttons.
- **Weekly report:** Sundays after the digest — emails processed, handled, replies sent, busiest senders. Also `/report` anytime.
- **Forward-to-Mailer:** set the `FORWARD_MAIL_*` vars to a dedicated inbox (e.g. `inbox@yourdomain.com`). Any signed-up user can forward an email there from their registered address and it's processed to their chat instantly — zero-setup way to try Mailer.

## Architecture
```
src/index.js     boot: web server + bot + poll loop + schedulers
src/api.js       REST API: auth, inbox connect (live IMAP verify), rules, templates, magic links
src/bot.js       the shared Telegram bot; /start CODE binds chat → account
src/whatsapp.js  shared Twilio number; inbound routed by sender number
src/engine.js    per-user brain: pushes, buttons, reply flows, roundup, snooze
src/mailer.js    per-user IMAP fetch + SMTP send (credentials AES-encrypted at rest)
src/ai.js        Claude calls: analyze, draft, fill template, roundup
src/rules.js     the rules engine
src/db.js        node:sqlite schema + helpers (multi-tenant)
src/crypto.js    scrypt passwords, AES-GCM creds, HMAC sessions
public/          the dashboard site
```

## Security notes
- User inbox passwords are AES-256-GCM encrypted with `SERVER_SECRET`; user account passwords are scrypt-hashed
- Sessions are HMAC-signed httpOnly cookies (30 days)
- The bot only answers chats bound to an account; WhatsApp only answers registered numbers
- Nothing is ever sent without explicit user approval
- Serve behind HTTPS in production (Railway/Render/Fly give you this automatically)
