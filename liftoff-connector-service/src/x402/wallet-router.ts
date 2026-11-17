// The x402 wallet, as platform-backend sees it.
//
// The wallet is spent from HERE (the signer) and watched from platform-backend
// (balance, reconciliation, reload), which knows the wallet only by the
// address in its own X402_WALLET_ADDRESS. The two custodians hold different
// addresses, so a provider switch that changes only one side leaves
// platform-backend guarding a wallet nobody spends from. This route is how
// platform-backend reads the live signer's address and compares.
//
// The same router sells prepaid vendor credit from the wallet
// (POST /prepaid-tokens): platform-backend asks for a token, the wallet pays
// the vendor's x402 challenge here where the signer lives (or, with
// `funding: 'locus'`, the platform's Locus credits pay it), and the token goes
// back to platform-backend to hold and spend. A refusal (the spend guard's
// cap or ceiling, a vendor that will not sell) answers 409 with its reason;
// bad input 400; a vendor answer nobody recognises 502.
//
// Mounted behind verifyServiceAuth with the other internal routes. The
// wallet read answers 200 in every state — a wallet that is not configured
// is a fact to report, not a failure — and never an error message that could
// carry a credential.

import { Router, type Request, type Response } from 'express';
import { logger } from '../infra/logging.js';
import { getX402WalletAddress, isX402Configured, x402WalletProvider, X402NotConfiguredError } from './wallet.js';
import { X402SpendRefusedError } from './spend-guard.js';
import { PREPAID_TOKEN_FUNDERS, PrepaidTokenError, purchasePrepaidToken, purchasePrepaidTokenViaLocus, type PrepaidTokenFunder } from './prepaid-tokens.js';

export const x402WalletRouter = Router();

export interface X402WalletStatus {
  provider: 'cdp' | 'circle' | null;
  configured: boolean;
  address?: `0x${string}`;
  /** Present when the custodian could not be reached or refused. */
  error?: string;
}

export async function describeX402Wallet(): Promise<X402WalletStatus> {
  const provider = x402WalletProvider();
  const configured = isX402Configured();
  if (!configured) return { provider, configured };
  try {
    return { provider, configured, address: await getX402WalletAddress() };
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider }, 'x402 wallet: signer resolution failed');
    return { provider, configured, error: 'signer_unavailable' };
  }
}

x402WalletRouter.get('/wallet', async (_req: Request, res: Response) => {
  res.json(await describeX402Wallet());
});

x402WalletRouter.post('/prepaid-tokens', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { vendor?: unknown; amountUsd?: unknown; funding?: unknown };
  const vendor = typeof body.vendor === 'string' ? body.vendor : '';
  const amountUsd = typeof body.amountUsd === 'number' ? body.amountUsd : Number.NaN;
  // Who pays: the wallet unless the caller names the Locus fallback.
  const funding: PrepaidTokenFunder | null = body.funding === undefined
    ? 'x402_wallet'
    : (PREPAID_TOKEN_FUNDERS as readonly unknown[]).includes(body.funding) ? (body.funding as PrepaidTokenFunder) : null;
  if (funding === null) {
    res.status(400).json({ error: `funding must be one of ${PREPAID_TOKEN_FUNDERS.join(', ')}`, reason: 'bad_request' });
    return;
  }
  try {
    const purchase = funding === 'locus'
      ? await purchasePrepaidTokenViaLocus(vendor, amountUsd)
      : await purchasePrepaidToken(vendor, amountUsd);
    res.status(201).json(purchase);
  } catch (err) {
    if (err instanceof PrepaidTokenError && err.reason === 'bad_request') {
      res.status(400).json({ error: err.message, reason: err.reason });
      return;
    }
    if (err instanceof PrepaidTokenError && err.reason === 'vendor_answer_unrecognised') {
      logger.error({ event: 'x402_prepaid_token_unrecognised', vendor }, err.message);
      res.status(502).json({ error: err.message, reason: err.reason });
      return;
    }
    if (err instanceof PrepaidTokenError || err instanceof X402SpendRefusedError || err instanceof X402NotConfiguredError) {
      const reason = err instanceof X402SpendRefusedError
        ? err.reason
        : err instanceof X402NotConfiguredError ? 'wallet_not_configured' : err.reason;
      logger.warn({ event: 'x402_prepaid_token_refused', vendor, amountUsd, reason }, err.message);
      res.status(409).json({ error: err.message, reason });
      return;
    }
    logger.error({ event: 'x402_prepaid_token_failed', vendor, amountUsd, err: (err as Error).message }, 'prepaid token purchase failed');
    res.status(500).json({ error: 'prepaid token purchase failed', reason: 'error' });
  }
});
