// The x402 wallet's treasury checks — balance and on-chain reconciliation.
//
// The platform x402 wallet is a CDP server wallet holding USDC on Base
// (eip155:8453). Connector-service SPENDS from it (a signed EIP-3009
// authorization per paid call, submitted on-chain by the vendor's
// facilitator); this module WATCHES it from the control plane, which owns the
// ledger the spending must reconcile against:
//
//   * low balance  — read balanceOf(wallet) on the USDC contract; the wallet
//     funds every x402 vendor at once, so an empty wallet is a platform-wide
//     capability outage that announces itself only as vendor failures.
//   * reconciliation — sum the wallet's OUTBOUND USDC transfers for a
//     complete UTC day against SUM(cost_usd) of that day's
//     cost_bucket='x402_wallet_funded' rows. Measured on both sides, never
//     tallied: the chain is what actually left the wallet, the ledger is what
//     executors reported, and drift in either direction is a defect — a
//     payment with no usage record, or a record no payment backs. A manual
//     withdrawal also surfaces as drift, which is correct: money left the
//     wallet that the ledger does not explain.
//
// Chain access is the public Base JSON-RPC (overridable via BASE_RPC_URL) —
// read-only eth_call / eth_getLogs for the checks. Everything is gated on
// X402_WALLET_ADDRESS: unset means the wallet is not live yet and every
// check reports itself skipped rather than failed.
//
// The float runs on the PREPAID-CARD model, two tiers:
//   spending wallet ('x402-wallet', connector-service's signer) — holds a few
//     dollars; every vendor payment drains it.
//   treasury ('x402-treasury', resolved here) — the refill float a HUMAN
//     funds from Coinbase, plus a splash of ETH for transfer gas. The reload
//     job tops the spending wallet back up ($5 under $1, by default) with an
//     on-chain USDC transfer, capped per UTC day so a drain loop stops being
//     refilled instead of pumping the treasury dry. Moving the reload leg
//     here (with the CDP credentials PB now mounts) is what keeps EXCHANGE
//     keys out of the estate entirely: nothing automated can touch the
//     Coinbase account, only the on-chain float it deliberately parked.

