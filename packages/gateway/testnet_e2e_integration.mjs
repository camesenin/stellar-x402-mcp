import { Keypair, rpc } from '@stellar/stellar-sdk';
import { ChallengeStore } from './dist/challenge-store.js';
import { StellarPaymentVerifier } from './dist/verifier.js';
import { StellarPayer } from '../client/dist/payer.js';
import fs from 'node:fs';
import path from 'node:path';

const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const CONTRACT_ID = 'CB5DW4J47Z3JWUJR5HQRPZIOTVPMT26N7H3HI5DMTRKMVAHJWZEGEUGO';
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
  console.log('🌐 STELLAR x402 + SOROBAN: ADVERSARIAL TESTNET INTEGRATION SUITE');
  console.log(`Contract ID: ${CONTRACT_ID}`);
  console.log('='.repeat(80));

  // 1. Generate real ephemeral keypairs
  const payerKeypair = Keypair.random();
  const merchantKeypair = Keypair.random();
  const attackerKeypair = Keypair.random();

  console.log('\n1. Generated Ephemeral Keypairs:');
  console.log(`   Payer Public Key:    ${payerKeypair.publicKey()}`);
  console.log(`   Merchant Public Key: ${merchantKeypair.publicKey()}`);
  console.log(`   Attacker Public Key: ${attackerKeypair.publicKey()}`);

  // 2. Fund keypairs via Friendbot
  await fundWithFriendbot(payerKeypair.publicKey());
  await fundWithFriendbot(merchantKeypair.publicKey());

  // 3. Initialize Gateway ChallengeStore & Verifier with pinned contract
  const dbPath = path.join(process.cwd(), 'testnet_live_e2e.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = new ChallengeStore(dbPath);
  const verifier = new StellarPaymentVerifier(HORIZON_URL, SOROBAN_RPC_URL, 'testnet', CONTRACT_ID);

  // 4. Create two independent challenges: Challenge A and Challenge B
  console.log('\n2. Gateway issues two independent challenges (A and B):');
  const challengeA = store.createChallenge(
    merchantKeypair.publicKey(),
    '0.05', // 0.05 XLM (500,000 stroops)
    'XLM',
    '/api/v1/alpha-resource',
    'testnet',
    CONTRACT_ID,
    300_000,
    NATIVE_SAC
  );
  console.log(`   Challenge A ID: ${challengeA.challengeId}`);

  const challengeB = store.createChallenge(
    merchantKeypair.publicKey(),
    '0.05',
    'XLM',
    '/api/v2/beta-resource',
    'testnet',
    CONTRACT_ID,
    300_000,
    NATIVE_SAC
  );
  console.log(`   Challenge B ID: ${challengeB.challengeId}`);

  // 5. Autonomous Client settles Challenge A on Soroban Testnet
  console.log('\n3. Autonomous Agent Payer settling Challenge A on Soroban Testnet...');
  const payer = new StellarPayer({
    secretKey: payerKeypair.secret(),
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    contractId: CONTRACT_ID,
  });

  const parsedChallengeA = {
    challengeId: challengeA.challengeId,
    destination: challengeA.destination,
    amount: challengeA.amount,
    asset: challengeA.asset,
    memo: challengeA.memo,
    network: challengeA.network,
    contractId: challengeA.contractId,
    tokenAddress: challengeA.tokenAddress,
  };

  const receiptA = await payer.settleSorobanChallenge(parsedChallengeA);
  console.log('   🎉 On-Chain Settlement Succeeded for Challenge A!');
  console.log(`   TxHash:    ${receiptA.txHash}`);
  console.log(`   Ledger:    ${receiptA.ledger}`);
  console.log(`   Explorer:  https://stellar.expert/explorer/testnet/tx/${receiptA.txHash}`);

  // 6. Test Case 1: Adversarial Cross-Challenge Mismatch
  console.log('\n4. Test Case 1: Adversarial Envelope Binding Check');
  console.log('   Submitting txHashA to Challenge B (unconsumed in SQLite)...');
  const crossChallengeResult = await verifier.verifyPayment(receiptA.txHash, challengeB, store);
  console.log('   Result:', crossChallengeResult);
  if (crossChallengeResult.valid) {
    throw new Error('Test Case 1 FAILED: txHashA was improperly accepted for Challenge B!');
  }
  if (!crossChallengeResult.reason?.includes('did not invoke')) {
    throw new Error(`Test Case 1 FAILED: Expected envelope mismatch reason, got: ${crossChallengeResult.reason}`);
  }
  console.log('   ✅ PASS: Verifier successfully detected envelope challenge mismatch!');

  // 7. Test Case 2: Front-running theft attempt by attacker Eve
  console.log('\n5. Test Case 2: Front-Running Theft Prevention (Requester Binding)');
  const attackerPayer = new StellarPayer({
    secretKey: attackerKeypair.secret(),
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    contractId: CONTRACT_ID,
  });
  const eveSig = attackerPayer.signRequesterProof(
    challengeA.challengeId,
    receiptA.txHash,
    challengeA.resource,
    challengeA.expiresAt
  );
  const domainMessage = `stellar-x402:v1:${verifier.getNetworkPassphrase()}:${challengeA.resource}:${challengeA.challengeId}:${receiptA.txHash.toLowerCase()}:${challengeA.expiresAt}`;
  const eveTheftResult = await verifier.verifyPayment(
    receiptA.txHash,
    challengeA,
    store,
    { message: domainMessage, signatureBase64: eveSig }
  );
  console.log('   Attacker redemption attempt result:', eveTheftResult);
  if (eveTheftResult.valid) {
    throw new Error('Test Case 2 FAILED: Attacker was able to steal resource with valid txHash!');
  }
  console.log('   ✅ PASS: Verifier rejected attacker redemption due to payer signature mismatch!');

  // 8. Test Case 3: Genuine Verification by Legitimate Payer
  console.log('\n6. Test Case 3: Genuine Verification for Challenge A...');
  const aliceSig = payer.signRequesterProof(
    challengeA.challengeId,
    receiptA.txHash,
    challengeA.resource,
    challengeA.expiresAt
  );
  const verifyResult = await verifier.verifyPayment(
    receiptA.txHash,
    challengeA,
    store,
    { message: domainMessage, signatureBase64: aliceSig }
  );
  console.log('   Result:', verifyResult);
  if (!verifyResult.valid) {
    throw new Error(`Test Case 3 FAILED: Expected valid payment, got: ${verifyResult.reason}`);
  }
  console.log('   ✅ PASS: Gateway verified genuine on-chain payment with cryptographic signature!');

  // 9. Test Case 4: Immediate Replay Defense
  console.log('\n7. Test Case 4: Immediate Replay Defense on Challenge A...');
  const replayResult = await verifier.verifyPayment(
    receiptA.txHash,
    challengeA,
    store,
    { message: domainMessage, signatureBase64: aliceSig }
  );
  console.log('   Result:', replayResult);
  if (replayResult.valid) {
    throw new Error('Test Case 4 FAILED: Replay was accepted!');
  }
  if (!replayResult.reason?.includes('already been redeemed')) {
    throw new Error(`Test Case 4 FAILED: Expected replay rejection, got: ${replayResult.reason}`);
  }
  console.log('   ✅ PASS: Replay attack blocked cleanly by SQLite ACID constraint!');

  // 10. Test Case 5: Direct On-Chain Storage Query
  console.log('\n8. Test Case 5: Querying persistent contract ledger storage for receipt struct...');
  const crypto = await import('node:crypto');
  const nonceBytes = crypto.createHash('sha256').update(challengeA.challengeId).digest();
  const onChainHash = await verifier.computeCanonicalChallengeHash(
    CONTRACT_ID,
    challengeA.destination,
    NATIVE_SAC,
    500_000n,
    nonceBytes
  );
  const contractReceipt = await verifier.querySorobanContractReceipt(
    CONTRACT_ID,
    onChainHash
  );
  console.log('   Soroban On-Chain Receipt:', contractReceipt);
  if (!contractReceipt) {
    throw new Error('Test Case 5 FAILED: No receipt found in contract storage!');
  }
  if (contractReceipt.recipient !== merchantKeypair.publicKey()) {
    throw new Error('Test Case 5 FAILED: Recipient mismatch in on-chain receipt!');
  }
  if (BigInt(contractReceipt.amount) !== 500_000n) {
    throw new Error('Test Case 5 FAILED: Amount mismatch in on-chain receipt!');
  }
  console.log('   ✅ PASS: On-chain persistent storage receipt confirmed!');

  // 11. Fetch raw RPC response and save fresh testnet_evidence_pack.json
  console.log('\n9. Packaging reproducible cryptographic evidence pack...');
  const rawRpcTx = await verifier.fetchSorobanTxJsonRpc(receiptA.txHash);
  const evidencePack = {
    metadata: {
      generatedAt: new Date().toISOString(),
      network: 'Stellar Testnet',
      protocolVersion: 29,
      contractId: CONTRACT_ID,
      wasmHash: 'c91cdea4d7bf8c50160445ee4db9d4af4cc31c4e016ec53c5040ecd36aedee15',
      transactionHash: receiptA.txHash,
      settlementAmount: '0.05 XLM (500000 stroops)',
      purpose: 'Reproducible cryptographic artifact matching repository bytecode and on-chain ledger'
    },
    rawRpcResponse: {
      jsonrpc: '2.0',
      id: 1,
      result: rawRpcTx
    }
  };
  const packPath = path.resolve(process.cwd(), '../../testnet_evidence_pack.json');
  fs.writeFileSync(packPath, JSON.stringify(evidencePack, null, 2), 'utf-8');
  console.log(`   Saved fresh evidence pack to: ${packPath}`);

  // Cleanup
  store.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  console.log('\n' + '='.repeat(80));
  console.log('🏆 ALL ADVERSARIAL INTEGRATION TESTS (CASES 1-5) PASSED CONVINCINGLY!');
  console.log('='.repeat(80));
}

runLiveTestnetIntegration().catch((err) => {
  console.error('\n❌ Integration Test Error:', err);
  process.exit(1);
});
