import { describe, it, expect } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  validateStrKeyAddress,
  isAccountPublicKey,
  isContractAddress,
  assertValidStrKey,
} from '../src/validators/strkey.js';

describe('StrKey Address Validator', () => {
  const validAccount = Keypair.random().publicKey();
  const validSecret = Keypair.random().secret();
  const validContract = StrKey.encodeContract(Buffer.alloc(32, 0xab));

  it('validates a genuine Ed25519 account public key (G...)', () => {
    const res = validateStrKeyAddress(validAccount);
    expect(res.valid).toBe(true);
    expect(res.type).toBe('account');
    expect(res.versionByte).toBe(48);
    expect(res.normalized).toBe(validAccount);
    expect(isAccountPublicKey(validAccount)).toBe(true);
    expect(isContractAddress(validAccount)).toBe(false);
  });

  it('validates a genuine Soroban contract address (C...)', () => {
    const res = validateStrKeyAddress(validContract);
    expect(res.valid).toBe(true);
    expect(res.type).toBe('contract');
    expect(res.versionByte).toBe(16);
    expect(res.normalized).toBe(validContract);
    expect(isContractAddress(validContract)).toBe(true);
    expect(isAccountPublicKey(validContract)).toBe(false);
  });

  it('rejects corrupted CRC16-XModem checksums', () => {
    const lastChar = validAccount[validAccount.length - 1];
    const replacement = lastChar === 'A' ? 'B' : 'A';
    const corrupted = validAccount.slice(0, -1) + replacement;

    const res = validateStrKeyAddress(corrupted);
    expect(res.valid).toBe(false);
    expect(res.type).toBe('account');
    expect(res.reason).toContain('checksum');
  });

  it('rejects malformed lengths before network dispatch', () => {
    const tooShort = validAccount.slice(0, 50);
    const res = validateStrKeyAddress(tooShort);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain('Malformed StrKey length');
  });

  it('rejects unexpected version bytes or secret seeds when only account/contract allowed', () => {
    const secretRes = validateStrKeyAddress(validSecret);
    expect(secretRes.valid).toBe(false);
    expect(secretRes.type).toBe('secret');
    expect(secretRes.reason).toContain('not permitted');

    const unknownPrefix = 'Z' + validAccount.slice(1);
    const unknownRes = validateStrKeyAddress(unknownPrefix);
    expect(unknownRes.valid).toBe(false);
    expect(unknownRes.reason).toContain('Unsupported StrKey version prefix');
  });

  it('rejects lowercase or non-Base32 characters and throws on assertValidStrKey', () => {
    expect(validateStrKeyAddress(validAccount.toLowerCase()).valid).toBe(false);
    expect(validateStrKeyAddress('').valid).toBe(false);
    expect(() => assertValidStrKey('GINVALIDCHECKSUM')).toThrow();
    expect(assertValidStrKey(validContract, ['contract']).type).toBe('contract');
  });
});
