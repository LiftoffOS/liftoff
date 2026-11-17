import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config';
import { UnauthorizedError } from '../shared/errors';
import type { SandboxJwtClaims } from '@liftoffos/sandbox-contracts';

function secretKey(): Uint8Array {
  return Buffer.from(config.jwtSecret, 'hex');
}

export async function verifyBearerJwt(authHeader: string | undefined): Promise<SandboxJwtClaims> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('missing_bearer');
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if ((payload as JWTPayload & { sandboxId?: string }).sandboxId !== config.sandboxId) {
      throw new UnauthorizedError('sandbox_mismatch');
    }
    return payload as unknown as SandboxJwtClaims;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError(`jwt_invalid: ${(err as Error).message}`);
  }
}

export async function signSidecarJwt(scopes: string[]): Promise<string> {
  return new SignJWT({
    sandboxId: config.sandboxId,
    tenantId: config.tenantId,
    agentId: config.agentId,
    instructionVersion: config.instructionVersion,
    scopes,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secretKey());
}
