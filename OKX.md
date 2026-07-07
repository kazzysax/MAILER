# MAILER on OKX.AI — ASP Layer (Tiers 1 & 2)

MAILER runs a full economic loop on OKX.AI: it **earns** USDT selling inbox
services (Tier 1) and **spends** USDT hiring a scam-check agent (Tier 2).
Both use x402 (HTTP-native payments). The code is network-agnostic —
`OKX_NETWORK=mock` runs the whole loop locally for the demo; testnet/mainnet
carry real settlement.

## The two tiers

**Tier 1 — SELLER (goes live, real income).** MAILER exposes three paid
services other agents call:
| Service | Endpoint | Price (USDT) | Returns |
|---|---|---|---|
| mailer.triage | POST /asp/triage | 0.005 | priority, summary, action |
| mailer.draft_reply | POST /asp/draft_reply | 0.02 | drafted reply |
| mailer.fill_template | POST /asp/fill_template | 0.02 | filled template |

Manifest (what OKX lists): `GET /asp/manifest`. Live meter: `GET /asp/status`.

**Tier 2 — BUYER (demo on testnet, futuristic at scale).** When a
suspicious email arrives, MAILER hires a scam-check agent, paying via x402,
and flags the risk in your chat (⚠️ POSSIBLE SCAM). It never blocks mail —
it informs; you decide. A reference scam-check ASP is bundled
(`/mock-asp/scan`) so the full buyer loop runs live without depending on an
external agent. At scale, point `SCAM_CHECK_ENDPOINT` at a real security ASP
(e.g. CertiK on OKX.AI) — MAILER's code doesn't change.

## Safety
- **Daily spend cap** (`SCAM_CHECK_DAILY_CAP`, default $1) — MAILER will never
  pay out more than this per day hiring agents. Cap hit → it stops paying,
  mail still flows.
- **maxPrice** per call — MAILER refuses any quote above what it's willing to pay.
- **Pre-filter** — known/trusted senders are never scanned, so you don't pay
  to check safe mail. Only unknown senders with scam signals get checked.
- **One-time nonces + signature checks** on the seller side — no replay, no forged payment.

## Environment (add to .env)
```
OKX_NETWORK=mock                 # mock | testnet | mainnet
OKX_WALLET_ADDRESS=              # MAILER's Agentic Wallet (from OnchainOS)
OKX_WALLET_KEY=                  # its signing key — SECRET, never commit
OKX_TOKEN=USDT
OKX_CHAIN_ID=196                 # X Layer mainnet
PRICE_TRIAGE=0.005
PRICE_DRAFT=0.02
PRICE_FILL=0.02
SCAM_CHECK_ENABLED=true
SCAM_CHECK_ENDPOINT=             # blank = bundled mock; or a real ASP URL
SCAM_CHECK_MAX_PRICE=0.002
SCAM_CHECK_DAILY_CAP=1.0
```

## Going live on OKX.AI (you, once)

1. **Create MAILER's Agentic Wallet.** In Claude Code / OpenClaw:
   ```
   plugin-store install okxai        # OnchainOS skill
   ```
   Then tell the agent: *"Create an Agentic Wallet for my ASP called MAILER."*
   Copy the wallet address + signing key into `.env` (OKX_WALLET_*).

2. **Fund it.** Send a few USDT to the wallet on X Layer. ~$2 covers hundreds
   of demo calls. (Tier 1 earns it back.)

3. **Register MAILER as an A2MCP ASP.** Tell the OKX agent:
   > Register my service "MAILER" as an A2MCP ASP on OKX.AI.
   > Services and prices:
   > - mailer.triage — $0.005/call — POST https://<your-domain>/asp/triage
   > - mailer.draft_reply — $0.02/call — POST https://<your-domain>/asp/draft_reply
   > - mailer.fill_template — $0.02/call — POST https://<your-domain>/asp/fill_template
   > Payment token USDT on X Layer. Manifest at https://<your-domain>/asp/manifest.

4. **Set `OKX_NETWORK=testnet`** (or mainnet) and redeploy. MAILER is live.

5. **Submit the hackathon Google form** before **July 17, 2026 23:59 UTC**
   with your ASP details + the X post link (#OKXAI).

## Demo script (what to show judges)

1. **Manifest** — open `/asp/manifest`: MAILER's three services listed, priced,
   with its wallet address. "MAILER is a registered ASP."
2. **Tier 1 earning (live):** run the paid call — 402 challenge → pay → result.
   Show `/asp/status` earnings tick up. "MAILER earns real USDT per call."
3. **Tier 2 hiring (live loop):** send yourself a phishing email. In WhatsApp,
   the push arrives with **⚠️ POSSIBLE SCAM (risk 100%)**. Explain: MAILER
   just paid a security agent $0.002 via x402 to check that sender —
   automatically, no popup, in seconds. Show `/asp/status` buyer spend tick up.
4. **The loop:** "Every email MAILER touches is one or two onchain
   transactions — MAILER is both a buyer and a seller on OKX.AI."
5. **Futuristic (labeled roadmap):** the same buyer loop extends to invoice
   verification, contract review, sender reputation — any specialist ASP.
   One config line each.

## What's real vs. demo (be honest — it lands well)
- **Real & live:** ASP registration, Tier 1 paid services earning USDT, the
  full x402 protocol both directions, scam detection, spend caps.
- **Demo/testnet:** the scam-check counterparty is MAILER's bundled reference
  agent (identical protocol to a production ASP; swap one URL for real).
- **Roadmap:** the wider marketplace of specialist agents MAILER hires.
