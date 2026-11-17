// Apify prepaid tokens: bought through Locus, held here, spent by the
// store-actor executor.
//
// Apify sells its pay-per-event Actors over x402 as a prepaid token: one
// payment buys an `apify_api_…` bearer whose balance is an absolute cap, good
// for fourteen days, unused credit not refunded. It is what makes Apify pure
// consumption for the platform: no plan, no monthly commitment, a run costs
// what the store charges and nothing else. The purchase happens in
// connector-service; the token comes here to be held (Secret Manager) and
// metered (platform_prepaid_tokens).
//
// WHO PAYS, AND WHY IT IS LOCUS. Apify has no per-run rail on any rail: its
// x402 support sells prepaid tokens and nothing else, and Locus's one Apify
// entry buys that same token. So a vendor that can be paid for through Locus
// is paid for through Locus, and the x402 wallet is not a routine funding
// source for anything Locus can buy. The wallet is consulted only on an
// explicit emergency flag (APIFY_PREPAID_WALLET_FALLBACK=1) AND only when
// Locus could not fund the purchase, and every such purchase is alerted on.
// Wallet-first was how a $1 token bought from the wallet came to be the only
// one in play while a Locus-funded token with its whole dollar on it sat
// unused.
//
// The model is a float, not a treasury. Every purchase is the vendor's $1 —
// each prepaid token is its own Apify account with a $1 MONTHLY hard limit,
// so a larger purchase strands the difference in an account that can never
// spend it — the next one is bought when the live one is nearly spent or
// within a day of expiry, and at most a few per UTC day
// (APIFY_PREPAID_MAX_PURCHASES_PER_DAY), counted from the table and never
// tallied, so a drain loop cannot pump money into tokens. Balances are what
// the VENDOR reports (its balance endpoint), never our own subtraction of run
// costs, for the same reason the wallet's balance is read from the chain: the
// vendor is the side that actually charged — and the vendor reports a
// NEGATIVE balance for a token that was overdrawn, which is a figure this
// module has to be able to hear.
//
// The executor takes the soonest-expiring live token that still covers one
// capped run, so an older token is drained before a newer one and as little
// as possible expires unspent. The upkeep therefore re-reads EVERY live
// token, not the newest: refreshing only the newest while the executor spent
// the oldest meant the two never looked at the same token, and an overdrawn
// one stayed live and was handed to run after run. What does expire unspent
// is retired with the remainder on its row and logged as
// `x402_prepaid_expired_unspent`: a platform loss, kept visible, never booked
// to a tenant.

import { randomUUID } from 'node:crypto';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { purchaseX402PrepaidToken, type X402PrepaidTokenFunder } from '../connectors/connector-service-client';
import { getX402WalletBalanceUsd, x402WalletAddress } from './x402-wallet-service';
import {
  destroyPlatformPrepaidSecret,
  putPlatformPrepaidSecret,
  readPlatformPrepaidSecret,
} from './platform-prepaid-secret';

export const APIFY_PREPAID_VENDOR = 'apify';
const APIFY_BALANCE_URL = 'https://agi.apify.com/prepaid-tokens/balance';

/** What every purchase is, and it is not configurable. $1 is Apify's own
 *  floor on a prepaid purchase AND the monthly hard limit of the account each
 *  token IS: `users/me` on a prepaid token reports the FREE plan with
 *  `maxMonthlyUsageUsd: 1`. A $10 purchase would buy $10 of credit into an
 *  account that may spend one of them in a month, and strand the other nine. */
const APIFY_PREPAID_PURCHASE_USD = 1;
const DEFAULT_MAX_PURCHASES_PER_DAY = 2;
/** Below this a token is spent: no run takes it and the next one is bought.
 *  Well under the per-run cap on purpose. A pay-per-event run costs cents, so
 *  a token with a dollar on it serves dozens of runs; a floor at the cap would
 *  make a $1 token good for exactly one run and buy the next after it. The run
 *  itself is capped at the token's remaining balance by
 *  the executor (`maxTotalChargeUsd`), because APIFY DOES NOT STOP A RUN AT
 *  THE TOKEN'S BALANCE — a token can finish with a negative
 *  `remainingBalanceUsd`. */
