import { createWalletClient, createPublicClient, http, keccak256, toHex, verifyMessage, encodeFunctionData, decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import * as db from "./db.js";

/*
On-chain status logging (Monad mainnet). Marking an email done or blocking a
sender only actually applies once its logStatus transaction is confirmed
on-chain (see applyConfirmedAction) — the signature is a gate, not a side
log. Either the server wallet signs automatically (auto-sign) or the user's
own connected wallet signs directly (see recordExternalTx). This module's
exported functions must never throw in a way that breaks the caller — a
chain failure should leave the local state simply unchanged, not crash it.
*/

export const EVENT_STATUS = { handled: 0, flagged: 1, blocked: 2 };

const ABI = [
  {
    type: "function",
    name: "logStatus",
    stateMutability: "nonpayable",
    inputs: [
      { name: "emailHash", type: "bytes32" },
      { name: "status", type: "uint8" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
];

const monad = {
  id: config.monad.chainId,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.monad.rpcUrl] } },
};

// reading (verifying a user-submitted tx) never needs the server's private key —
// only signing (submitLog, the auto-mode path) does.
const publicClient = createPublicClient({ chain: monad, transport: http(config.monad.rpcUrl) });

let walletClient = null;
if (config.monad.walletKey) {
  const account = privateKeyToAccount(config.monad.walletKey);
  walletClient = createWalletClient({ account, chain: monad, transport: http(config.monad.rpcUrl) });
}

export function isConfigured() {
  return !!(walletClient && config.monad.contractAddress);
}

export function explorerTxUrl(txHash) {
  return `${config.monad.explorerUrl}/tx/${txHash}`;
}

// keccak256 of "userId:emailId" — never the raw subject/sender/body, so nothing
// private ever touches a public chain.
export function hashEmail(userId, emailId) {
  return keccak256(toHex(`${userId}:${emailId}`));
}

/* ---------- the local action only takes effect once the transaction is actually
   confirmed on-chain — marking an email done or blocking a sender is gated on a
   real, mined signature, not just a button click. "flagged" needs nothing here:
   the scam flag itself is applied immediately/synchronously in engine.js's
   processIncoming since it's system-detected, not a user action to gate. ---------- */
async function applyConfirmedAction(logRowId) {
  const log = await db.chainLogById(logRowId);
  if (!log) return;
  if (log.eventType === "handled") {
    await db.updateEmail(log.emailId, { status: "done" });
  } else if (log.eventType === "blocked") {
    const email = await db.emailById(log.emailId);
    if (email?.fromAddr) await db.addBlacklist(log.userId, email.fromAddr.toLowerCase());
  }
}

/* ---------- one-time wallet-signed permission for automatic on-chain approval ----------
   The server wallet always does the actual signing/submitting (see submitLog below) — a
   plain EOA like Zerion or MetaMask can't sign transactions on our behalf without handing
   over its private key, which we never ask for. What the user's wallet CAN do is sign one
   free, gas-less off-chain message granting permission to skip the manual approve/skip
   prompt going forward. This message text is what's verified against that signature. */
export function buildAutoSignMessage(address) {
  return `Mailer on-chain auto-approve permission

I authorize Mailer's server wallet to automatically submit on-chain status
logs (Handled / Blocked / Flagged) on my behalf on Monad mainnet, without
asking me to approve each one, until I turn this off in Settings.

Wallet: ${address}`;
}

export async function verifyAutoSignSignature(address, signature) {
  try {
    return await verifyMessage({ address, message: buildAutoSignMessage(address), signature });
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget: signs + submits the log tx from Mailer's server wallet,
 * then updates the chain_logs row with the result. Never throws.
 */
export async function submitLog(logRowId, { userId, emailId, eventType, onBehalfOfAddress }) {
  if (!isConfigured()) {
    console.log(`[chain] not configured — skipping ${eventType} log for email ${emailId}`);
    await db.updateChainLog(logRowId, { status: "skipped" });
    return;
  }
  try {
    const emailHash = hashEmail(userId, emailId);
    const status = EVENT_STATUS[eventType];
    const onBehalfOf = onBehalfOfAddress || "0x0000000000000000000000000000000000000000";
    const hash = await walletClient.writeContract({
      address: config.monad.contractAddress,
      abi: ABI,
      functionName: "logStatus",
      args: [emailHash, status, onBehalfOf],
    });
    await db.updateChainLog(logRowId, { status: "submitted", txHash: hash });
    publicClient.waitForTransactionReceipt({ hash }).then(
      async () => { await db.updateChainLog(logRowId, { status: "confirmed" }); await applyConfirmedAction(logRowId); },
      () => db.updateChainLog(logRowId, { status: "failed" })
    );
    return hash;
  } catch (err) {
    console.error(`[chain] log failed for email ${emailId}:`, err.message);
    await db.updateChainLog(logRowId, { status: "failed" });
  }
}

/* ---------- manual mode: the user's own connected wallet signs directly ----------
   Mailer never touches the user's key here — the browser builds and sends the
   transaction itself via the wallet's own provider. These two helpers are just:
   (1) hand back the exact calldata to sign, (2) verify what actually landed
   on-chain really is that call, from the address it claims, before trusting it. */
export function buildLogStatusCalldata({ emailHash, status, onBehalfOf }) {
  return encodeFunctionData({
    abi: ABI,
    functionName: "logStatus",
    args: [emailHash, status, onBehalfOf],
  });
}

/**
 * Verifies a client-reported tx hash really is a logStatus call, on our contract,
 * from the expected address, with calldata matching this exact log entry — never
 * trusts the hash blindly. Returns false (never throws) on any mismatch/failure.
 */
export async function recordExternalTx(logRowId, { txHash, expectedFrom, emailHash, status, onBehalfOf }) {
  try {
    const tx = await publicClient.getTransaction({ hash: txHash });
    if (!tx || (tx.to || "").toLowerCase() !== config.monad.contractAddress.toLowerCase()) {
      throw new Error("transaction doesn't target the MailerLog contract");
    }
    if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new Error("transaction wasn't sent from your connected wallet");
    }
    const decoded = decodeFunctionData({ abi: ABI, data: tx.input });
    const [decodedHash, decodedStatus, decodedOnBehalf] = decoded.args;
    if (
      decoded.functionName !== "logStatus" ||
      decodedHash !== emailHash ||
      Number(decodedStatus) !== status ||
      decodedOnBehalf.toLowerCase() !== onBehalfOf.toLowerCase()
    ) {
      throw new Error("transaction data doesn't match this log entry");
    }
    await db.updateChainLog(logRowId, { status: "submitted", txHash });
    publicClient.waitForTransactionReceipt({ hash: txHash }).then(
      async () => { await db.updateChainLog(logRowId, { status: "confirmed" }); await applyConfirmedAction(logRowId); },
      () => db.updateChainLog(logRowId, { status: "failed" })
    );
    return true;
  } catch (err) {
    console.error(`[chain] external tx verification failed:`, err.message);
    return false;
  }
}
