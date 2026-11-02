import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { X402Challenge } from './types.js';

export interface RedemptionRecord {
  txHash: string;
  challengeId: string;
  redeemedAt: number;
  payer?: string;
  amount?: string;
  asset?: string;
  ledger?: number;
}

export class ChallengeStore {
  private db: Database.Database;

  constructor(
    dbPath: string = 'x402_gateway.sqlite',
    private defaultTtlMs: number = 300_000
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        challenge_id TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        amount TEXT NOT NULL,
        asset TEXT NOT NULL,
        memo TEXT NOT NULL,
        network TEXT NOT NULL,
        contract_id TEXT,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        is_redeemed INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires_at);
      CREATE INDEX IF NOT EXISTS idx_challenges_memo ON challenges(memo);

      CREATE TABLE IF NOT EXISTS redeemed_transactions (
        tx_hash TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        redeemed_at INTEGER NOT NULL,
        payer TEXT,
        amount TEXT,
        asset TEXT,
        ledger INTEGER,
        FOREIGN KEY (challenge_id) REFERENCES challenges(challenge_id)
      );

      CREATE INDEX IF NOT EXISTS idx_redeemed_challenge ON redeemed_transactions(challenge_id);
    `);
  }

  public createChallenge(
    destination: string,
    amount: string,
    asset: string,
    resource: string,
    network: 'testnet' | 'public' | 'custom' = 'testnet',
    contractId?: string,
    ttlMs?: number
  ): X402Challenge {
    const challengeId = crypto.randomBytes(16).toString('hex');
    const memo = challengeId.slice(0, 28);
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);

    const challenge: X402Challenge = {
      challengeId,
      destination,
      amount,
      asset,
      memo,
      network,
      contractId,
      resource,
      expiresAt,
    };

    const stmt = this.db.prepare(`
      INSERT INTO challenges (
        challenge_id, destination, amount, asset, memo,
        network, contract_id, resource, expires_at, created_at, is_redeemed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      challenge.challengeId,
      challenge.destination,
      challenge.amount,
      challenge.asset,
      challenge.memo,
      challenge.network,
      challenge.contractId ?? null,
      challenge.resource,
      challenge.expiresAt,
      now
    );

    return challenge;
  }

  public getChallenge(challengeId: string): X402Challenge | undefined {
    const stmt = this.db.prepare(`
      SELECT 
        challenge_id as challengeId,
        destination,
        amount,
        asset,
        memo,
        network,
        contract_id as contractId,
        resource,
        expires_at as expiresAt
      FROM challenges
      WHERE challenge_id = ? AND is_redeemed = 0
    `);

    const row = stmt.get(challengeId) as X402Challenge | undefined;
    if (!row) return undefined;

    if (Date.now() > row.expiresAt) {
      return undefined;
    }

    return {
      challengeId: row.challengeId,
      destination: row.destination,
      amount: row.amount,
      asset: row.asset,
      memo: row.memo,
      network: row.network,
      contractId: row.contractId || undefined,
      resource: row.resource,
      expiresAt: Number(row.expiresAt),
    };
  }

  public isTxRedeemed(txHash: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM redeemed_transactions WHERE tx_hash = ?
    `);
    return stmt.get(txHash.toLowerCase()) !== undefined;
  }

  public isChallengeRedeemed(challengeId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT is_redeemed FROM challenges WHERE challenge_id = ?
    `);
    const row = stmt.get(challengeId) as { is_redeemed: number } | undefined;
    return row ? row.is_redeemed === 1 : false;
  }

  public markRedeemed(
    challengeId: string,
    txHash: string,
    metadata?: { payer?: string; amount?: string; asset?: string; ledger?: number }
  ): void {
    const cleanHash = txHash.toLowerCase();
    const now = Date.now();

    const transaction = this.db.transaction(() => {
      const updateChallenge = this.db.prepare(`
        UPDATE challenges SET is_redeemed = 1 WHERE challenge_id = ?
      `);
      updateChallenge.run(challengeId);

      const insertRedeemed = this.db.prepare(`
        INSERT OR IGNORE INTO redeemed_transactions (
          tx_hash, challenge_id, redeemed_at, payer, amount, asset, ledger
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertRedeemed.run(
        cleanHash,
        challengeId,
        now,
        metadata?.payer ?? null,
        metadata?.amount ?? null,
        metadata?.asset ?? null,
        metadata?.ledger ?? null
      );
    });

    transaction();
  }

  public cleanupExpired(): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      DELETE FROM challenges WHERE expires_at < ? AND is_redeemed = 0
    `);
    stmt.run(now);
  }

  public close(): void {
    this.db.close();
  }
}
