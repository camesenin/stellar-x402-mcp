export interface DoctorOptions {
  network?: 'testnet' | 'public' | 'custom';
  sorobanRpcUrl?: string;
  horizonUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export interface EndpointDiagnostic {
  reachable: boolean;
  url: string;
  latencyMs: number;
  status: string;
  latestLedger?: number;
  protocolVersion?: number;
  error?: string;
}

export interface DoctorReport {
  healthy: boolean;
  network: string;
  sorobanRpc: EndpointDiagnostic;
  horizon: EndpointDiagnostic;
  ledgerSyncLag: number | null;
  synced: boolean;
}

const DEFAULT_ENDPOINTS: Record<'testnet' | 'public', { sorobanRpcUrl: string; horizonUrl: string }> = {
  testnet: {
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  public: {
    sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
    horizonUrl: 'https://horizon.stellar.org',
  },
};

async function rpcPost(
  fetchImpl: typeof fetch,
  url: string,
  method: string
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };

  if (payload.error) {
    throw new Error(payload.error.message || `RPC ${method} error`);
  }

  return payload.result ?? {};
}

export async function runNetworkDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const network = options.network ?? 'testnet';
  const defaults = network === 'public' ? DEFAULT_ENDPOINTS.public : DEFAULT_ENDPOINTS.testnet;
  const sorobanRpcUrl = options.sorobanRpcUrl || defaults.sorobanRpcUrl;
  const horizonUrl = (options.horizonUrl || defaults.horizonUrl).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => Date.now());

  let sorobanDiagnostic: EndpointDiagnostic;
  const rpcStart = clock();
  try {
    const healthRes = await rpcPost(fetchImpl, sorobanRpcUrl, 'getHealth');
    const ledgerRes = await rpcPost(fetchImpl, sorobanRpcUrl, 'getLatestLedger');
    const latencyMs = Math.max(0, clock() - rpcStart);
    const status = typeof healthRes.status === 'string' ? healthRes.status : 'healthy';
    const latestLedger =
      typeof ledgerRes.sequence === 'number'
        ? ledgerRes.sequence
        : typeof healthRes.latestLedger === 'number'
          ? healthRes.latestLedger
          : undefined;
    const protocolVersion =
      typeof ledgerRes.protocolVersion === 'number' ? ledgerRes.protocolVersion : undefined;

    sorobanDiagnostic = {
      reachable: status.toLowerCase() === 'healthy',
      url: sorobanRpcUrl,
      latencyMs,
      status,
      latestLedger,
      protocolVersion,
    };
  } catch (err: unknown) {
    sorobanDiagnostic = {
      reachable: false,
      url: sorobanRpcUrl,
      latencyMs: Math.max(0, clock() - rpcStart),
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let horizonDiagnostic: EndpointDiagnostic;
  const horizonStart = clock();
  try {
    const response = await fetchImpl(`${horizonUrl}/`);
    const latencyMs = Math.max(0, clock() - horizonStart);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    const latestLedger =
      typeof data.history_latest_ledger === 'number'
        ? data.history_latest_ledger
        : typeof data.core_latest_ledger === 'number'
          ? data.core_latest_ledger
          : undefined;
    const protocolVersion =
      typeof data.current_protocol_version === 'number' ? data.current_protocol_version : undefined;

    horizonDiagnostic = {
      reachable: true,
      url: horizonUrl,
      latencyMs,
      status: 'online',
      latestLedger,
      protocolVersion,
    };
  } catch (err: unknown) {
    horizonDiagnostic = {
      reachable: false,
      url: horizonUrl,
      latencyMs: Math.max(0, clock() - horizonStart),
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const ledgerSyncLag =
    typeof sorobanDiagnostic.latestLedger === 'number' &&
    typeof horizonDiagnostic.latestLedger === 'number'
      ? Math.abs(sorobanDiagnostic.latestLedger - horizonDiagnostic.latestLedger)
      : null;

  const synced =
    sorobanDiagnostic.reachable &&
    horizonDiagnostic.reachable &&
    (ledgerSyncLag === null || ledgerSyncLag <= 5);

  const healthy = sorobanDiagnostic.reachable && horizonDiagnostic.reachable && synced;

  return {
    healthy,
    network,
    sorobanRpc: sorobanDiagnostic,
    horizon: horizonDiagnostic,
    ledgerSyncLag,
    synced,
  };
}
