import { randomBytes } from 'crypto';
import { SignJWT } from 'jose';

const SANDBOX_ID = 'sandbox-test1';
const SECRET_HEX = randomBytes(32).toString('hex');

beforeAll(() => {
  process.env.SANDBOX_ID = SANDBOX_ID;
  process.env.TENANT_ID = 'tenant-1';
  process.env.AGENT_ID = 'agent-1';
  process.env.INSTRUCTION_VERSION = '7';
  process.env.RUNTIME_BASE_URL = 'http://runtime.local';
  process.env.SANDBOX_JWT_SECRET = SECRET_HEX;
});

afterAll(() => {
  delete process.env.SANDBOX_ID;
  delete process.env.TENANT_ID;
  delete process.env.AGENT_ID;
  delete process.env.INSTRUCTION_VERSION;
  delete process.env.RUNTIME_BASE_URL;
  delete process.env.SANDBOX_JWT_SECRET;
});

async function mintJwt(opts: { sandboxId?: string; expSecondsFromNow?: number } = {}): Promise<string> {
  return new SignJWT({ sandboxId: opts.sandboxId ?? SANDBOX_ID, tenantId: 'tenant-1', agentId: 'agent-1', instructionVersion: 7, scopes: ['mcp:dispatch'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${opts.expSecondsFromNow ?? 60}s`)
    .sign(Buffer.from(SECRET_HEX, 'hex'));
}

describe('verifyBearerJwt', () => {
  it('accepts a valid bearer with matching sandboxId', async () => {
    const { verifyBearerJwt } = await import('../../auth/jwt');
    const jwt = await mintJwt();
    const claims = await verifyBearerJwt(`Bearer ${jwt}`);
    expect(claims.sandboxId).toBe(SANDBOX_ID);
    expect(claims.tenantId).toBe('tenant-1');
  });

  it('rejects when no bearer prefix is supplied', async () => {
    const { verifyBearerJwt } = await import('../../auth/jwt');
    await expect(verifyBearerJwt(undefined)).rejects.toThrow(/missing_bearer/);
    await expect(verifyBearerJwt('Token foo')).rejects.toThrow(/missing_bearer/);
  });

  it('rejects when the claim sandboxId does not match config', async () => {
    const { verifyBearerJwt } = await import('../../auth/jwt');
    const jwt = await mintJwt({ sandboxId: 'sandbox-other' });
    await expect(verifyBearerJwt(`Bearer ${jwt}`)).rejects.toThrow(/sandbox_mismatch|jwt_invalid/);
  });

  it('rejects an expired token', async () => {
    const { verifyBearerJwt } = await import('../../auth/jwt');
    const expired = await new SignJWT({ sandboxId: SANDBOX_ID })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(Buffer.from(SECRET_HEX, 'hex'));
    await expect(verifyBearerJwt(`Bearer ${expired}`)).rejects.toThrow(/jwt_invalid|exp/);
  });

  it('rejects a malformed jwt', async () => {
    const { verifyBearerJwt } = await import('../../auth/jwt');
    await expect(verifyBearerJwt('Bearer not-a-jwt')).rejects.toThrow(/jwt_invalid/);
  });
});
