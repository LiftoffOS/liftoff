// The Coinbase → treasury top-up: the last manual leg of the x402 float,
// automated.
//
// Completes the chain  bank → Coinbase balance → treasury → spending wallet
// → vendor:  a Coinbase Recurring Buy replenishes the Coinbase balance from
// the bank (their native feature, set once), and THIS moves money on from
// there — when the treasury's USDC dips under its refill floor, send a
// top-up amount from the company Coinbase account; when its ETH gas tank
// runs low, send a splash of ETH the same way. Both ride Coinbase's App
// Transfer API (POST /v2/accounts/:id/transactions, type=send, network
// base), authenticated with a Bearer JWT from a CDP API key created for the
// BUSINESS account with transfer permission — a DIFFERENT credential from
// the Server Wallet keys, mounted as COINBASE_TOPUP_KEY_ID / _SECRET.
//
// The safety model:
//   * The Coinbase account has address allowlisting enabled and the two
//     treasury addresses allowlisted — so this credential, even stolen,
//     can only move money to our own wallets.
//   * The idempotency token is DETERMINISTIC per (currency, UTC day)
//     (UUIDv5 over a fixed namespace), so Coinbase itself enforces at most
//     ONE top-up per currency per day, across retries, replays and doubled
//     scheduler fires — the fiat leg's pump bound, held by the vendor
//     rather than by our own state.
//   * A Coinbase balance that cannot cover a needed top-up answers 409 from
//     the job — the one residual human signal, meaning "raise the
//     Recurring Buy".
//
// Everything is env-gated: without the top-up key the job reports itself
// skipped, and the manual funding walkthrough in the runbook still works.

import { v5 as uuidv5 } from 'uuid';
import { log } from '../infrastructure/logging';
import {
  getEthBalance,
  getX402WalletBalanceUsd,
  lowBalanceThresholdUsd,
  resolveTreasuryAddress,
  x402CdpConfigured,
  x402WalletAddress,
} from './x402-wallet-service';

const COINBASE_API_HOST = 'api.coinbase.com';

/** Fixed namespace for the deterministic idempotency tokens. Changing it
 *  would let one calendar day top up twice; do not. */
const TOPUP_IDEM_NAMESPACE = '2c1f6d0e-7a67-4b13-9c1e-a4021deadb02';

const DEFAULT_TOPUP_AMOUNT_USD = 20;
/** ~$1-2 of gas at typical ETH prices; hundreds of reload transfers. */
const DEFAULT_TOPUP_ETH_AMOUNT = 0.0005;
const DEFAULT_TREASURY_MIN_ETH = 0.0001;

