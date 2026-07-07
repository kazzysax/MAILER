import { okx } from "./config.js";
import { payAndCall } from "./x402.js";
import { spend, spentToday } from "./ledger.js";

/*
Tier 2 — MAILER as a BUYER on OKX.AI.

When a suspicious email arrives, MAILER hires a scam-check agent (paying
automatically via x402) and flags the risk to the user. MAILER never
blocks mail — it informs; the user always decides.

Cheap pre-filter first so we don't pay to scan obviously-safe mail from
known contacts.
*/

const URGENT = /(urgent|verify|suspended|password|wire|gift card|bitcoin|crypto|prize|won|claim|billing|unusual activity|act now|limited time)/i;

function looksWorthChecking(email, knownSenders) {
  const from = (email.fromAddr || "").toLowerCase();
  if (knownSenders.has(from)) return false;          // trusted contact — skip
  const text = (email.subject || "") + " " + (email.body || "");
  if (URGENT.test(text)) return true;                 // scammy language
  if (/https?:\/\//.test(text) && !knownSenders.has(from)) return true; // link from stranger
  const domain = from.split("@")[1] || "";
  if (/\.(xyz|top|click|loan|zip|mov)$/.test(domain)) return true;
  return false;
}

/**
 * Returns null (not checked / safe) or { risk, reasons, txRef, price } to flag.
 * `knownSenders` is a Set of addresses the user has corresponded with.
 */
export async function maybeScamCheck(email, knownSenders = new Set()) {
  if (!okx.scamCheck.enabled) return null;
  if (!looksWorthChecking(email, knownSenders)) return null;

  try {
    const result = await payAndCall(
      okx.scamCheck.endpoint,
      { fromAddr: email.fromAddr, subject: email.subject, body: (email.body || "").slice(0, 2000) },
      { maxPrice: okx.scamCheck.maxPrice, spend }
    );
    if (typeof result.risk !== "number") return null;
    if (result.risk < 0.5) return null; // only flag meaningful risk
    return {
      risk: result.risk,
      reasons: result.reasons || [],
      txRef: result.txRef,
      provider: result.provider,
      price: okx.scamCheck.maxPrice,
    };
  } catch (e) {
    // cap reached, or network/settlement not available — fail open, never block mail
    console.error("Scam-check skipped:", e.message);
    return null;
  }
}

export function scamSpendStatus() {
  return spentToday();
}
