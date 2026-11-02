#!/usr/bin/env node
import { Command } from 'commander';
import { Keypair } from '@stellar/stellar-sdk';
import express, { Request, Response } from 'express';
import cors from 'cors';
import pc from 'picocolors';
import {
  createX402Middleware,
  ChallengeStore,
  StellarPaymentVerifier,
  X402Request,
} from '@stellar-x402/gateway';
import { StellarPayer } from '@stellar-x402/client';

const program = new Command();

program
  .name('x402-stellar')
  .description('CLI tool for Stellar Agent Gateway & x402 Micropayments')
  .version('0.1.0');

// 1. Keygen Command
program
  .command('keygen')
  .description('Generate a new Stellar Keypair and optionally fund it via Testnet Friendbot')
  .option('--fund', 'Automatically fund account using Testnet Friendbot', false)
  .action(async (options) => {
    const pair = Keypair.random();
    console.log(pc.cyan('\n✨ New Stellar Keypair Generated:'));
    console.log(pc.bold('Public Key: '), pc.green(pair.publicKey()));
    console.log(pc.bold('Secret Key: '), pc.yellow(pair.secret()));

    if (options.fund) {
      console.log(pc.gray('\nRequesting 10,000 XLM testnet funding from Friendbot...'));
      try {
        const response = await fetch(
          `https://friendbot.stellar.org?addr=${encodeURIComponent(pair.publicKey())}`
        );
        if (response.ok) {
          console.log(pc.green('✓ Friendbot funded account successfully!'));
        } else {
          console.log(pc.red(`✗ Friendbot error: ${response.statusText}`));
        }
      } catch (err: unknown) {
        console.log(pc.red(`✗ Failed to reach Friendbot: ${err}`));
      }
    }
  });

// 2. Gateway Command
program
  .command('gateway')
  .description('Run a standalone HTTP 402 Micropayment Gateway server')
  .option('-p, --port <number>', 'Port to listen on', '3402')
  .requiredOption('-d, --dest <address>', 'Stellar recipient public key (G...)')
  .option('-a, --amount <amount>', 'Default fee in XLM per request', '0.01')
  .option('-n, --network <network>', 'Network (testnet or public)', 'testnet')
  .action((options) => {
    const app = express();
    app.use(cors());
    app.use(express.json());

    const isTestnet = options.network !== 'public';
    const horizonUrl = isTestnet
      ? 'https://horizon-testnet.stellar.org'
      : 'https://horizon.stellar.org';

    const store = new ChallengeStore();
    const verifier = new StellarPaymentVerifier(horizonUrl, undefined, options.network);

    const x402 = createX402Middleware(
      {
        destinationPublicKey: options.dest,
        network: options.network,
        defaultFeeXlm: options.amount,
        horizonUrl,
      },
      store,
      verifier
    );

    // Health check (unprotected)
    app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'stellar-x402-gateway',
        destination: options.dest,
        fee: `${options.amount} XLM`,
        network: options.network,
      });
    });

    // Sample protected API resource
    app.get('/api/protected-intel', x402, (req: X402Request, res: Response) => {
      res.json({
        data: {
          timestamp: new Date().toISOString(),
          premium_intel: 'Autonomous Stellar agent payment verified.',
          market_prediction: 'Agentic micropayments are reshaping AI tool economics.',
          payment_metadata: req.stellarPayment,
        },
      });
    });

    const port = parseInt(options.port, 10);
    app.listen(port, () => {
      console.log(pc.cyan('\n🚀 Stellar x402 Gateway Running'));
      console.log(pc.bold('Listening on:      '), pc.green(`http://localhost:${port}`));
      console.log(pc.bold('Destination:       '), pc.green(options.dest));
      console.log(pc.bold('Fee per call:      '), pc.yellow(`${options.amount} XLM`));
      console.log(pc.bold('Network:           '), pc.blue(options.network));
      console.log(pc.gray('\nEndpoints:'));
      console.log(`  GET /health            (free healthcheck)`);
      console.log(`  GET /api/protected-intel (requires HTTP 402 Stellar payment)\n`);
    });
  });

// 3. Verify Command
program
  .command('verify')
  .description('Verify an on-chain transaction hash on Stellar')
  .requiredOption('-t, --tx <hash>', 'Stellar transaction hash')
  .option('-n, --network <network>', 'Network (testnet or public)', 'testnet')
  .action(async (options) => {
    const horizonUrl =
      options.network === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';

    try {
      console.log(pc.gray(`Fetching transaction ${options.tx}...`));
      const res = await fetch(`${horizonUrl}/transactions/${options.tx}`);
      if (!res.ok) {
        console.log(pc.red(`✗ Transaction not found or rejected: ${res.statusText}`));
        return;
      }
      const tx = (await res.json()) as Record<string, unknown>;
      console.log(pc.green('✓ Transaction Found!'));
      console.log(pc.bold('Ledger:         '), tx.ledger);
      console.log(pc.bold('Source Account: '), tx.source_account);
      console.log(pc.bold('Memo:           '), tx.memo || 'none');
      console.log(pc.bold('Fee Paid:       '), `${tx.fee_charged} stroops`);
      console.log(pc.bold('Successful:     '), tx.successful);
    } catch (err: unknown) {
      console.log(pc.red(`✗ Error verifying: ${err}`));
    }
  });

// 4. Pay Command
program
  .command('pay')
  .description('Execute a Stellar micropayment directly from CLI')
  .requiredOption('-s, --secret <key>', 'Stellar secret key (S...)')
  .requiredOption('-d, --dest <address>', 'Recipient address (G...)')
  .requiredOption('-a, --amount <amount>', 'Amount in XLM')
  .requiredOption('-m, --memo <memo>', 'Challenge memo text')
  .option('-n, --network <network>', 'Network (testnet or public)', 'testnet')
  .action(async (options) => {
    try {
      console.log(pc.gray('Submitting payment on Stellar...'));
      const payer = new StellarPayer({
        secretKey: options.secret,
        network: options.network,
      });

      const receipt = await payer.settleChallenge({
        challengeId: options.memo,
        destination: options.dest,
        amount: options.amount,
        asset: 'XLM',
        memo: options.memo,
        network: options.network,
      });

      console.log(pc.green('✓ Payment Submitted Successfully!'));
      console.log(pc.bold('Transaction Hash: '), pc.green(receipt.txHash));
      console.log(pc.bold('Recipient:        '), pc.green(receipt.destination));
      console.log(pc.bold('Amount:           '), pc.yellow(`${receipt.amount} XLM`));
    } catch (err: unknown) {
      console.log(pc.red(`✗ Payment failed: ${err}`));
    }
  });

program.parse(process.argv);
