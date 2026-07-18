# Mailer — Deployment Guide

Everything you need to take mailer-platform from zip file to live product.
Total time: ~30–45 minutes. Follow in order.

---

## 0. What you need before starting

| Item | Where | Time |
|---|---|---|
| Anthropic API key | console.anthropic.com → API Keys | 2 min |
| Telegram bot token | @BotFather in Telegram | 3 min |
| Twilio account (WhatsApp) | twilio.com → free account | 10 min |
| A host | Railway.app / Render.com / any VPS | 10 min |
| (Optional) OpenAI key | platform.openai.com — voice notes only | 2 min |
| (Optional) A Gmail for forward-to-Mailer | any Gmail with app password | 5 min |

---

## 1. Create the official Mailer Telegram bot

1. Open Telegram, search **@BotFather**, press Start
2. Send `/newbot`
3. Name: `Mailer` (display name, anything works)
4. Username: something ending in "bot", e.g. `MailerBot` or `mailer_ng_bot`
   — this must be unique on Telegram; keep trying until accepted
5. BotFather replies with a **token** like `7123456789:AAF...` — copy it
6. Optional polish: `/setdescription` → "Never miss an email. Your inbox in your chat." and `/setuserpic` with a logo

You need: **the token** and **the username** (without @).

---

## 2. Set up Twilio WhatsApp (sandbox — live today)

1. Sign up at twilio.com (free trial is fine)
2. Console → **Messaging → Try it out → Send a WhatsApp message**
3. You'll see the **sandbox number** (usually +1 415 523 8886) and a join
   code like `join brave-lion`
4. From YOUR WhatsApp, send that join code to the sandbox number once
5. From the Console dashboard, copy:
   - **Account SID** (starts with AC…)
   - **Auth Token**
6. LEAVE THIS TAB OPEN — after deploying (step 4) you'll come back to set
   the webhook URL.

Sandbox rule: every user must send the join code once before Mailer can
message them. The dashboard tells them this automatically.

Production WhatsApp (your own branded number, no join code, digests
outside the 24h window) = Meta business verification. Start it early at
business.facebook.com; the code needs zero changes when you switch.

---

## 3. Choose your host and deploy

### Option A — Railway (recommended: easiest, ~$5/mo)

1. Push the mailer-platform folder to a GitHub repo
   (make sure `.env` is NOT committed — only `.env.example`)
2. railway.app → New Project → **Deploy from GitHub repo** → pick it
3. Railway auto-detects Node. Confirm start command: `npm start`
4. **Add a Volume** (Storage tab): mount path `/app` — this is critical,
   it's where `mailer.db` lives. Without it, all users are wiped on
   every redeploy.
5. Settings → **Generate Domain** — copy the URL, e.g.
   `https://mailer-production.up.railway.app`
6. Variables tab → add every env var (see step 4 below)
7. Deploy. Check the logs for:
   `Mailer platform up at ... `
   `Telegram bot @YourBot up (shared, multi-user).`
   `WhatsApp channel up (primary) ...`

### Option B — Render

Same flow: New → Web Service → connect repo → start command `npm start`
→ add a **Persistent Disk** (mount `/opt/render/project/src`) → set env
vars → deploy. Free tier sleeps when idle — pushes stop while asleep, so
use a paid instance ($7/mo) for real use.

### Option C — VPS (DigitalOcean/Hetzner, ~$4–6/mo)

```bash
# on Ubuntu 24
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
git clone <your repo> && cd mailer-platform
cp .env.example .env && nano .env        # fill everything in
npm install
# keep it alive:
sudo npm i -g pm2
pm2 start src/index.js --name mailer
pm2 save && pm2 startup
```
Put nginx or Caddy in front for HTTPS (Caddy is 2 lines of config), or
use Cloudflare Tunnel. HTTPS is required for the Twilio webhook.

Requirement everywhere: **Node 22+** (uses built-in node:sqlite).
Run ONE instance only — the Telegram bot uses long polling; two
instances will conflict.

---

## 4. Environment variables (all hosts)

