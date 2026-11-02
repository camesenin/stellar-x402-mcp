import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

describe('CLI keygen logic', () => {
  it('generates valid Stellar keypairs', () => {
    const pair = Keypair.random();
    expect(pair.publicKey()).toMatch(/^G[A-Z0-9]{55}$/);
    expect(pair.secret()).toMatch(/^S[A-Z0-9]{55}$/);
  });
});
