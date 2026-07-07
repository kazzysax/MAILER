# MAILER Tier 1 — Mainnet-Standard Seller Layer

This document cross-checks every file involved in MAILER's **live, real-money**
ASP layer (Tier 1 — MAILER selling `mailer.triage`, `mailer.draft_reply`,
`mailer.fill_template`) and gives exact deployment steps to go live on
X Layer mainnet.

**Scope note:** this covers the SELLER side only (MAILER earning). Tier 2
(MAILER hiring other agents, e.g. the scam-check) intentionally remains on
the mock/testnet demo path — see `OKX.md`. Nothing here changes that.

---

## What "mainnet standard" means here — the honest technical claim

Payment verification is no longer a locally-signed voucher. When
`OKX_NETWORK=testnet` or `mainnet`, MAILER:

1. Issues a real HTTP 402 quoting the exact USDT contract, amount, and
   MAILER's wallet address on X Layer (chain id 196).
2. Requires the caller to actually send that USDT onchain and supply the
   **transaction hash** as proof.
3. Reads the transaction receipt directly from X Layer via JSON-RPC
   (`eth_getTransactionReceipt`), decodes the standard ERC-20
   `Transfer(address,address,uint256)` event log, and confirms:
   - the transaction succeeded onchain (not just broadcast — mined and status 1)
   - the token contract matches USDT
   - the recipient is MAILER's own wallet address
   - the amount transferred is at least the quoted price
4. Records the transaction hash in a database table
   (`used_payments`, primary-keyed on tx hash) so **the same payment can
   never be reused across two different calls** — the insert itself is the
   atomic guard against a race between two simultaneous requests replaying
   one payment.

No web3/ethers library is used — the RPC calls and log decoding are
implemented directly against X Layer's JSON-RPC interface, which keeps the
dependency surface small and auditable.

This was verified in this session against a simulated X Layer RPC node
returning realistic transaction receipts: a genuine payment is accepted and
the real payer address is recovered from the chain; an underpaid transfer,
a transfer to the wrong address, a failed transaction, and a malformed
hash are all correctly rejected; and replaying the same valid transaction
against a second call is blocked. See the "What was tested" section below
for the exact scenarios run.

---

## File inventory — Tier 1 (seller / mainnet-standard)

| File | Role |
|---|---|
| `src/okx/config.js` | All OKX/chain configuration: wallet, network, prices, RPC URL, USDT contract, confirmation threshold |
| `src/okx/chain.js` | **New.** Real X Layer RPC client — reads transaction receipts, decodes ERC-20 Transfer events, fetches token decimals, no external library |
| `src/okx/x402.js` | `requirePayment` middleware — mock voucher path (dev) **and** mainnet-grade onchain verification path (testnet/mainnet), selected automatically by `OKX_NETWORK` |
| `src/okx/services.js` | The three paid services (`/asp/triage`, `/asp/draft_reply`, `/asp/fill_template`) and the public `/asp/manifest` |
| `src/db.js` | Added `used_payments` table + `isTxUsed`/`markTxUsed` helpers — the persistent, atomic replay guard |
| `src/index.js` | Mounts the ASP services and exposes `/asp/status` (live earnings meter) |
| `.env.example` | All required variables, including the new `XLAYER_RPC_URL`, `USDT_CONTRACT_ADDRESS`, `MIN_CONFIRMATIONS` |

Not part of this mainnet upgrade (left as-is, demo/testnet only):
`src/okx/scamcheck.js`, `src/okx/mockAsp.js`, and the client half of
`src/okx/x402.js` (`payAndCall`, `settleOnchain`) — these are Tier 2, hiring.

---

## Real chain facts used (verified July 2026)