```
PORT=8080                     # Railway/Render inject their own; keep 8080 for VPS
BASE_URL=https://your-domain  # the public URL from step 3 — no trailing slash
SERVER_SECRET=<paste 40+ random characters>   # NEVER change after launch —
                                              # it encrypts user inbox passwords
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=7123456789:AAF...
TELEGRAM_BOT_USERNAME=MailerBot                # no @
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886    # your sandbox number
POLL_SECONDS=60
PUSH_NORMAL=true
DIGEST_HOUR=8                                 # server-local time! see note
NUDGE_DAYS=3

# optional — voice-note replies:
OPENAI_API_KEY=sk-...

# optional — forward-to-Mailer inbox:
FORWARD_MAIL_USER=inbox@yourdomain.com
FORWARD_MAIL_PASSWORD=<gmail app password, no spaces>
```

Generate a good SERVER_SECRET:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

TIMEZONE NOTE: digest hour and quiet hours run on the SERVER's clock.
Railway/Render default to UTC. Nigeria is UTC+1, so for an 8am Lagos
digest set `DIGEST_HOUR=7`, or set the service's TZ env var to
`Africa/Lagos` and keep 8.

---

## 5. Point the Twilio webhook at your server

Back in the Twilio sandbox settings (step 2 tab):
- **"When a message comes in"** →
  `https://<your-domain>/hooks/whatsapp`  — method **POST**
- Save.

Without this, Mailer can send WhatsApp messages but never hears replies.

---

## 6. First-hour smoke test (run ALL of it, in order)

1. Open `BASE_URL` → the Mailer landing page loads
2. Sign up with a real email + password
3. Connect a Gmail inbox:
   - Google account → 2-Step Verification ON
   - myaccount.google.com/apppasswords → create one
   - paste WITHOUT spaces (Mailer will reject spaces and tell you)
   - expect: "Inbox connected"
4. Tap **Connect WhatsApp** → WhatsApp opens pre-filled → send it
   → expect the Mailer welcome message
   (sandbox: send the join code first if you haven't)
5. Tap **Connect Telegram** → bot opens → press START → welcome message
6. From ANOTHER email account, send a test email to the connected inbox
   with the word "invoice" in the subject
7. On the dashboard, add rule: keyword "invoice" → High
8. Within ~60s: 🔴 HIGH push arrives on WhatsApp with summary + options
9. Reply with the number for "Draft reply" → send an instruction like
   "short and friendly, confirm receipt" → review draft → approve
10. Check the other email account: real reply arrived, threaded
11. Try: /find invoice · /mute 21 7 · /report · a voice note (if key set)
12. /roundup → digest arrives

If all 12 pass, Mailer is live. 🎉

---

## 7. Common problems → fixes

| Symptom | Cause | Fix |
|---|---|---|
| "polling_error 409 Conflict" in logs | Two instances running, or old one still alive | Kill all but one instance |
| Telegram bot silent | Wrong token, or user never pressed START via the magic link | Regenerate link from dashboard |
| WhatsApp sends but never responds | Webhook not set (step 5) | Set webhook URL, POST |
| WhatsApp fully silent for a user | They never sent the sandbox join code | Send join code to sandbox number |
| "Could not connect to that inbox" | Normal password used, or 2FA off, or spaces | App Password, no spaces |
| Emails detected but no push | No chat linked yet, or quiet hours on | Link a channel; check /mute |
| Everything wiped after redeploy | No persistent volume | Add volume (step 3) — users must re-sign-up once, sorry |
| Digest at weird hour | Server on UTC | TZ=Africa/Lagos or adjust DIGEST_HOUR |
| Voice notes "not enabled" | No OPENAI_API_KEY | Add it, redeploy |

---

## 8. Going to production scale (later)

- WhatsApp: complete Meta business verification → swap sandbox creds for
  production number creds. Zero code changes.
- Auth: add "Sign in with Google" via Clerk/Firebase (roadmap).
- Inbox OAuth: Google verification or Nylas/Unipile (roadmap).
- Backups: `mailer.db` is one file — cron-copy it somewhere daily.
- Scale: SQLite + sequential polling is comfortable to ~hundreds of
  users; beyond that, parallelize the poll loop and consider Postgres.

## Security checklist before inviting real users
- [ ] HTTPS on (automatic on Railway/Render; Caddy/Cloudflare on VPS)
- [ ] SERVER_SECRET is long, random, backed up, and never changes
- [ ] .env not in git
- [ ] Volume/disk attached and confirmed persisting across a redeploy
- [ ] Twilio Auth Token kept secret (it can send messages as you)
