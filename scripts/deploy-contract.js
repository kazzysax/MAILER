import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import solc from "solc";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/*
Deploys contracts/MailerLog.sol to Monad MAINNET using Mailer's server
wallet (MONAD_WALLET_KEY). This spends real MON on gas — run it
yourself, deliberately, not as part of any automated flow.

Usage: npm run deploy-contract
Then paste the printed address into .env as MAILER_LOG_CONTRACT_ADDRESS.
*/

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const rpcUrl = process.env.MONAD_RPC_URL || "https://rpc.monad.xyz";
const chainId = Number(process.env.MONAD_CHAIN_ID || 143);
const walletKey = req("MONAD_WALLET_KEY");

const monad = {
  id: chainId,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

function compile() {
  const source = readFileSync(path.join(__dirname, "..", "contracts", "MailerLog.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "MailerLog.sol": { content: source } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  const artifact = output.contracts["MailerLog.sol"]["MailerLog"];
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

async function main() {
  console.log(`Compiling MailerLog.sol...`);
  const { abi, bytecode } = compile();

  const account = privateKeyToAccount(walletKey);
  const walletClient = createWalletClient({ account, chain: monad, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain: monad, transport: http(rpcUrl) });

  console.log(`Deploying from ${account.address} to Monad mainnet (chain ${chainId}, ${rpcUrl})...`);
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [], // permissionless — no constructor args
  });
  console.log(`Tx submitted: ${hash}`);
  console.log(`Waiting for confirmation...`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log(`\nDeployed! Contract address: ${receipt.contractAddress}`);
  console.log(`Paste this into .env as:`);
  console.log(`MAILER_LOG_CONTRACT_ADDRESS=${receipt.contractAddress}\n`);
}

main().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