| Item | Value |
|---|---|
| Network | X Layer (OKX's L2) |
| Chain ID | 196 (`0xC4`) |
| Official RPC | `https://rpc.xlayer.tech` (alt: `https://xlayerrpc.okx.com`) |
| Gas token | OKB (only needed if MAILER ever pays gas itself — Tier 1 doesn't; buyers pay their own gas to send USDT) |
| USDT contract (legacy, in default use) | `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` |
| USDT0 (newer canonical standard, optional) | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` |
| Explorer | `https://www.oklink.com/x-layer` |

To use USDT0 instead of legacy USDT, just set `USDT_CONTRACT_ADDRESS` to
the USDT0 address — the verification code is token-address-agnostic; it
fetches decimals live and checks whichever contract you configure.

---

## Deployment — going live on mainnet

This assumes the platform is already deployed per `DEPLOY.md` (hosting,
Telegram, WhatsApp, database). This section is additive — just the ASP
layer.

### 1. Create and fund MAILER's Agentic Wallet
In your Claude Code / OpenClaw session with the OnchainOS skill installed:
- Create an Agentic Wallet for MAILER. Note its address.
- Send a small amount of USDT to it on X Layer (a few dollars covers
  thousands of incoming payments — MAILER doesn't spend from this wallet
  in Tier 1, it only receives).
- MAILER doesn't need OKB — it never sends a transaction itself in Tier 1;
  it only verifies transactions buyers send.

### 2. Set the mainnet environment variables
```
OKX_NETWORK=mainnet
OKX_WALLET_ADDRESS=0x...           # MAILER's Agentic Wallet address
OKX_WALLET_KEY=                    # not used for verification; leave blank
                                    # or omit — Tier 1 never signs anything
OKX_TOKEN=USDT
OKX_CHAIN_ID=196
XLAYER_RPC_URL=https://rpc.xlayer.tech
USDT_CONTRACT_ADDRESS=0x1E4a5963aBFD975d8c9021ce480b42188849D41d
MIN_CONFIRMATIONS=1                # raise to 3-6 if you want extra reorg safety
PRICE_TRIAGE=0.005
PRICE_DRAFT=0.02
PRICE_FILL=0.02
```
Redeploy / restart the service.

### 3. Verify it's live
```
curl https://<your-domain>/asp/manifest
curl https://<your-domain>/asp/status
```
`status.live` should read `true`, `status.wallet` should show your real
wallet address, `status.network` should read `mainnet`.

### 4. Confirm the 402 challenge is correct
```
curl -X POST https://<your-domain>/asp/triage \
  -H "content-type: application/json" \
  -d '{"subject":"test","body":"hello"}'
```
Expect a `402` with your real wallet address as `payTo` and the real
USDT contract as `contract`.

### 5. Register with OKX.AI
Through your OnchainOS agent session:
> Register my service "MAILER" as an A2MCP ASP on OKX.AI.
> Manifest: https://your-domain/asp/manifest
> Services: mailer.triage ($0.005), mailer.draft_reply ($0.02),
> mailer.fill_template ($0.02) — payment token USDT on X Layer (chain 196),
> wallet <your address>.

### 6. Do one real end-to-end payment test
From any wallet holding a little X Layer USDT, send exactly the quoted
`amount` to MAILER's `payTo` address, get the transaction hash, then:
```
curl -X POST https://<your-domain>/asp/triage \
  -H "content-type: application/json" \
  -H "x-payment: $(echo -n '{"txHash":"0xYOUR_REAL_TX_HASH"}' | base64)" \
  -d '{"subject":"Overdue invoice","body":"Please pay $500 by Friday"}'
```
Expect a `200` with the real triage result and your wallet address as
`paidBy`. Check `/asp/status` — `seller.earned` and `seller.calls` should
have incremented. That's a genuine, verifiable, mainnet payment.

---

## What was tested (this session, before packaging)

Run against a simulated X Layer RPC node returning realistic
`eth_getTransactionReceipt` and `eth_call` (decimals) responses, so the
decode logic is exercised exactly as it will run in production, with no
dependency on live network access:

| Scenario | Result |
|---|---|
| Genuine payment, correct recipient and amount | **Accepted** — payer address correctly recovered from the chain |
| Underpaid transfer (amount below quote) | **Rejected** |
| Transfer to the wrong address (not MAILER's wallet) | **Rejected** |
| Transaction that failed onchain (status 0) | **Rejected** |
| Malformed / garbage transaction hash | **Rejected before any RPC call** |
| Full HTTP round trip: unpaid → 402 → paid with real tx hash → 200 | **Passes**, quote includes the real USDT contract address |
| Replaying the exact same valid payment against a second call | **Blocked** (402, "already used") |

What could not be tested from this environment: an actual broadcast to
X Layer mainnet/testnet (outbound network access here is restricted to a
package-registry allowlist and doesn't include `rpc.xlayer.tech`). The RPC
client code is standard JSON-RPC over HTTPS and requires no special
handling once deployed somewhere with normal internet egress — the fake-RPC
test above exercises the exact same code path that will run against the
real endpoint.

---

## Safety properties, mainnet mode

- **No trust in the caller's claims** — every price, recipient, and amount
  is independently confirmed by reading the chain, never taken from the
  request body.
- **Replay-proof** — one payment, one call, enforced by a database primary
  key, safe under concurrent requests.
- **No private key exposure risk in Tier 1** — the seller side only *reads*
  the chain; it never signs or holds funds programmatically, so there's no
  hot-wallet-drain surface for this half of the system.
- **Configurable confirmation depth** — `MIN_CONFIRMATIONS` lets you trade
  off latency vs. reorg safety; 1 is fine for X Layer's sub-2-second
  finality in normal operation, raise it if you want extra margin.
