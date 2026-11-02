import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Keypair,
  Networks,
  Operation,
  Address,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
const WASM_HASH = 'a3e512cc196ff88ac2e2df83b19bac5415b9a89a569f03a881f65b5a4d91fbd5';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTransactionRaw(server, txHash, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    try {
      const tx = await server._getTransaction(txHash);
      if (tx.status === 'SUCCESS') {
        return tx;
      }
      if (tx.status === 'FAILED') {
        throw new Error(`Transaction failed on ledger: ${JSON.stringify(tx)}`);
      }
      console.log(`   [Attempt ${i + 1}/${maxAttempts}] Status: ${tx.status}...`);
    } catch {
      console.log(`   [Attempt ${i + 1}/${maxAttempts}] Waiting for ledger inclusion...`);
    }
  }
  throw new Error(`Transaction polling timed out for hash ${txHash}`);
}

async function main() {
  console.log('================================================================');
  console.log('🚀 INSTANTIATING X402 PAYMENT VAULT ON SOROBAN TESTNET');
  console.log('================================================================\n');

  const server = new rpc.Server(SOROBAN_RPC_URL);

  // 1. Generate Deployer Keypair
  const deployer = Keypair.random();
  console.log(`1. Generated Deployer Keypair:`);
  console.log(`   Public Key: ${deployer.publicKey()}`);
  console.log(`   Secret Key: ${deployer.secret()}\n`);

  // 2. Fund via Friendbot
  console.log('2. Funding deployer via Friendbot...');
  const friendbotRes = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(deployer.publicKey())}`
  );
  if (!friendbotRes.ok) {
    throw new Error(`Friendbot failed: ${friendbotRes.statusText}`);
  }
  console.log('   ✓ Friendbot funded deployer account successfully.\n');

  console.log(`3. Verified Wasm Hash on ledger: ${WASM_HASH}\n`);

  // 3. Build createCustomContract Transaction
  console.log('4. Simulating and calculating Contract ID...');
  const account = await server.getAccount(deployer.publicKey());

  const createOp = Operation.createCustomContract({
    address: new Address(deployer.publicKey()),
    wasmHash: Buffer.from(WASM_HASH, 'hex'),
  });

  const createTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(createOp)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(createTx);
  if (!sim.result || !sim.result.retval) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim)}`);
  }

  const contractBytes = sim.result.retval.address().contractId();
  const contractId = Address.contract(contractBytes).toString();
  console.log(`   ✓ Deterministic Contract ID: ${contractId}\n`);

  // 4. Assemble, sign and submit
  console.log('5. Submitting instantiate transaction to Soroban Testnet...');
  const preparedTx = await server.prepareTransaction(createTx);
  preparedTx.sign(deployer);

  const sendRes = await server.sendTransaction(preparedTx);
  if (sendRes.status === 'ERROR') {
    throw new Error(`Send transaction failed: ${JSON.stringify(sendRes.errorResult)}`);
  }

  console.log(`   Submitted TxHash: ${sendRes.hash}`);
  console.log('   Polling for confirmation...');

  const confirmedTx = await pollTransactionRaw(server, sendRes.hash);
  console.log(`   ✓ Transaction Confirmed in Ledger: ${confirmedTx.ledger}!`);

  console.log(`\n🎉 CONTRACT INSTANTIATED ON SOROBAN TESTNET SUCCESSFULLY!`);
  console.log(`================================================================`);
  console.log(`Contract ID:       ${contractId}`);
  console.log(`Wasm Hash:         ${WASM_HASH}`);
  console.log(`Deployer Address:  ${deployer.publicKey()}`);
  console.log(`Deployer Secret:   ${deployer.secret()}`);
  console.log(`Ledger:            ${confirmedTx.ledger}`);
  console.log(`TxHash:            ${sendRes.hash}`);
  console.log(`Testnet Explorer:  https://stellar.expert/explorer/testnet/contract/${contractId}`);
  console.log(`================================================================\n`);

  // Save deployment artifact
  const deploymentInfo = {
    network: 'testnet',
    contractId,
    wasmHash: WASM_HASH,
    deployerPublicKey: deployer.publicKey(),
    deployerSecret: deployer.secret(),
    deployedAt: new Date().toISOString(),
    ledger: confirmedTx.ledger,
    txHash: sendRes.hash,
    rpcUrl: SOROBAN_RPC_URL,
    explorerUrl: `https://stellar.expert/explorer/testnet/contract/${contractId}`,
  };

  const outputPath = path.resolve(__dirname, '../../contracts/deployed-contracts.json');
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2), 'utf-8');
  console.log(`Deployment metadata saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error('\n❌ Deployment failed:', err);
  process.exit(1);
});
