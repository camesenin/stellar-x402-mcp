import { ParsedChallenge } from './types.js';

export function parseX402Challenge(headers: Headers, jsonBody?: Record<string, unknown>): ParsedChallenge {
  // Check headers first
  const headerChallengeId = headers.get('x-challenge-id');
  const headerDestination = headers.get('x-payment-address');
  const headerAmount = headers.get('x-payment-amount');
  const headerAsset = headers.get('x-payment-asset');
  const headerMemo = headers.get('x-payment-memo');
  const headerNetwork = headers.get('x-payment-network');
  const headerContract = headers.get('x-payment-contract');
  const headerToken = headers.get('x-payment-token');

  if (headerChallengeId && headerDestination && headerAmount) {
    return {
      challengeId: headerChallengeId,
      destination: headerDestination,
      amount: headerAmount,
      asset: headerAsset || 'XLM',
      memo: headerMemo || headerChallengeId.slice(0, 28),
      network: (headerNetwork as 'testnet' | 'public' | 'custom') || 'testnet',
      contractId: headerContract || undefined,
      tokenAddress: headerToken || undefined,
    };
  }

  // Check JSON body challenge
  if (jsonBody) {
    const rawChallenge = (jsonBody.challenge || jsonBody.x402_challenge) as Record<string, unknown>;
    if (rawChallenge) {
      return {
        challengeId: String(rawChallenge.challengeId || rawChallenge.challenge_id),
        destination: String(rawChallenge.destination),
        amount: String(rawChallenge.amount),
        asset: String(rawChallenge.asset || 'XLM'),
        memo: String(rawChallenge.memo || rawChallenge.challengeId || rawChallenge.challenge_id).slice(0, 28),
        network: (rawChallenge.network as 'testnet' | 'public') || 'testnet',
        contractId: rawChallenge.contractId ? String(rawChallenge.contractId) : (rawChallenge.contract_id ? String(rawChallenge.contract_id) : undefined),
        tokenAddress: rawChallenge.tokenAddress ? String(rawChallenge.tokenAddress) : (rawChallenge.token_address ? String(rawChallenge.token_address) : undefined),
        expiresAt: rawChallenge.expiresAt ? Number(rawChallenge.expiresAt) : undefined,
      };
    }
  }

  // Parse WWW-Authenticate header
  const authHeader = headers.get('www-authenticate');
  if (authHeader && authHeader.startsWith('StellarX402')) {
    const extractParam = (key: string): string => {
      const match = authHeader.match(new RegExp(`${key}="([^"]+)"`));
      return match ? match[1] : '';
    };

    return {
      challengeId: extractParam('challenge_id') || extractParam('challenge'),
      destination: extractParam('destination'),
      amount: extractParam('amount'),
      asset: extractParam('asset') || 'XLM',
      memo: extractParam('memo'),
      network: (extractParam('network') as 'testnet' | 'public') || 'testnet',
    };
  }

  throw new Error('Failed to parse valid Stellar x402 challenge from HTTP response');
}
