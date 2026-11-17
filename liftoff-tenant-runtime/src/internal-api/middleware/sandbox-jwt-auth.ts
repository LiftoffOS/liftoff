import type { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';
import { getPoolForService } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';

export interface SandboxClaims {
  sandboxId: string;
  tenantId: string;
  agentId: string;
  instructionVersion: number;
  scopes?: string[];
  exp: number;
}

interface RequestWithClaims extends Request {
  sandboxClaims?: SandboxClaims;
}

const pool = getPoolForService('default');
const SECRET_CACHE_TTL_MS = 5 * 60_000; // 5 min — matches the live-sandbox cache window
const secretCache = new Map<string, { secret: Buffer; expires: number }>();

// Lazy-instantiated module-level KMS client. Reused across all decrypts. Built
// the first time loadJwtSecret needs it; tests that don't touch KMS never pay
// the import + auth handshake.
let kmsClient: import('@google-cloud/kms').KeyManagementServiceClient | null = null;
let kmsImportPromise: Promise<typeof import('@google-cloud/kms')> | null = null;

async function getKmsClient(): Promise<import('@google-cloud/kms').KeyManagementServiceClient> {
  if (kmsClient) return kmsClient;
  if (!kmsImportPromise) kmsImportPromise = import('@google-cloud/kms');
  const { KeyManagementServiceClient } = await kmsImportPromise;
  kmsClient = new KeyManagementServiceClient();
  return kmsClient;
}

async function loadJwtSecret(sandboxId: string): Promise<Buffer> {
  const cached = secretCache.get(sandboxId);
  if (cached && cached.expires > Date.now()) return cached.secret;

  const result = await pool.query('SELECT jwt_secret_encrypted FROM sandbox_state WHERE sandbox_id = $1', [sandboxId]);
  if (!result.rows[0]) throw new Error('unknown_sandbox');
  const ciphertext = result.rows[0].jwt_secret_encrypted as Buffer | null;
  if (!ciphertext) throw new Error('no_secret_persisted');

  const kmsKey = process.env.SANDBOX_KMS_KEY_NAME;
  if (!kmsKey) throw new Error('SANDBOX_KMS_KEY_NAME env missing');
  const kms = await getKmsClient();
  const [resp] = await kms.decrypt({ name: kmsKey, ciphertext });
  const secret = Buffer.from(resp.plaintext as Uint8Array);
  secretCache.set(sandboxId, { secret, expires: Date.now() + SECRET_CACHE_TTL_MS });
  return secret;
}

export async function verifySandboxJwt(authHeader: string | undefined): Promise<SandboxClaims> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('missing_bearer');
  const token = authHeader.slice('Bearer '.length);
  const decoded = jose.decodeJwt(token);
  const sandboxId = (decoded as Record<string, unknown>).sandboxId as string | undefined;
  if (!sandboxId) throw new Error('missing_sandbox_id_claim');
  const secret = await loadJwtSecret(sandboxId);
  const { payload } = await jose.jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as unknown as SandboxClaims;
}

export function requireSandboxJwt(req: RequestWithClaims, res: Response, next: NextFunction): void {
  // When proxied through sandbox-executor, the per-sandbox JWT arrives in
  // X-Sandbox-Token (Authorization is reserved for the Cloud Run invoker OIDC
  // that this --no-allow-unauthenticated service's frontend validates). Fall
  // back to Authorization for any direct, non-proxied caller.
  const sandboxToken =
    (req.headers['x-sandbox-token'] as string | undefined) ??
    (req.headers['authorization'] as string | undefined);
  verifySandboxJwt(sandboxToken)
    .then(claims => {
      req.sandboxClaims = claims;
      next();
    })
    .catch(err => {
      log.warn({ message: 'sandbox jwt verification failed', error: (err as Error).message });
      res.status(401).json({ error: 'unauthorized', message: (err as Error).message });
    });
}

export type { RequestWithClaims };