import { getPool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { fetchX402SignerWallet } from '../connectors/connector-service-client';

/** USDC on Base — the asset every x402 vendor charges in, at 6 decimals. */
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
/** keccak256("Transfer(address,address,uint256)") — the ERC-20 transfer topic. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** balanceOf(address) selector. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/** eth_getLogs window per request. mainnet.base.org enforces a 2,000-block
 *  range (probed live: a 5k request answers HTTP 413 / -32614
 *  "eth_getLogs is limited to a 2,000 range"), so the chunk is exactly that
 *  limit. A UTC day (~43k blocks at ~2s/block) is ~22 requests — fine for a
 *  daily reconcile and for the reload's rare below-threshold ticks. */
const GET_LOGS_CHUNK_BLOCKS = 2_000;

const DEFAULT_RPC_URL = 'https://mainnet.base.org';
/** The refill floor on the HUMAN-owned float (the treasury once the reload
 *  runs; the spending wallet before it): two reloads of headroom. */
const DEFAULT_LOW_BALANCE_THRESHOLD_USD = 10;
/** Sub-cent noise is rounding, not drift. */
const RECONCILIATION_TOLERANCE_USD = 0.01;

/** The treasury account's CDP name. The spending wallet is 'x402-wallet'
 *  (resolved by connector-service); the treasury is its refill float,
 *  resolved HERE because platform-backend is the side that runs the reload. */
export const X402_TREASURY_ACCOUNT_NAME = 'x402-treasury';

/** Auto-reload defaults — the prepaid-card model: hold a small spending
 *  float, top it back up from the treasury whenever it dips. Every knob is
 *  env-overridable; the per-day cap is the pump bound (a drain loop stops
 *  refilling after max × amount per UTC day, aligning with the spend guard's
 *  $25 global daily ceiling). */
const DEFAULT_RELOAD_THRESHOLD_USD = 1;
const DEFAULT_RELOAD_AMOUNT_USD = 5;
const DEFAULT_RELOAD_MAX_PER_DAY = 5;
/** ~500 EOA transfers of gas at typical Base fees. */
const DEFAULT_TREASURY_MIN_ETH = 0.0001;

export function x402WalletAddress(): string | undefined {
  const v = process.env.X402_WALLET_ADDRESS?.trim();
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : undefined;
}

/** True when the CDP credentials are mounted — the reload leg needs them;
 *  the read-only checks do not. */
export function x402CdpConfigured(): boolean {
  return ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'].every((name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

function envNumberOr(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function lowBalanceThresholdUsd(): number {
  return envNumberOr('X402_LOW_BALANCE_THRESHOLD_USD', DEFAULT_LOW_BALANCE_THRESHOLD_USD);
}

export function reloadThresholdUsd(): number {
  return envNumberOr('X402_RELOAD_THRESHOLD_USD', DEFAULT_RELOAD_THRESHOLD_USD);
}

export function reloadAmountUsd(): number {
  return envNumberOr('X402_RELOAD_AMOUNT_USD', DEFAULT_RELOAD_AMOUNT_USD);
}

export function reloadMaxPerDay(): number {
  return envNumberOr('X402_RELOAD_MAX_PER_DAY', DEFAULT_RELOAD_MAX_PER_DAY);
}

function rpcUrl(): string {
  return process.env.BASE_RPC_URL?.trim() || DEFAULT_RPC_URL;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const resp = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  // The RPC's real refusal rides in the JSON body even on a non-2xx (Base's
  // range cap answers HTTP 413 with a -32614 message) — read it either way,
  // so an operator sees "limited to a 2,000 range" and not just a status.
  const body = (await resp.json().catch(() => undefined)) as
    | { result?: T; error?: { message?: string } }
    | undefined;
  if (body?.error) throw new Error(`base rpc ${method}: ${body.error.message ?? 'rpc error'}`);
  if (!resp.ok) throw new Error(`base rpc ${method}: HTTP ${resp.status}`);
  if (body?.result === undefined) throw new Error(`base rpc ${method}: empty result`);
  return body.result;
}

function hexToNumber(hex: string): number {
  return Number.parseInt(hex, 16);
}

/** Atomic USDC (hex or decimal string) → USD. BigInt until the final divide so
 *  a large balance cannot lose integer precision on the way. */
function atomicHexToUsd(hex: string): number {
  return Number(BigInt(hex)) / 10 ** USDC_DECIMALS;
}

/** The wallet's current USDC balance, in USD. */
export async function getX402WalletBalanceUsd(wallet: string): Promise<number> {
  const data = BALANCE_OF_SELECTOR + wallet.slice(2).padStart(64, '0');
  const result = await rpc<string>('eth_call', [{ to: USDC_CONTRACT, data }, 'latest']);
  return atomicHexToUsd(result);
}

/** The address's native ETH balance — the treasury's gas tank for reload
 *  transfers (an EOA transfer on Base mainnet is not sponsored). */
export async function getEthBalance(address: string): Promise<number> {
  const result = await rpc<string>('eth_getBalance', [address, 'latest']);
  return Number(BigInt(result)) / 1e18;
}

async function blockTimestamp(blockNumber: number): Promise<number> {
  const block = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [
    `0x${blockNumber.toString(16)}`,
    false,
  ]);
  return hexToNumber(block.timestamp);
}

/** The first block at or after `unixTs`, by binary search over block
 *  timestamps (~30 eth_getBlockByNumber calls — fine for a daily job). */
async function blockAtOrAfter(unixTs: number, latestBlock: number): Promise<number> {
  let lo = 0;
  let hi = latestBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTimestamp(mid)) < unixTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sum of USDC the wallet SENT in [fromTs, toTs), read from the chain.
 *  `toAddress` narrows to transfers into one recipient — how the reload
 *  counts its own day's treasury→spending refills without any state. */
export async function sumOutboundUsdcUsd(
  wallet: string,
  fromTs: number,
  toTs: number,
  toAddress?: string,
): Promise<{ totalUsd: number; transferCount: number }> {
  const latestHex = await rpc<string>('eth_blockNumber', []);
  const latest = hexToNumber(latestHex);
  const fromBlock = await blockAtOrAfter(fromTs, latest);
  const toBlockExclusive = await blockAtOrAfter(toTs, latest);
  const fromTopic = '0x' + wallet.slice(2).padStart(64, '0');
  const topics: Array<string | null> = [TRANSFER_TOPIC, fromTopic];
  if (toAddress) topics.push('0x' + toAddress.slice(2).padStart(64, '0'));

  let total = 0n;
  let transferCount = 0;
  for (let start = fromBlock; start < toBlockExclusive; start += GET_LOGS_CHUNK_BLOCKS) {
    const end = Math.min(start + GET_LOGS_CHUNK_BLOCKS - 1, toBlockExclusive - 1);
    const logs = await rpc<Array<{ data: string }>>('eth_getLogs', [{
      address: USDC_CONTRACT,
      topics,
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
    }]);
    for (const entry of logs) {
      total += BigInt(entry.data);
      transferCount += 1;
    }
  }
  return { totalUsd: Number(total) / 10 ** USDC_DECIMALS, transferCount };
}

/** The treasury's address alone — for callers (the Coinbase top-up leg) that
 *  fund it but never sign with it. */
export async function resolveTreasuryAddress(): Promise<string> {
  return (await resolveTreasury()).address;
}

/** Resolve the treasury account via CDP. Lazy import so the read-only checks
 *  never load the SDK, and a process without the CDP env never needs it. */
async function resolveTreasury(): Promise<{ address: string; transfer: (opts: {
  to: `0x${string}`; amount: bigint; token: 'usdc'; network: 'base';
}) => Promise<{ transactionHash: string }> }> {
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: X402_TREASURY_ACCOUNT_NAME });
  return account as unknown as Awaited<ReturnType<typeof resolveTreasury>>;
}

