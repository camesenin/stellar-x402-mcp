import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTxJsonRpc(txHash) {
  const res = await fetch(SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash: txHash },
    }),
  });
  const data = await res.json();
  return data?.result || null;
}

async function pollTx(txHash, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    const tx = await fetchTxJsonRpc(txHash);
    if (tx) {
      if (tx.status === 'SUCCESS') return tx;
      if (tx.status === 'FAILED') throw new Error(`Tx failed on-chain: ${JSON.stringify(tx)}`);
      console.log(`   [Attempt ${i + 1}/${maxAttempts}] Status: ${tx.status}...`);
    } else {
      console.log(`   [Attempt ${i + 1}/${maxAttempts}] Waiting for ledger inclusion...`);
    }
  }
  throw new Error(`Tx polling timed out: ${txHash}`);
}

async function main() {
  console.log('================================================================');
  console.log('🚀 REPRODUCIBLE DEPLOYMENT: X402 PAYMENT VAULT ON SOROBAN TESTNET');
  console.log('================================================================\n');

  const server = new rpc.Server(SOROBAN_RPC_URL);

  // 1. Read Wasm bytecode
  const wasmPath = path.resolve(__dirname, '../../contracts/target/wasm32v1-none/release/stellar_x402_contracts.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Wasm file not found at ${wasmPath}. Run 'cargo build --target wasm32v1-none --release' first.`);
  }
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmSha256 = crypto.createHash('sha256').update(wasmBuffer).digest('hex');
  console.log(`1. Loaded Local Release Wasm:`);
  console.log(`   Path:    ${wasmPath}`);
  console.log(`   Size:    ${wasmBuffer.length} bytes`);
  console.log(`   SHA-256: ${wasmSha256}\n`);

  // 2. Generate Deployer Keypair
  const deployer = Keypair.random();
  console.log(`2. Generated Deployer Keypair:`);
  console.log(`   Public Key: ${deployer.publicKey()}`);
  console.log(`   Secret Key: ${deployer.secret()}\n`);

  // 3. Fund Deployer via Friendbot
  console.log('3. Funding deployer via Friendbot on Testnet...');
  const fbRes = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(deployer.publicKey())}`);
  if (!fbRes.ok) throw new Error(`Friendbot failed: ${fbRes.statusText}`);
  console.log('   ✓ Friendbot funding confirmed (10,000 XLM)\n');

  // 4. Upload Contract Wasm
  console.log('4. Uploading Wasm bytecode to Soroban Testnet...');
  let account = await server.getAccount(deployer.publicKey());
  const uploadOp = Operation.uploadContractWasm({ wasm: wasmBuffer });

  const uploadTx = new TransactionBuilder(account, {
    fee: '1000000', // 0.1 XLM
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(uploadOp)
    .setTimeout(60)
    .build();

  const preparedUpload = await server.prepareTransaction(uploadTx);
  preparedUpload.sign(deployer);
  const sendUpload = await server.sendTransaction(preparedUpload);
  if (sendUpload.status === 'ERROR') {
    throw new Error(`Upload transaction failed: ${JSON.stringify(sendUpload.errorResult)}`);
  }
  console.log(`   Upload TxHash: ${sendUpload.hash}`);
  const uploadConfirmed = await pollTx(sendUpload.hash);
  console.log(`   ✓ Wasm Upload Confirmed in Ledger: ${uploadConfirmed.ledger}\n`);

  // 5. Instantiate Contract
  console.log('5. Instantiating Contract from uploaded Wasm...');
  account = await server.getAccount(deployer.publicKey());
  const createOp = Operation.createCustomContract({
    address: new Address(deployer.publicKey()),
    wasmHash: Buffer.from(wasmSha256, 'hex'),
  });

  const createTx = new TransactionBuilder(account, {
    fee: '1000000',
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
  console.log(`   Deterministic Contract ID: ${contractId}`);

  const preparedCreate = await server.prepareTransaction(createTx);
  preparedCreate.sign(deployer);
  const sendCreate = await server.sendTransaction(preparedCreate);
  if (sendCreate.status === 'ERROR') {
    throw new Error(`Instantiate transaction failed: ${JSON.stringify(sendCreate.errorResult)}`);
  }

  console.log(`   Instantiate TxHash: ${sendCreate.hash}`);
  const createConfirmed = await pollTx(sendCreate.hash);
  console.log(`   ✓ Contract Confirmed in Ledger: ${createConfirmed.ledger}!\n`);

  console.log(`🎉 DEPLOYMENT COMPLETE & REPRODUCIBLE!`);
  console.log(`================================================================`);
  console.log(`Contract ID:       ${contractId}`);
  console.log(`Wasm Hash:         ${wasmSha256}`);
  console.log(`Deployer Address:  ${deployer.publicKey()}`);
  console.log(`Instantiate Ledger:${createConfirmed.ledger}`);
  console.log(`Instantiate Tx:    ${sendCreate.hash}`);
  console.log(`Upload Tx:         ${sendUpload.hash}`);
  console.log(`Explorer Link:     https://stellar.expert/explorer/testnet/contract/${contractId}`);
  console.log(`================================================================\n`);

  const metadata = {
    network: 'testnet',
    contractId,
    wasmHash: wasmSha256,
    wasmSizeBytes: wasmBuffer.length,
    deployerPublicKey: deployer.publicKey(),
    deployedAt: new Date().toISOString(),
    ledger: createConfirmed.ledger,
    instantiateTxHash: sendCreate.hash,
    uploadTxHash: sendUpload.hash,
    rpcUrl: SOROBAN_RPC_URL,
    explorerUrl: `https://stellar.expert/explorer/testnet/contract/${contractId}`,
  };

  const outPath = path.resolve(__dirname, '../../contracts/deployed-contracts.json');
  fs.writeFileSync(outPath, JSON.stringify(metadata, null, 2), 'utf-8');
  console.log(`Saved deployment metadata to: ${outPath}`);
}

main().catch((err) => {
  console.error('\n❌ Deployment script failed:', err);
  process.exit(1);
});