export function topupConfigured(): boolean {
  return ['COINBASE_TOPUP_KEY_ID', 'COINBASE_TOPUP_KEY_SECRET'].every((name) => {
    const v = process.env[name];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

function envNumberOr(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The subpath's own signature, typed locally: this repo's classic module
 *  resolution cannot see types behind the package's exports map (they live
 *  under _types/), while the runtime resolves the subpath fine. */
type GenerateJwt = (options: {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod?: string | null;
  requestHost?: string | null;
  requestPath?: string | null;
  expiresIn?: number;
}) => Promise<string>;

async function coinbaseRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  // @ts-expect-error -- subpath types are invisible to classic resolution; see GenerateJwt above
  const { generateJwt } = (await import('@coinbase/cdp-sdk/auth')) as { generateJwt: GenerateJwt };
  const jwt = await generateJwt({
    apiKeyId: process.env.COINBASE_TOPUP_KEY_ID as string,
    apiKeySecret: process.env.COINBASE_TOPUP_KEY_SECRET as string,
    requestMethod: method,
    requestHost: COINBASE_API_HOST,
    requestPath: path,
  });
  const resp = await fetch(`https://${COINBASE_API_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await resp.json().catch(() => undefined)) as
    | { data?: T; errors?: Array<{ message?: string }> }
    | undefined;
  if (!resp.ok || parsed?.errors?.length) {
    const message = parsed?.errors?.[0]?.message ?? `HTTP ${resp.status}`;
    throw new Error(`coinbase ${method} ${path}: ${message}`);
  }
  if (parsed?.data === undefined) throw new Error(`coinbase ${method} ${path}: empty response`);
  return parsed.data;
}

interface CoinbaseAccount {
  id: string;
  balance: { amount: string; currency: string };
}

interface TopupLeg {
  needed: boolean;
  sent?: boolean;
  amount?: string;
  transactionId?: string;
  coinbaseBalance?: string;
  coinbaseShort?: boolean;
}

export interface X402TopupResult {
  skipped?: 'wallet_not_configured' | 'cdp_not_configured' | 'topup_not_configured';
  topped?: boolean;
  /** Some needed leg could not be covered by the Coinbase balance. */
  coinbaseShort?: boolean;
  treasuryBalanceUsd?: number;
  treasuryEth?: number;
  usdc?: TopupLeg;
  eth?: TopupLeg;
}

async function sendLeg(
  currency: 'USDC' | 'ETH',
  amount: number,
  treasury: string,
  day: string,
): Promise<TopupLeg> {
  const account = await coinbaseRequest<CoinbaseAccount>('GET', `/v2/accounts/${currency}`);
  const coinbaseBalance = account.balance.amount;
  if (Number(coinbaseBalance) < amount) {
    log.error(
      { event: 'x402_coinbase_short', currency, coinbaseBalance, amount },
      'x402 top-up refused: the Coinbase balance cannot cover it — raise the Recurring Buy',
    );
    return { needed: true, sent: false, coinbaseShort: true, coinbaseBalance };
  }
  const amountStr = String(amount);
  const tx = await coinbaseRequest<{ id: string; status: string }>(
    'POST',
    `/v2/accounts/${account.id}/transactions`,
    {
      type: 'send',
      to: treasury,
      amount: amountStr,
      currency,
      network: 'base',
      // One top-up per currency per UTC day, enforced by Coinbase's own
      // idempotency rather than by our state.
      idem: uuidv5(`x402-topup-${currency}-${day}`, TOPUP_IDEM_NAMESPACE),
    },
  );
  log.info(
    { event: 'x402_topup_sent', currency, amount: amountStr, treasury, transactionId: tx.id, status: tx.status },
    'x402 treasury top-up sent from Coinbase',
  );
  return { needed: true, sent: true, amount: amountStr, transactionId: tx.id, coinbaseBalance };
}

/**
 * Top the treasury up from the company Coinbase account when its USDC or
 * its ETH gas tank is under the floor. At most one send per currency per
 * UTC day (vendor-enforced idempotency).
 */
export async function runX402Topup(now = new Date()): Promise<X402TopupResult> {
  if (!x402WalletAddress()) return { skipped: 'wallet_not_configured' };
  if (!x402CdpConfigured()) return { skipped: 'cdp_not_configured' };
  if (!topupConfigured()) return { skipped: 'topup_not_configured' };

  const treasury = await resolveTreasuryAddress();
  const treasuryBalanceUsd = await getX402WalletBalanceUsd(treasury);
  const treasuryEth = await getEthBalance(treasury);
  const needUsdc = treasuryBalanceUsd < lowBalanceThresholdUsd();
  const needEth = treasuryEth < envNumberOr('X402_TREASURY_MIN_ETH', DEFAULT_TREASURY_MIN_ETH);

  if (!needUsdc && !needEth) {
    return { topped: false, treasuryBalanceUsd, treasuryEth };
  }

  const day = now.toISOString().slice(0, 10);
  const result: X402TopupResult = { treasuryBalanceUsd, treasuryEth };
  if (needUsdc) {
    result.usdc = await sendLeg('USDC', envNumberOr('X402_TOPUP_AMOUNT_USD', DEFAULT_TOPUP_AMOUNT_USD), treasury, day);
  }
  if (needEth) {
    result.eth = await sendLeg('ETH', envNumberOr('X402_TOPUP_ETH_AMOUNT', DEFAULT_TOPUP_ETH_AMOUNT), treasury, day);
  }
  result.coinbaseShort = result.usdc?.coinbaseShort === true || result.eth?.coinbaseShort === true;
  result.topped = result.usdc?.sent === true || result.eth?.sent === true;
  return result;
}
