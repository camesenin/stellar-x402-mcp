import { StrKey } from '@stellar/stellar-sdk';

export type StrKeyAddressType =
  | 'account'
  | 'contract'
  | 'muxed'
  | 'secret'
  | 'preAuthTx'
  | 'sha256Hash';

export interface StrKeyValidationResult {
  valid: boolean;
  type?: StrKeyAddressType;
  versionByte?: number;
  normalized?: string;
  reason?: string;
}

const VERSION_BYTES: Record<StrKeyAddressType, number> = {
  account: 6 << 3,     // 'G' (48)
  contract: 2 << 3,    // 'C' (16)
  muxed: 12 << 3,      // 'M' (96)
  secret: 18 << 3,     // 'S' (144)
  preAuthTx: 19 << 3,  // 'T' (152)
  sha256Hash: 23 << 3, // 'X' (184)
};

const BASE32_REGEX = /^[A-Z2-7]+$/;

/**
 * Validates a Stellar StrKey address (version byte, canonical length, Base32 alphabet, and CRC16-XModem checksum)
 * and distinguishes account public keys (G...) from Soroban contract addresses (C...) before network dispatch.
 */
export function validateStrKeyAddress(
  value: unknown,
  allowedTypes: StrKeyAddressType[] = ['account', 'contract']
): StrKeyValidationResult {
  if (typeof value !== 'string') {
    return {
      valid: false,
      reason: 'StrKey address must be a non-empty string.',
    };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      reason: 'StrKey address cannot be empty.',
    };
  }

  if (trimmed !== trimmed.toUpperCase() || !BASE32_REGEX.test(trimmed)) {
    return {
      valid: false,
      reason: 'StrKey address contains invalid non-Base32 or lowercase characters.',
    };
  }

  const prefix = trimmed[0];
  let detectedType: StrKeyAddressType | undefined;
  let expectedLength = 56;
  let isChecksumValid = false;

  switch (prefix) {
    case 'G':
      detectedType = 'account';
      expectedLength = 56;
      isChecksumValid = StrKey.isValidEd25519PublicKey(trimmed);
      break;
    case 'C':
      detectedType = 'contract';
      expectedLength = 56;
      isChecksumValid = StrKey.isValidContract(trimmed);
      break;
    case 'M':
      detectedType = 'muxed';
      expectedLength = 69;
      isChecksumValid = StrKey.isValidMed25519PublicKey(trimmed);
      break;
    case 'S':
      detectedType = 'secret';
      expectedLength = 56;
      isChecksumValid = StrKey.isValidEd25519SecretSeed(trimmed);
      break;
    case 'T':
      detectedType = 'preAuthTx';
      expectedLength = 56;
      try {
        StrKey.decodePreAuthTx(trimmed);
        isChecksumValid = true;
      } catch {
        isChecksumValid = false;
      }
      break;
    case 'X':
      detectedType = 'sha256Hash';
      expectedLength = 56;
      try {
        StrKey.decodeSha256Hash(trimmed);
        isChecksumValid = true;
      } catch {
        isChecksumValid = false;
      }
      break;
    default:
      return {
        valid: false,
        reason: `Unsupported StrKey version prefix '${prefix}'. Expected G (account) or C (contract).`,
      };
  }

  if (trimmed.length !== expectedLength) {
    return {
      valid: false,
      type: detectedType,
      versionByte: VERSION_BYTES[detectedType],
      reason: `Malformed StrKey length for ${detectedType}: expected ${expectedLength} characters, got ${trimmed.length}.`,
    };
  }

  if (!isChecksumValid) {
    return {
      valid: false,
      type: detectedType,
      versionByte: VERSION_BYTES[detectedType],
      reason: `Invalid StrKey CRC16-XModem checksum or payload encoding for ${detectedType} address.`,
    };
  }

  if (!allowedTypes.includes(detectedType)) {
    return {
      valid: false,
      type: detectedType,
      versionByte: VERSION_BYTES[detectedType],
      reason: `StrKey type '${detectedType}' is not permitted in this context (allowed: ${allowedTypes.join(', ')}).`,
    };
  }

  return {
    valid: true,
    type: detectedType,
    versionByte: VERSION_BYTES[detectedType],
    normalized: trimmed,
  };
}

export function isAccountPublicKey(address: string): boolean {
  return validateStrKeyAddress(address, ['account']).valid;
}

export function isContractAddress(address: string): boolean {
  return validateStrKeyAddress(address, ['contract']).valid;
}

export function assertValidStrKey(
  address: string,
  allowedTypes: StrKeyAddressType[] = ['account', 'contract']
): StrKeyValidationResult {
  const result = validateStrKeyAddress(address, allowedTypes);
  if (!result.valid) {
    throw new Error(result.reason ?? 'Invalid StrKey address');
  }
  return result;
}
