import crypto from "crypto";
import { config } from "./config.js";

/* ---------- password hashing (scrypt, built-in) ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}

/* ---------- AES-256-GCM for stored email credentials ---------- */
const key = crypto.createHash("sha256").update(config.secret).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}
export function decrypt(blob) {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/* ---------- signed session tokens ---------- */
export function signSession(userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", config.secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
export function verifySession(token) {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", config.secret).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  try {
    const { u, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - t > 30 * 24 * 3600 * 1000) return null; // 30-day sessions
    return u;
  } catch {
    return null;
  }
}

export const randomCode = (len = 10) => crypto.randomBytes(len).toString("base64url").slice(0, len);