export interface X402LowBalanceResult {
  skipped?: 'wallet_not_configured' | 'treasury_unfunded';
  /** The custodian connector-service signs with, and whether its wallet is
   *  the one this side watches. Absent when the signer could not be read. */
  signerProvider?: 'cdp' | 'circle' | null;
  signerAddress?: string;
  addressMismatch?: boolean;
  spendingBalanceUsd?: number;
  treasuryBalanceUsd?: number;
  treasuryEth?: number;
  thresholdUsd?: number;
  low?: boolean;
}

/**
 * The hourly float check. With the auto-reload running, the balance a HUMAN
 * must act on is the TREASURY's (USDC to refill, plus the ETH gas tank) —
 * the spending wallet self-heals from it. Without the CDP env the reload
 * cannot run, so the spending wallet is the float and gets the threshold.
 */
export async function runX402LowBalanceCheck(): Promise<X402LowBalanceResult> {
  const wallet = x402WalletAddress();
  if (!wallet) return { skipped: 'wallet_not_configured' };

  const signer = await compareWithSigner(wallet);
  const thresholdUsd = lowBalanceThresholdUsd();
  const spendingBalanceUsd = await getX402WalletBalanceUsd(wallet);

  // The two-tier float (treasury + reload) is a Coinbase construction. Under
  // the Circle custodian the one wallet IS the float, funded by hand, so the
  // balance a human must act on is that wallet's, whatever CDP credentials
  // are still mounted beside it. connector-service is the authority on which
  // custodian signs; a signer that could not be read falls back to the env.
  if (!x402CdpConfigured() || signer.signerProvider === 'circle') {
    const low = spendingBalanceUsd < thresholdUsd;
    if (low) {
      log.error(
        { event: 'x402_wallet_low_balance', wallet, spendingBalanceUsd, thresholdUsd },
        'x402 wallet balance is below the top-up threshold — every x402 vendor fails once it empties',
      );
    }
    return { ...signer, spendingBalanceUsd, thresholdUsd, low };
  }

  const treasury = await resolveTreasury();
  const treasuryBalanceUsd = await getX402WalletBalanceUsd(treasury.address);
  const treasuryEth = await getEthBalance(treasury.address);
  // The never-funded float: every balance EXACTLY zero. A live float cannot
  // get here — gas ETH depletes in dust increments and the hourly page fires
  // at the $10 floor long before absolute zero — so triple-zero means the
  // wallets exist and nobody has funded them yet, which is a setup state,
  // not an incident.
  if (treasuryBalanceUsd === 0 && spendingBalanceUsd === 0 && treasuryEth === 0) {
    log.info(
      { event: 'x402_treasury_unfunded', treasury: treasury.address },
      'x402 treasury awaits its first funding — checks stand down until money arrives',
    );
    return { ...signer, skipped: 'treasury_unfunded', spendingBalanceUsd, treasuryBalanceUsd, treasuryEth };
  }
  const minEth = envNumberOr('X402_TREASURY_MIN_ETH', DEFAULT_TREASURY_MIN_ETH);
  const low = treasuryBalanceUsd < thresholdUsd || treasuryEth < minEth;
  if (low) {
    log.error(
      {
        event: 'x402_wallet_low_balance',
        treasury: treasury.address,
        treasuryBalanceUsd,
        treasuryEth,
        thresholdUsd,
        minEth,
        spendingBalanceUsd,
      },
      'x402 treasury needs a human: USDC under the refill threshold or the ETH gas tank is dust',
    );
  } else {
    log.info(
      { event: 'x402_wallet_balance', treasury: treasury.address, treasuryBalanceUsd, treasuryEth, spendingBalanceUsd },
      'x402 treasury balance check',
    );
  }
  return { ...signer, spendingBalanceUsd, treasuryBalanceUsd, treasuryEth, thresholdUsd, low };
}

