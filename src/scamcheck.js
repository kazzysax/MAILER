import { config } from "./config.js";

/*
Scam-risk scoring for incoming mail. MAILER never blocks a message — it
flags the risk and lets the user decide. Cheap pre-filter first so we
don't run the full check on obviously-safe mail, and known/trusted
senders are skipped entirely so real correspondents never get flagged.
*/

const URGENT = /(urgent|verify your account|suspended|reset your password|wire transfer|gift card|bitcoin|crypto wallet|prize|you have won|claim your prize|billing|unusual activity|act now|limited time|update your payment)/i;

const SUSPICIOUS_TLDS = [".xyz", ".top", ".click", ".loan", ".work", ".zip", ".mov", ".gq", ".tk", ".ml"];

const SCAM_PHRASES = [
  "verify your account", "click here", "urgent", "wire transfer", "gift card",
  "bitcoin", "crypto wallet", "suspended", "confirm your password", "act now",
  "you have won", "claim your prize", "unusual activity", "update your billing",
  "limited time", "send payment", "reset your password", "invoice attached",
  "restricted access", "unusual sign-in", "verify your identity", "final notice",
];

// widely-impersonated brands: if the display name claims one of these, the
// sending domain must actually belong to it — otherwise that's a strong signal
const IMPERSONATED_BRANDS = {
  paypal: ["paypal.com"],
  amazon: ["amazon.com"],
  apple: ["apple.com", "icloud.com"],
  microsoft: ["microsoft.com", "outlook.com", "live.com"],
  netflix: ["netflix.com"],
  dhl: ["dhl.com"],
  fedex: ["fedex.com"],
  ups: ["ups.com"],
  facebook: ["facebook.com", "meta.com"],
  instagram: ["instagram.com"],
  linkedin: ["linkedin.com"],
  coinbase: ["coinbase.com"],
  binance: ["binance.com"],
  chase: ["chase.com"],
  "wells fargo": ["wellsfargo.com"],
};

const DANGEROUS_EXT = /\.(exe|scr|js|vbs|bat|cmd|jar|msi|lnk)$/i;
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|jpe?g|png)\.(exe|scr|js|vbs|bat|cmd)$/i;

function impersonatedBrand(displayName) {
  const d = displayName.toLowerCase();
  return Object.keys(IMPERSONATED_BRANDS).find((brand) => d.includes(brand)) || null;
}

function looksWorthChecking(email, knownSenders) {
  const from = (email.fromAddr || "").toLowerCase();
  if (knownSenders.has(from)) return false; // trusted contact — skip
  const text = (email.subject || "") + " " + (email.body || "");
  if (URGENT.test(text)) return true; // scammy language
  if (/https?:\/\//.test(text)) return true; // has a link
  const domain = from.split("@")[1] || "";
  if (SUSPICIOUS_TLDS.some((t) => domain.endsWith(t))) return true;
  if (impersonatedBrand(email.from || "")) return true;
  if ((email.attachments || []).some((a) => DANGEROUS_EXT.test(a) || DOUBLE_EXT.test(a))) return true;
  return false;
}

function scoreSender({ fromAddr = "", subject = "", body = "", from = "", attachments = [] }) {
  const fromLower = fromAddr.toLowerCase();
  const text = (subject + " " + body).toLowerCase();
  const domain = fromLower.split("@")[1] || "";
  let risk = 0;
  const reasons = [];

  if (SUSPICIOUS_TLDS.some((t) => domain.endsWith(t))) { risk += 0.3; reasons.push("sender domain uses a high-abuse TLD"); }
  if (/\d{4,}/.test(domain)) { risk += 0.15; reasons.push("numeric-heavy domain"); }

  const brand = impersonatedBrand(from);
  if (brand) {
    const realDomains = IMPERSONATED_BRANDS[brand];
    const matches = realDomains.some((d) => domain === d || domain.endsWith("." + d));
    if (!matches) {
      risk += 0.45;
      reasons.push(`sender name claims to be "${brand}" but the address isn't on ${brand}'s real domain`);
    }
  }

  if (/(support|billing|security|admin|verification)@/.test(fromLower) && domain.length > 15) {
    risk += 0.1; reasons.push("generic role-based sender on an unfamiliar domain");
  }

  const hits = SCAM_PHRASES.filter((p) => text.includes(p));
  if (hits.length) { risk += Math.min(0.5, hits.length * 0.16); reasons.push(`scam phrasing: ${hits.slice(0, 3).join(", ")}`); }

  if (/https?:\/\/[^\s]*(bit\.ly|tinyurl|t\.co|is\.gd|\.xyz|\.top|\.click)/.test(text)) { risk += 0.25; reasons.push("shortened/suspicious link"); }
  if (/attached (invoice|document|file)/.test(text) && hits.length) { risk += 0.1; reasons.push("payment lure with attachment"); }

  if (attachments.some((a) => DANGEROUS_EXT.test(a))) { risk += 0.45; reasons.push("attachment has an executable-style extension"); }
  else if (attachments.some((a) => DOUBLE_EXT.test(a))) { risk += 0.4; reasons.push("attachment uses a disguised double extension"); }

  if (subject && subject.length > 8 && subject === subject.toUpperCase() && /[A-Z]{6,}/.test(subject)) {
    risk += 0.08; reasons.push("subject line is all caps");
  }

  risk = Math.min(1, Number(risk.toFixed(2)));
  return { risk, reasons: reasons.length ? reasons : ["no strong signals"] };
}

/**
 * Returns null (not checked / safe) or { risk, reasons } to flag.
 * `knownSenders` — addresses the user has already corresponded with.
 * `trustedDomains` — domains the user has explicitly tracked as real
 * businesses (dashboard "Business" list) — never flagged, since a false
 * positive against a real sender is worse than missing a marginal one.
 */
export async function maybeScamCheck(email, knownSenders = new Set(), trustedDomains = new Set()) {
  if (!config.scamCheckEnabled) return null;
  const domain = (email.fromAddr || "").split("@")[1]?.toLowerCase();
  if (domain && trustedDomains.has(domain)) return null;
  if (!looksWorthChecking(email, knownSenders)) return null;

  const result = scoreSender({
    fromAddr: email.fromAddr, subject: email.subject, body: (email.body || "").slice(0, 2000),
    from: email.from, attachments: email.attachments || [],
  });
  if (result.risk < 0.5) return null; // only flag meaningful risk
  return result;
}
