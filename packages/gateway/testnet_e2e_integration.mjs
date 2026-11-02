import { Keypair, rpc } from '@stellar/stellar-sdk';
import { ChallengeStore } from './dist/challenge-store.js';
import { StellarPaymentVerifier } from './dist/verifier.js';
import { StellarPayer } from '../client/dist/payer.js';
import fs from 'node:fs';
import path from 'node:path';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const CONTRACT_ID = 'CDCTANWGJPZ3YUYAP7NGS4ZHESA37YJEEQCHOOTINTVINOFNO5G24NIA';
const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

async function fundWithFriendbot(publicKey) {
  console.log(`[Friendbot] Requesting funds for: ${publicKey}...`);
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(`Friendbot failed with status ${res.status}: ${await res.text()}`);
  }
  console.log(`[Friendbot] Successfully funded ${publicKey} with 10,000 test XLM`);
}

async function runLiveTestnetIntegration() {
  console.log('='.repeat(80));
  console.log('🌐 STELLAR x402 + SOROBAN: REAL ON-CHAIN TESTNET INTEGRATION TEST');
  console.log('='.repeat(80));

  // 1. Generate real ephemeral keypairs
  const payerKeypair = Keypair.random();
  const merchantKeypair = Keypair.random();

  console.log('\n1. Generated Ephemeral Keypairs:');
  console.log(`   Payer Public Key:    ${payerKeypair.publicKey()}`);
  console.log(`   Merchant Public Key: ${merchantKeypair.publicKey()}`);

  // 2. Fund keypairs via Friendbot
  await fundWithFriendbot(payerKeypair.publicKey());
  await fundWithFriendbot(merchantKeypair.publicKey());

  // 3. Initialize Gateway ChallengeStore & Verifier
  const dbPath = path.join(process.cwd(), 'testnet_live_e2e.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = new ChallengeStore(dbPath);
  const verifier = new StellarPaymentVerifier(HORIZON_URL, SOROBAN_RPC_URL, 'testnet');

  // 4. Issue an x402 Challenge targeting the deployed Soroban contract
  console.log('\n2. Gateway issues x402 Challenge:');
  const challenge = store.createChallenge(
    merchantKeypair.publicKey(),
    '0.05', // 0.05 XLM (500,000 stroops)
    'XLM',
    '/api/v1/autonomous-alpha',
    'testnet',
    CONTRACT_ID,
    300_000, // 5 min TTL
    NATIVE_SAC
  );
  console.log(`   Challenge ID: ${challenge.challengeId}`);
  console.log(`   Destination:  ${challenge.destination}`);
  console.log(`   Contract ID:  ${challenge.contractId}`);
  console.log(`   Token SAC:    ${challenge.tokenAddress}`);
  console.log(`   Amount:       ${challenge.amount} XLM (500,000 stroops)`);

  // 5. Autonomous Client prepares, signs, and executes payment on Soroban Testnet
  console.log('\n3. Autonomous Agent Payer settling challenge on Soroban Testnet...');
  const payer = new StellarPayer({
    secretKey: payerKeypair.secret(),
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    contractId: CONTRACT_ID,
  });

  const parsedChallenge = {
    challengeId: challenge.challengeId,
    destination: challenge.destination,
    amount: challenge.amount,
    asset: challenge.asset,
    memo: challenge.memo,
    network: challenge.network,
    contractId: challenge.contractId,
    tokenAddress: challenge.tokenAddress,
  };

  const receipt = await payer.settleSorobanChallenge(parsedChallenge);
  console.log('   🎉 On-Chain Settlement Succeeded!');
  console.log(`   TxHash:    ${receipt.txHash}`);
  console.log(`   Ledger:    ${receipt.ledger}`);
  console.log(`   Explorer:  https://stellar.expert/explorer/testnet/tx/${receipt.txHash}`);

  // 6. Test Case A: Gateway Verifier accepts genuine on-chain payment
  console.log('\n4. Test Case A: Gateway Verifier validating real on-chain payment...');
  const verifyResult = await verifier.verifyPayment(receipt.txHash, challenge, store);
  console.log('   Verification Result:', verifyResult);
  if (!verifyResult.valid) {
    throw new Error(`Test Case A Failed: Expected valid payment, got: ${verifyResult.reason}`);
  }
  console.log('   ✅ PASS: Gateway verified on-chain payment successfully!');

  // 7. Test Case B: Anti-Replay Defense (same txHash on same challenge)
  console.log('\n5. Test Case B: Anti-Replay Defense (re-submitting identical txHash)...');
  const replayResult = await verifier.verifyPayment(receipt.txHash, challenge, store);
  console.log('   Replay Result:', replayResult);
  if (replayResult.valid) {
    throw new Error('Test Case B Failed: Replay was accepted!');
  }
  console.log('   ✅ PASS: Replay attack blocked cleanly by SQLite ACID constraint!');

  // 8. Test Case C: Anti-Replay Defense (same txHash on a DIFFERENT challenge)
  console.log('\n6. Test Case C: Anti-Replay Defense (submitting txHash to a NEW challenge)...');
  const challenge2 = store.createChallenge(
    merchantKeypair.publicKey(),
    '0.05',
    'XLM',
    '/api/v2/new-resource',
    'testnet',
    CONTRACT_ID,
    300_000,
    NATIVE_SAC
  );
  const crossChallengeResult = await verifier.verifyPayment(receipt.txHash, challenge2, store);
  console.log('   Cross-Challenge Result:', crossChallengeResult);
  if (crossChallengeResult.valid) {
    throw new Error('Test Case C Failed: Reused txHash was accepted for different challenge!');
  }
  console.log('   ✅ PASS: Reused txHash blocked across challenges!');

  // 9. Test Case D: Storage Receipt Verification directly on Soroban Ledger
  console.log('\n7. Test Case D: Querying persistent contract ledger storage for receipt struct...');
  const contractReceipt = await verifier.querySorobanContractReceipt(
    CONTRACT_ID,
    challenge.challengeId
  );
  console.log('   Soroban On-Chain Receipt:', contractReceipt);
  if (!contractReceipt) {
    throw new Error('Test Case D Failed: No receipt found in contract storage!');
  }
  if (contractReceipt.recipient !== merchantKeypair.publicKey()) {
    throw new Error('Test Case D Failed: Recipient mismatch in on-chain receipt!');
  }
  if (BigInt(contractReceipt.amount) !== 500_000n) {
    throw new Error('Test Case D Failed: Amount mismatch in on-chain receipt!');
  }
  console.log('   ✅ PASS: On-chain persistent storage receipt confirmed!');

  // Cleanup
  store.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  console.log('\n' + '='.repeat(80));
  console.log('🏆 ALL DAY 4 ON-CHAIN TESTNET INTEGRATION TESTS PASSED WITH 100% SUCCESS!');
  console.log('='.repeat(80));
}

runLiveTestnetIntegration().catch((err) => {
  console.error('\n❌ Integration Test Error:', err);
  process.exit(1);
});