/** The address connector-service actually signs with, against the one this
 *  side watches. The signer is a provider choice over there and the address
 *  an env value here, so a switch done on one side only is a wallet that is
 *  guarded and never spent from, or spent from and never guarded. Read on
 *  every check; a signer that cannot be read is reported as unknown, not as
 *  a match. */
async function compareWithSigner(wallet: string): Promise<Pick<X402LowBalanceResult, 'signerProvider' | 'signerAddress' | 'addressMismatch'>> {
  let signer;
  try {
    signer = await fetchX402SignerWallet();
  } catch (err) {
    log.warn({ event: 'x402_signer_unreadable', err: (err as Error).message }, 'x402 signer wallet could not be read from connector-service');
    return {};
  }
  if (!signer.address) return { signerProvider: signer.provider };
  const addressMismatch = signer.address.toLowerCase() !== wallet.toLowerCase();
  if (addressMismatch) {
    log.error(
      { event: 'x402_wallet_address_mismatch', wallet, signerAddress: signer.address, signerProvider: signer.provider },
      'X402_WALLET_ADDRESS is not the wallet connector-service signs from — these checks watch a wallet nobody spends from; set both sides to the same custodian',
    );
  }
  return { signerProvider: signer.provider, signerAddress: signer.address, addressMismatch };
}

export interface X402ReloadResult {
  /** `circle_float`: the live signer is the Circle wallet, which has no
   *  treasury to reload from; the low-balance check carries its signal. */
  skipped?: 'wallet_not_configured' | 'cdp_not_configured' | 'treasury_unfunded' | 'circle_float';
  reloaded?: boolean;
  amountUsd?: number;
  transactionHash?: string;
  spendingBalanceUsd?: number;
  treasuryBalanceUsd?: number;
  reloadsToday?: number;
  /** The per-day pump bound tripped: a reload is needed and refused. */
  capped?: boolean;
  /** The treasury cannot cover one reload — the human refill signal. */
  treasuryShort?: boolean;
}

/**
 * The prepaid-card reload: when the spending wallet dips under the threshold,
 * move one reload amount from the treasury to it, on-chain. Stateless by
 * design — "how many reloads already happened today" is MEASURED from the
 * chain (treasury→spending transfers since UTC midnight), never tallied, so
 * a replayed or doubled scheduler fire cannot over-reload past the cap.
 */
