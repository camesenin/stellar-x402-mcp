import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ClientConfig, ParsedChallenge, ClientPaymentReceipt } from './types.js';

export class StellarPayer {
  private keypair: Keypair;
  private horizonServer: Horizon.Server;
  private networkPassphrase: string;

  constructor(private config: ClientConfig) {
    this.keypair = Keypair.fromSecret(config.secretKey);
    this.horizonServer = new Horizon.Server(
      config.horizonUrl || 'https://horizon-testnet.stellar.org'
    );
    this.networkPassphrase =
      config.network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  public getPublicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Settle an x402 challenge by sending payment to the requested destination
   */
  public async settleChallenge(challenge: ParsedChallenge): Promise<ClientPaymentReceipt> {
    const sourceAccount = await this.horizonServer.loadAccount(this.keypair.publicKey());

    // Build Asset
    let asset: Asset;
    if (challenge.asset.toUpperCase() === 'XLM' || challenge.asset.toUpperCase() === 'NATIVE') {
      asset = Asset.native();
    } else {
      const [code, issuer] = challenge.asset.split(':');
      if (!code || !issuer) {
        throw new Error(`Invalid asset format: ${challenge.asset}. Expected 'CODE:ISSUER' or 'XLM'`);
      }
      asset = new Asset(code, issuer);
    }

    // Horizon memo text max 28 bytes
    const memoText = (challenge.memo || challenge.challengeId).slice(0, 28);

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '10000', // 10,000 stroops (0.001 XLM base fee for fast inclusion)
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: challenge.destination,
          asset,
          amount: challenge.amount,
        })
      )
      .addMemo(Memo.text(memoText))
      .setTimeout(60)
      .build();

    transaction.sign(this.keypair);

    const result = await this.horizonServer.submitTransaction(transaction);

    return {
      txHash: result.hash,
      challengeId: challenge.challengeId,
      destination: challenge.destination,
      amount: challenge.amount,
      asset: challenge.asset,
      timestamp: Date.now(),
    };
  }
}