const DEFAULT_MIN_BALANCE_USD = 0.1;
/** A token this close to expiry is renewed ahead of time... */
const RENEW_BEFORE_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** ...and one this close is no longer offered to a run at all: a run that
 *  outlives its token is charged on a credential the vendor is about to
 *  refuse. */
const OFFER_MARGIN_MS = 5 * 60 * 1000;

function envNumberOr(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function apifyPrepaidMaxPurchasesPerDay(): number {
  return envNumberOr('APIFY_PREPAID_MAX_PURCHASES_PER_DAY', DEFAULT_MAX_PURCHASES_PER_DAY);
}
export function apifyPrepaidMinBalanceUsd(): number {
  return envNumberOr('APIFY_PREPAID_MIN_BALANCE_USD', DEFAULT_MIN_BALANCE_USD);
}

interface TokenRow {
  id: string;
  secret_name: string;
  purchased_usd: string;
  balance_usd: string;
  purchased_at: Date;
  expires_at: Date;
  funded_by: X402PrepaidTokenFunder;
}

export interface ApifyPrepaidToken {
  id: string;
  token: string;
  balanceUsd: number;
  expiresAt: Date;
  /** Who paid for the token: the run it serves is funded the same way. */
  fundedBy: X402PrepaidTokenFunder;
}

/** Whether the x402 wallet may buy a token Locus could not. OFF by default,
 *  and an emergency lever rather than a funding source: Apify is a vendor
 *  Locus can pay for, so the wallet's money is not spent on it as a matter of
 *  course. Every purchase taken on this path is alerted on. */
export function apifyPrepaidWalletFallbackEnabled(): boolean {
  return process.env.APIFY_PREPAID_WALLET_FALLBACK === '1';
}

/**
 * The token a run should spend: the soonest-expiring live one with at least
 * the floor on it (`APIFY_PREPAID_MIN_BALANCE_USD`, the same floor the upkeep
 * renews at), or null when there is none. One query and one secret read
 * (cached five minutes by the secret store).
 */
export async function getLiveApifyPrepaidToken(
  now = new Date(),
  minBalanceUsd = apifyPrepaidMinBalanceUsd(),
): Promise<ApifyPrepaidToken | null> {
  const result = await getPool().query<TokenRow>(
    `SELECT id, secret_name, purchased_usd, balance_usd, purchased_at, expires_at, funded_by
       FROM platform_prepaid_tokens
      WHERE vendor = $1
        AND retired_at IS NULL
        AND expires_at > $2
        AND balance_usd >= $3
      ORDER BY expires_at ASC
      LIMIT 1`,
    [APIFY_PREPAID_VENDOR, new Date(now.getTime() + OFFER_MARGIN_MS), minBalanceUsd],
  );
  const row = result.rows[0];
  if (!row) return null;
  const token = await readPlatformPrepaidSecret(row.secret_name);
  if (!token) {
    log.error({ event: 'apify_prepaid_secret_missing', purchaseId: row.id }, 'a live Apify prepaid token has no secret behind it');
    return null;
  }
  return { id: row.id, token, balanceUsd: Number(row.balance_usd), expiresAt: new Date(row.expires_at), fundedBy: row.funded_by === 'locus' ? 'locus' : 'x402_wallet' };
}

/** Every live token — not retired and not yet expired — newest first. The
 *  upkeep reads all of them: the executor spends the soonest-expiring, so a
 *  refresh of the newest alone never looks at the token being spent. */
async function liveApifyPrepaidRows(now: Date): Promise<TokenRow[]> {
  const result = await getPool().query<TokenRow>(
    `SELECT id, secret_name, purchased_usd, balance_usd, purchased_at, expires_at
       FROM platform_prepaid_tokens
      WHERE vendor = $1 AND retired_at IS NULL AND expires_at > $2
      ORDER BY expires_at DESC`,
    [APIFY_PREPAID_VENDOR, now],
  );
  return result.rows;
}

/** Every token not yet retired, with its secret, for a reader that needs to
 *  see the runs made on each: a run started on a prepaid token belongs to
 *  that token's identity, not to the platform account, so the account key
 *  cannot list it. Expired-but-not-retired tokens are included: their runs
 *  are the ones a daily true-up still has to reconcile. A token whose secret
 *  is gone is skipped, not an error. */
export async function listApifyPrepaidTokensForReads(): Promise<Array<{ id: string; token: string; fundedBy: X402PrepaidTokenFunder }>> {
  const result = await getPool().query<Pick<TokenRow, 'id' | 'secret_name' | 'funded_by'>>(
    `SELECT id, secret_name, funded_by FROM platform_prepaid_tokens WHERE vendor = $1 AND retired_at IS NULL ORDER BY purchased_at`,
    [APIFY_PREPAID_VENDOR],
  );
  const out: Array<{ id: string; token: string; fundedBy: X402PrepaidTokenFunder }> = [];
  for (const row of result.rows) {
    const token = await readPlatformPrepaidSecret(row.secret_name);
    if (token) out.push({ id: row.id, token, fundedBy: row.funded_by === 'locus' ? 'locus' : 'x402_wallet' });
  }
  return out;
}

/** Apify's balance answer: `remainingBalanceUsd`, bare or under `data`.
 *
 *  A NEGATIVE figure is an answer, not a malformed one. Apify does not stop a
 *  run at the token's balance, so a token that was handed three runs in a row
 *  finishes overdrawn — `remainingBalanceUsd: -0.2206` on token 025902aa,
 *  against a dollar of credit. Rejecting the number as out of range left the
 *  row reading $0.122 and the token live, and it was picked for run after run
 *  and refused every time. */
function readBalanceAnswer(body: unknown): number | null {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const inner = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const v = typeof inner.remainingBalanceUsd === 'number' ? inner.remainingBalanceUsd
    : typeof inner.balanceUsd === 'number' ? inner.balanceUsd : null;
  return v !== null && Number.isFinite(v) ? v : null;
}

/** What one balance read found. `retired` is the answer the run path acts on:
 *  the token is gone, and another has to take the run. A null balance with
 *  `retired` false is "could not be read", which is NOT a reason to retire or
 *  replace anything. */
export interface ApifyPrepaidBalanceCheck {
  /** What the vendor reported, negative included; null when it could not be
   *  read at all. */
  balanceUsd: number | null;
  /** The token no longer exists as far as this service is concerned: the
   *  vendor refused it, or it has nothing left. */
  retired: boolean;
}

/**
 * Read the vendor's balance for one token and write it to the row. A token
 * the vendor no longer honours (401/403) is retired as refused; one it
 * reports empty OR OVERDRAWN is retired as drained. Both destroy the secret.
 *
 * The stored figure is floored at zero — `balance_usd >= 0` is the table's own
 * check (migration 491) and there is no migration here — while the answer
 * this returns is the vendor's own, overdraft and all, because the caller's
 * decision is about whether the token is spent, not about what fits a column.
 */
export async function refreshApifyPrepaidBalance(purchaseId: string): Promise<ApifyPrepaidBalanceCheck> {
  const unread: ApifyPrepaidBalanceCheck = { balanceUsd: null, retired: false };
  const result = await getPool().query<TokenRow>(
    `SELECT id, secret_name, purchased_usd, balance_usd, purchased_at, expires_at
       FROM platform_prepaid_tokens WHERE id = $1 AND retired_at IS NULL`,
    [purchaseId],
  );
  const row = result.rows[0];
  if (!row) return unread;
  const token = await readPlatformPrepaidSecret(row.secret_name);
  if (!token) return unread;

  let res: Response;
  try {
    res = await fetch(APIFY_BALANCE_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn({ event: 'apify_prepaid_balance_unreadable', purchaseId, err: (err as Error).message }, 'Apify prepaid balance could not be read');
    return unread;
  }
  if (res.status === 401 || res.status === 403) {
    await retireToken(row, 'refused');
    return { balanceUsd: null, retired: true };
  }
  if (!res.ok) {
    log.warn({ event: 'apify_prepaid_balance_unreadable', purchaseId, status: res.status }, 'Apify prepaid balance read refused');
    return unread;
  }
  const balanceUsd = readBalanceAnswer(await res.json().catch(() => null));
  if (balanceUsd === null) {
    log.warn({ event: 'apify_prepaid_balance_unrecognised', purchaseId }, 'Apify prepaid balance answered in a shape nobody recognises');
    return unread;
  }
  const stored = Math.max(0, balanceUsd);
  await getPool().query(
    `UPDATE platform_prepaid_tokens SET balance_usd = $2, last_checked_at = now() WHERE id = $1`,
    [purchaseId, stored],
  );
  if (balanceUsd <= 0) {
    if (balanceUsd < 0) {
      log.warn(
        { event: 'apify_prepaid_token_overdrawn', purchaseId, vendorBalanceUsd: balanceUsd, purchasedUsd: Number(row.purchased_usd) },
        'an Apify prepaid token finished overdrawn; the vendor does not stop a run at the balance',
      );
    }
    await retireToken({ ...row, balance_usd: String(stored) }, 'drained');
    return { balanceUsd, retired: true };
  }
  return { balanceUsd, retired: false };
}

async function retireToken(row: TokenRow, reason: 'expired' | 'drained' | 'superseded' | 'refused'): Promise<void> {
  await getPool().query(
    `UPDATE platform_prepaid_tokens SET retired_at = now(), retired_reason = $2 WHERE id = $1 AND retired_at IS NULL`,
    [row.id, reason],
  );
  await destroyPlatformPrepaidSecret(row.secret_name).catch((err: Error) => {
    log.warn({ event: 'apify_prepaid_secret_not_destroyed', purchaseId: row.id, err: err.message }, 'retired Apify token secret could not be destroyed');
  });
  const unspent = Number(row.balance_usd);
  log.info(
    { event: reason === 'expired' ? 'x402_prepaid_expired_unspent' : 'x402_prepaid_retired', purchaseId: row.id, reason, unspentUsd: unspent, purchasedUsd: Number(row.purchased_usd) },
    reason === 'expired'
      ? 'an Apify prepaid token expired with credit on it (the platform\'s loss, not any tenant\'s)'
      : 'an Apify prepaid token was retired',
  );
}

export interface ApifyPrepaidUpkeepResult {
  /** Nobody could pay for a token: Locus has no connection on this
   *  environment, and the wallet is not an option (no emergency flag, no
   *  wallet, or a wallet that cannot cover the vendor's minimum). Nothing to
   *  do until a human funds one, and nothing to page about. */
  skipped?: 'funder_unavailable' | 'wallet_not_configured' | 'wallet_unfunded';
  walletBalanceUsd?: number;
  retiredExpired?: number;
  /** How many live tokens the upkeep asked the vendor about. Every one of
   *  them, not the newest: the executor spends the soonest-expiring, and an
   *  upkeep that read only the newest never saw the token being spent. */
  refreshed?: number;
  liveBalanceUsd?: number;
  liveExpiresAt?: string;
  purchased?: boolean;
  amountUsd?: number;
  expiresAt?: string;
  /** Who paid for the purchase this tick made. */
  fundedBy?: X402PrepaidTokenFunder;
  /** The per-day purchase bound tripped with a purchase needed. */
  capped?: boolean;
  purchasesToday?: number;
  /** The funder or the vendor refused the purchase, with its own reason. */
  refused?: string;
}

/**
 * The upkeep: retire what expired, re-read EVERY live token's balance from the
 * vendor, and buy the next token when the soonest one to be spent is nearly
 * spent or a day from expiry. Stateless: "how many were bought today" is
 * counted from the table so a doubled scheduler fire cannot buy past the cap.
 *
 * Called hourly by the low-balance job, on demand by the operator route, and
 * by the RUN PATH when a run finds no live prepaid token — the run that needs
 * a token is the one that should buy it, and waiting for the next scheduled
 * tick is what sent every Apify run to the platform account.
 */
export async function ensureApifyPrepaidToken(
  now = new Date(),
  opts: {
    walletBalanceUsd?: number;
    /** Buy even while a live token is healthy (the on-demand route, to see a
     *  purchase happen); the per-day cap still applies. */
    force?: boolean;
  } = {},
): Promise<ApifyPrepaidUpkeepResult> {
  const expired = await getPool().query<TokenRow>(
    `SELECT id, secret_name, purchased_usd, balance_usd, purchased_at, expires_at
       FROM platform_prepaid_tokens
      WHERE vendor = $1 AND retired_at IS NULL AND expires_at <= $2`,
    [APIFY_PREPAID_VENDOR, now],
  );
  for (const row of expired.rows) await retireToken(row, 'expired');
  const out: ApifyPrepaidUpkeepResult = { retiredExpired: expired.rows.length };

  // EVERY live token, with its balance re-read from the vendor before any
  // decision is made on any of them. The executor takes the soonest-expiring;
  // an upkeep that refreshed only the newest never looked at the token that
  // was actually being spent, so an overdrawn one stayed live indefinitely.
  const live = await liveApifyPrepaidRows(now);
  for (const row of live) await refreshApifyPrepaidBalance(row.id);
  out.refreshed = live.length;

  // Re-read after the refreshes: a token the vendor reported spent, overdrawn
  // or refused has been retired in between and is no longer a live one.
  const remaining = await liveApifyPrepaidRows(now);
  let needsNew = true;
  const newest = remaining[0];
  if (newest) {
    const balanceUsd = Number(newest.balance_usd);
    out.liveBalanceUsd = balanceUsd;
    out.liveExpiresAt = new Date(newest.expires_at).toISOString();
    const expiresSoon = new Date(newest.expires_at).getTime() - now.getTime() < RENEW_BEFORE_EXPIRY_MS;
    needsNew = balanceUsd < apifyPrepaidMinBalanceUsd() || expiresSoon;
  }
  if (!needsNew && !opts.force) return { ...out, purchased: false };

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM platform_prepaid_tokens WHERE vendor = $1 AND purchased_at >= $2`,
    [APIFY_PREPAID_VENDOR, dayStart],
  );
  const purchasesToday = Number(today.rows[0]?.n ?? 0);
  if (purchasesToday >= apifyPrepaidMaxPurchasesPerDay()) {
    log.error(
      { event: 'apify_prepaid_purchase_capped', purchasesToday, liveBalanceUsd: out.liveBalanceUsd },
      'Apify prepaid token needed and refused: the per-day purchase cap is reached',
    );
    return { ...out, purchased: false, capped: true, purchasesToday };
  }

  // WHO PAYS: Locus, unless Locus cannot. Apify is a vendor Locus can pay for,
  // and the x402 wallet is not a routine funding source for anything Locus can
  // buy. Always the vendor's $1, which is also the monthly ceiling of the
  // account the token is.
  const amountUsd = APIFY_PREPAID_PURCHASE_USD;
  let outcome = await purchaseX402PrepaidToken({ vendor: APIFY_PREPAID_VENDOR, amountUsd, funding: 'locus' });
  let funding: X402PrepaidTokenFunder = 'locus';

  if (!outcome.purchased) {
    const locusReason = outcome.reason;
    // THE EMERGENCY PATH, and it is both flagged and alerted on. Locus could
    // not fund the purchase; the wallet may buy the same token, once a human
    // has said it may.
    const walletUsable = apifyPrepaidWalletFallbackEnabled();
    const wallet = walletUsable ? x402WalletAddress() : null;
    if (walletUsable && !wallet) {
      log.warn(
        { event: 'apify_prepaid_wallet_fallback_unavailable', locusReason, liveBalanceUsd: out.liveBalanceUsd },
        'Apify prepaid token needed, Locus could not pay, and the emergency wallet is not configured',
      );
      return { ...out, skipped: 'wallet_not_configured', purchased: false, purchasesToday };
    }
    if (!wallet) {
      if (locusReason === 'funder_unavailable') {
        // No Locus connection on this environment: the unfunded state, quietly.
        log.info(
          { event: 'apify_prepaid_funder_unavailable', minimumUsd: amountUsd, liveBalanceUsd: out.liveBalanceUsd },
          'Apify prepaid token needed, and no Locus connection can pay for one; standing down until one is funded',
        );
        return { ...out, skipped: 'funder_unavailable', purchased: false };
      }
      log.warn({ event: 'apify_prepaid_purchase_refused', reason: locusReason, amountUsd, funding }, 'Apify prepaid token purchase refused');
      return { ...out, purchased: false, refused: locusReason, purchasesToday };
    }
    const walletBalanceUsd = opts.walletBalanceUsd ?? await getX402WalletBalanceUsd(wallet);
    out.walletBalanceUsd = walletBalanceUsd;
    if (walletBalanceUsd < amountUsd) {
      log.info(
        { event: 'apify_prepaid_wallet_unfunded', walletBalanceUsd, minimumUsd: amountUsd, locusReason, liveBalanceUsd: out.liveBalanceUsd },
        'Apify prepaid token needed, Locus could not pay, and the emergency wallet cannot either; standing down until one is funded',
      );
      return { ...out, skipped: 'wallet_unfunded', purchased: false };
    }
    log.error(
      { event: 'apify_prepaid_wallet_fallback_used', walletBalanceUsd, amountUsd, locusReason, liveBalanceUsd: out.liveBalanceUsd },
      'Apify prepaid token is being bought from the x402 wallet: Locus could not fund it and the emergency flag is set',
    );
    funding = 'x402_wallet';
    outcome = await purchaseX402PrepaidToken({ vendor: APIFY_PREPAID_VENDOR, amountUsd, funding });
    if (!outcome.purchased) {
      log.warn({ event: 'apify_prepaid_purchase_refused', reason: outcome.reason, amountUsd, funding }, 'Apify prepaid token purchase refused');
      return { ...out, purchased: false, refused: outcome.reason, purchasesToday };
    }
  }
  const { purchase } = outcome;
  // What the purchase says it was funded by, and failing that what was asked
  // for: a Locus purchase recorded as the wallet's would send the run it
  // funds down the wallet's booking path.
  const fundedBy: X402PrepaidTokenFunder = purchase.fundedBy ?? funding;
  const id = randomUUID();
  const secretName = await putPlatformPrepaidSecret(APIFY_PREPAID_VENDOR, id, purchase.token);
  await getPool().query(
    `INSERT INTO platform_prepaid_tokens
       (id, vendor, secret_name, purchased_usd, balance_usd, purchased_at, expires_at, purchase_tx, last_checked_at, funded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6, $9)`,
    [id, APIFY_PREPAID_VENDOR, secretName, purchase.paidUsd > 0 ? purchase.paidUsd : amountUsd, purchase.balanceUsd, now, new Date(purchase.expiresAt), purchase.transaction ?? null, fundedBy],
  );
  log.info(
    { event: 'apify_prepaid_token_bought', purchaseId: id, amountUsd, paidUsd: purchase.paidUsd, balanceUsd: purchase.balanceUsd, expiresAt: purchase.expiresAt, purchasesToday: purchasesToday + 1, fundedBy },
    fundedBy === 'locus' ? "Apify prepaid token bought with the platform's Locus credits" : 'Apify prepaid token bought from the x402 wallet',
  );
  return { ...out, purchased: true, amountUsd, expiresAt: purchase.expiresAt, purchasesToday: purchasesToday + 1, fundedBy };
}