export async function runX402Reload(now = new Date()): Promise<X402ReloadResult> {
  const wallet = x402WalletAddress();
  if (!wallet) return { skipped: 'wallet_not_configured' };
  if (!x402CdpConfigured()) return { skipped: 'cdp_not_configured' };

  const spendingBalanceUsd = await getX402WalletBalanceUsd(wallet);
  if (spendingBalanceUsd >= reloadThresholdUsd()) {
    return { reloaded: false, spendingBalanceUsd };
  }

  // Under the Circle custodian there is no treasury and no reload leg: the
  // one wallet is the float, funded by hand, and the low-balance check is
  // where its refill signal lives. Refusing here would page for something
  // that cannot be done, every retry, every ten minutes.
  const signer = await compareWithSigner(wallet);
  if (signer.signerProvider === 'circle') {
    log.info(
      { event: 'x402_reload_not_applicable', wallet, spendingBalanceUsd },
      'x402 reload stands down: the live signer is the Circle wallet, which is funded by hand',
    );
    return { skipped: 'circle_float', spendingBalanceUsd };
  }

  const treasury = await resolveTreasury();

  // The never-funded stand-down comes FIRST: it is two cheap balance reads,
  // where the day-count below is a ~22-request chain sweep — no reason to do
  // chain archaeology on a float nobody has funded yet.
  const earlyTreasuryUsd = await getX402WalletBalanceUsd(treasury.address);
  if (earlyTreasuryUsd === 0 && spendingBalanceUsd === 0 && (await getEthBalance(treasury.address)) === 0) {
    return { skipped: 'treasury_unfunded', spendingBalanceUsd, treasuryBalanceUsd: earlyTreasuryUsd };
  }

  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const { transferCount: reloadsToday } = await sumOutboundUsdcUsd(
    treasury.address, dayStart, Math.floor(now.getTime() / 1000) + 1, wallet,
  );
  if (reloadsToday >= reloadMaxPerDay()) {
    log.error(
      { event: 'x402_reload_capped', wallet, treasury: treasury.address, reloadsToday, spendingBalanceUsd },
      'x402 reload refused: the per-day cap is reached — something is draining the spending wallet faster than its ceilings should allow',
    );
    return { capped: true, reloadsToday, spendingBalanceUsd };
  }

  const amountUsd = reloadAmountUsd();
  const treasuryBalanceUsd = await getX402WalletBalanceUsd(treasury.address);
  if (treasuryBalanceUsd < amountUsd) {
    log.error(
      { event: 'x402_treasury_short', wallet, treasury: treasury.address, treasuryBalanceUsd, amountUsd },
      'x402 reload refused: the treasury cannot cover one reload — refill it (USDC on Base)',
    );
    return { treasuryShort: true, treasuryBalanceUsd, spendingBalanceUsd };
  }

  const { transactionHash } = await treasury.transfer({
    to: wallet as `0x${string}`,
    amount: BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS)),
    token: 'usdc',
    network: 'base',
  });
  log.info(
    {
      event: 'x402_reloaded',
      wallet,
      treasury: treasury.address,
      amountUsd,
      transactionHash,
      spendingBalanceUsd,
      reloadsToday: reloadsToday + 1,
    },
    'x402 spending wallet reloaded from the treasury',
  );
  return {
    reloaded: true,
    amountUsd,
    transactionHash,
    spendingBalanceUsd,
    treasuryBalanceUsd,
    reloadsToday: reloadsToday + 1,
  };
}

export interface X402ReconciliationResult {
  skipped?: 'wallet_not_configured';
  day?: string;
  onChainUsd?: number;
  onChainTransfers?: number;
  /** Prepaid vendor tokens bought that day: on-chain outflow the ledger
   *  explains over the following weeks, so it is set aside here. */
  prepaidPurchasesUsd?: number;
  prepaidPurchases?: number;
  ledgerUsd?: number;
  ledgerRows?: number;
  driftUsd?: number;
  drifted?: boolean;
  /** The live prepaid tokens' own draw-down (the vendor's balances against
   *  what was paid for them) versus the x402-funded Apify rows booked since
   *  the oldest of them was bought. Absent when no token is live. */
  prepaid?: { drawnUsd: number; bookedUsd: number; liveTokens: number; driftUsd: number; drifted: boolean };
}

/** Prepaid vendor tokens (platform_prepaid_tokens, Apify today) whose
 *  purchase fell in [from, to): one transfer each on the chain side. Only the
 *  wallet's own purchases: a token the platform's Locus credits bought moved
 *  no USDC of ours and is not on the chain side at all. */
async function sumPrepaidPurchasesUsd(from: number, to: number): Promise<{ totalUsd: number; count: number }> {
  const r = await getPool().query<{ total: string | null; n: string }>(
    `SELECT SUM(purchased_usd) AS total, COUNT(*) AS n
       FROM platform_prepaid_tokens
      WHERE purchased_at >= to_timestamp($1) AND purchased_at < to_timestamp($2)
        AND funded_by = 'x402_wallet'`,
    [from, to],
  );
  return { totalUsd: Number(r.rows[0]?.total ?? 0), count: Number(r.rows[0]?.n ?? 0) };
}

/** The live prepaid tokens' draw-down against the ledger. Both measured:
 *  the vendor's balance per token (written by the upkeep job) and the
 *  x402-funded rows booked under that vendor since the oldest live purchase. */
