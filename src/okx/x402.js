import crypto from "crypto";
import { okx } from "./config.js";
import { verifyUsdtPayment } from "./chain.js";
import * as db from "../db.js";

/*
x402 — HTTP-native payments (the OKX AI / Coinbase standard).

SELLER SIDE (Tier 1, requirePayment below) has two verification modes:

  - okx.network === "mock"    : local HMAC-signed voucher (protocol-shape
                                 only, no chain — dev/demo use)
  - okx.network === "testnet"
    or "mainnet"              : MAINNET-GRADE. Proof is a real transaction
                                 hash. We read X Layer via RPC, decode the
                                 ERC-20 Transfer event, and confirm a genuine
                                 USDT payment of at least the quoted amount
                                 landed in MAILER's wallet. Each tx hash can
                                 be spent exactly once (DB-enforced, atomic).

BUYER SIDE (Tier 2, MAILER hiring another agent) is intentionally left on
the mock/testnet demo path below and is not covered by this mainnet upgrade.
*/

/* ---------------- mock-mode voucher helpers (dev/demo only) ---------------- */
function signVoucher(payload) {
  const key = okx.walletKey || "dev-mock-key";
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", key).update(body).digest("hex");
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64");
}
function verifyVoucher(proofB64, expect) {
  try {
    const proof = JSON.parse(Buffer.from(proofB64, "base64").toString());
    const key = okx.walletKey || "dev-mock-key";
    const { sig, ...payload } = proof;
    const good = crypto.createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
    if (sig !== good) return { ok: false, reason: "bad signature" };
    if (payload.amount < expect.amount) return { ok: false, reason: "underpaid" };
    if (payload.token !== expect.token) return { ok: false, reason: "wrong token" };
    if (payload.nonce !== expect.nonce) return { ok: false, reason: "nonce mismatch" };
    return { ok: true, payer: payload.payer, txRef: payload.txRef || "mock" };
  } catch {
    return { ok: false, reason: "malformed proof" };
  }
}

/* =====================================================================
   SERVER SIDE (Tier 1) — charge other agents for MAILER services
   ===================================================================== */

// pending challenges: nonce -> {amount, token, service, createdAt}  (mock mode only)
const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [n, c] of challenges) if (now - c.createdAt > 5 * 60 * 1000) challenges.delete(n);
}, 60 * 1000);

/**
 * Express middleware factory: require payment of `amount` USDT before the
 * handler runs. Attaches req.payment = { payer, txRef, amount } on success.
 */
export function requirePayment(amount, serviceName = "mailer-service") {
  return async (req, res, next) => {
    const proof = req.headers["x-payment"];
    const mainnetGrade = okx.network === "testnet" || okx.network === "mainnet";

    if (!proof) {
      const nonce = crypto.randomBytes(12).toString("hex");
      challenges.set(nonce, { amount, token: okx.token, service: serviceName, createdAt: Date.now() });
      res.status(402).json({
        error: "Payment Required",
        x402: {
          amount,
          token: okx.token,
          chainId: okx.chainId,
          payTo: okx.walletAddress || "0mailerER_WALLET_NOT_SET",
          contract: mainnetGrade ? okx.usdtContract : undefined,
          nonce,
          proofFormat: mainnetGrade
            ? "base64 JSON { txHash } \u2014 a real USDT transfer to payTo on X Layer for at least `amount`"
            : "base64 JSON { amount, token, nonce, payer, sig } (mock voucher \u2014 dev only)",
          note: "Pay then retry with header X-Payment: <proof>",
        },
      });
      return;
    }

    /* ---------------- MAINNET-GRADE PATH ---------------- */
    if (mainnetGrade) {
      let payload;
      try {
        payload = JSON.parse(Buffer.from(proof, "base64").toString());
      } catch {
        return res.status(400).json({ error: "Malformed X-Payment proof" });
      }
      const txHash = payload.txHash;
      if (!txHash) return res.status(400).json({ error: "X-Payment proof must include a txHash" });

      if (db.isTxUsed(txHash)) {
        return res.status(402).json({ error: "This payment has already been used for a previous call." });
      }

      try {
        const verified = await verifyUsdtPayment(txHash, okx.walletAddress, amount);
        // atomic claim: DB primary key prevents a concurrent second request
        // from double-spending the same tx between verify and here
        db.markTxUsed(txHash, serviceName, amount, verified.from);
        req.payment = { payer: verified.from, txRef: txHash, amount };
        return next();
      } catch (e) {
        if (String(e.message).includes("UNIQUE constraint")) {
          return res.status(402).json({ error: "This payment has already been used for a previous call." });
        }
        return res.status(402).json({ error: "Payment invalid: " + e.message });
      }
    }

    /* ---------------- MOCK PATH (dev/demo only) ---------------- */
    let payload;
    try {
      payload = JSON.parse(Buffer.from(proof, "base64").toString());
    } catch {
      return res.status(400).json({ error: "Malformed X-Payment proof" });
    }
    const challenge = challenges.get(payload.nonce);
    if (!challenge) return res.status(402).json({ error: "Unknown or expired payment nonce \u2014 request a fresh 402." });
    const v = verifyVoucher(proof, { amount: challenge.amount, token: challenge.token, nonce: payload.nonce });
    if (!v.ok) return res.status(402).json({ error: "Payment invalid: " + v.reason });
    challenges.delete(payload.nonce); // one-time use
    req.payment = { payer: v.payer, txRef: v.txRef, amount: challenge.amount };
    next();
  };
}

/* =====================================================================
   CLIENT SIDE (Tier 2) — MAILER pays to hire another agent
   ===================================================================== */

/**
 * Call an x402-protected endpoint, paying automatically if challenged.
 * Enforces maxPrice. Returns the JSON result, or throws.
 * `spend(amount)` is a callback to record/enforce the daily cap; it should
 * throw if the cap would be exceeded.
 */
export async function payAndCall(endpoint, payload, { maxPrice, spend }) {
  const withTimeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };

  // first attempt (unpaid)
  let res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: withTimeout(8000),
  });

  if (res.status === 402) {
    const body = await res.json();
    const q = body.x402 || {};
    if (q.amount > maxPrice) throw new Error(`Quote ${q.amount} ${q.token} exceeds max ${maxPrice}`);

    // enforce daily cap (throws if exceeded) — before paying
    spend(q.amount);

    // "pay": mock mode -> signed voucher; onchain -> settle then reference tx
    const proof = signVoucher({
      amount: q.amount,
      token: q.token,
      nonce: q.nonce,
      payer: okx.walletAddress || "0mailerER_DEV",
      txRef: okx.network === "mock" ? "mock" : await settleOnchain(q),
    });

    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body: JSON.stringify(payload),
      signal: withTimeout(8000),
    });
  }

  if (!res.ok) throw new Error(`Hired agent returned ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

/**
 * Real onchain settlement placeholder. On testnet/mainnet this signs and
 * broadcasts a USDT transfer to q.payTo for q.amount using okx.walletKey,
 * and returns the tx hash. Kept isolated so the rest of the code is
 * network-agnostic. Wired to the OnchainOS payment SDK at go-live.
 */
async function settleOnchain(q) {
  // Intentionally not broadcasting from this environment.
  // At go-live: use OnchainOS/Agent Payments SDK to send q.amount USDT to q.payTo.
  throw new Error("Onchain settlement runs via OnchainOS at go-live; use OKX_NETWORK=mock for local demo.");
}
