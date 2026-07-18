import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/*
One-off helper: generates a fresh EVM keypair for Mailer's server wallet
(the one that signs on-chain status logs on Monad mainnet). Run once,
fund the printed address with a small amount of MON for gas, then paste
the private key into .env as MONAD_WALLET_KEY. Nothing here is sent
anywhere — it only prints to your own terminal.
*/
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("\nNew Monad server wallet generated.\n");
console.log("Address:     ", account.address);
console.log("Private key: ", privateKey);
console.log("\nNext steps:");
console.log("1. Save the private key into .env as MONAD_WALLET_KEY");
console.log("2. Send a small amount of MON to the address above (covers gas for status logs)");
console.log("3. Run `npm run deploy-contract` once funded\n");