async function prepaidDrawdown(): Promise<X402ReconciliationResult['prepaid']> {
  const live = await getPool().query<{ vendor: string; drawn: string | null; since: Date | null; n: string }>(
    `SELECT vendor, SUM(purchased_usd - balance_usd) AS drawn, MIN(purchased_at) AS since, COUNT(*) AS n
       FROM platform_prepaid_tokens
      WHERE retired_at IS NULL AND funded_by = 'x402_wallet'
      GROUP BY vendor`,
  );
  const row = live.rows[0];
  if (!row || Number(row.n) === 0 || !row.since) return undefined;
  const booked = await withAdminScope(
    { caller: 'billing.x402-reconciliation', reason: 'cross-tenant x402 spend reconciliation: prepaid token draw-down against the ledger' },
    (client) => client.query<{ total: string | null }>(
      `SELECT SUM(cost_usd) AS total
         FROM cost_attribution_events
        WHERE cost_bucket = 'x402_wallet_funded' AND connector = $1 AND occurred_at >= $2`,
      [row.vendor, row.since],
    ),
  );
  const drawnUsd = Number(row.drawn ?? 0);
  const bookedUsd = Number(booked.rows[0]?.total ?? 0);
  const driftUsd = Math.abs(drawnUsd - bookedUsd);
  return { drawnUsd, bookedUsd, liveTokens: Number(row.n), driftUsd, drifted: driftUsd > RECONCILIATION_TOLERANCE_USD };
}

/** Reconcile the last COMPLETE UTC day: on-chain outbound USDC vs the ledger's
 *  x402_wallet_funded cost_usd. */
export async function runX402Reconciliation(now = new Date()): Promise<X402ReconciliationResult> {
  const wallet = x402WalletAddress();
  if (!wallet) return { skipped: 'wallet_not_configured' };

  const dayEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const dayStart = dayEnd - 86_400;
  const day = new Date(dayStart * 1000).toISOString().slice(0, 10);

  const onChain = await sumOutboundUsdcUsd(wallet, dayStart, dayEnd);
  // A prepaid token bought that day is one outbound transfer the ledger does
  // not book as such: it books the runs the token funds, over the next two
  // weeks. Set aside here and reconciled on its own line below.
  const prepaid = await sumPrepaidPurchasesUsd(dayStart, dayEnd);

  const ledger = await withAdminScope(
    { caller: 'billing.x402-reconciliation', reason: 'cross-tenant x402 spend reconciliation against the chain' },
    (client) => client.query<{ total: string | null; rows: string }>(
      `SELECT SUM(cost_usd) AS total, COUNT(*) AS rows
         FROM cost_attribution_events
        WHERE cost_bucket = 'x402_wallet_funded'
          AND occurred_at >= to_timestamp($1)
          AND occurred_at <  to_timestamp($2)`,
      [dayStart, dayEnd],
    ),
  );
  const ledgerUsd = Number(ledger.rows[0]?.total ?? 0);
  const ledgerRows = Number(ledger.rows[0]?.rows ?? 0);

  const driftUsd = Math.abs(onChain.totalUsd - prepaid.totalUsd - ledgerUsd);
  const drifted = driftUsd > RECONCILIATION_TOLERANCE_USD;
  const tokens = await prepaidDrawdown();
  const result: X402ReconciliationResult = {
    day,
    onChainUsd: onChain.totalUsd,
    onChainTransfers: onChain.transferCount,
    prepaidPurchasesUsd: prepaid.totalUsd,
    prepaidPurchases: prepaid.count,
    ledgerUsd,
    ledgerRows,
    driftUsd,
    drifted,
    ...(tokens ? { prepaid: tokens } : {}),
  };
  if (drifted) {
    log.error(
      { event: 'x402_reconciliation_drift', wallet, ...result },
      'x402 spend drifted: on-chain settled USDC (less prepaid token purchases) and the x402_wallet_funded ledger disagree',
    );
  } else {
    log.info({ event: 'x402_reconciliation', wallet, ...result }, 'x402 spend reconciles');
  }
  if (tokens?.drifted) {
    log.error(
      { event: 'x402_prepaid_drawdown_drift', wallet, ...tokens },
      'prepaid token draw-down drifted: what the vendor drew from the live tokens and what the ledger booked against them disagree',
    );
  }
  return result;
}
