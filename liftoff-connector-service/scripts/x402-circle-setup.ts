// One-time Circle wallet setup for the x402 signer, idempotent.
//
//   CIRCLE_API_KEY=... npm run x402:circle:setup -- --env dev [--new-entity-secret --recovery-dir <dir>]
//   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... npm run x402:circle:setup -- --env dev --register-entity-secret --recovery-dir <dir>
//   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... npm run x402:circle:setup -- --env prod
//
// What it does, in order, skipping whatever already exists:
//   1. Entity secret. With --new-entity-secret it generates 32 random bytes,
//      registers their ciphertext with Circle (the account's signing
//      authority from then on) and writes the recovery file Circle answers
//      with into --recovery-dir. Keep that file: it is the only way to reset
//      the entity secret if it is lost. With --register-entity-secret it
//      registers the one in CIRCLE_ENTITY_SECRET the same way (for a secret
//      generated elsewhere and already stored, so it is never printed).
//      Without either flag the secret comes from CIRCLE_ENTITY_SECRET
//      (already registered).
//   2. Wallet set `x402-<env>` (found by name, else created).
//   3. One EOA wallet on Base mainnet in that set (found, else created).
//   4. Prints the wallet id and address, and the three settings to put in
//      Secret Manager / the environment. The entity secret is printed ONLY
//      when it was just generated, once, so it can be stored; nothing else
//      ever prints it.
//
// Everything is REST (see src/x402/circle-signer.ts for why the SDK is not
// used). Each POST carries a fresh ciphertext and an idempotency key, so a
// rerun after a network failure cannot create a second set or wallet.

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CIRCLE_API_BASE,
  CIRCLE_BASE_MAINNET,
  circleHeaders,
  entitySecretCiphertext,
  fetchEntityPublicKey,
} from '../src/x402/circle-signer.js';

interface Args {
  env: string;
  newEntitySecret: boolean;
  registerEntitySecret: boolean;
  recoveryDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { env: '', newEntitySecret: false, registerEntitySecret: false, recoveryDir: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') args.env = argv[++i] ?? '';
    else if (a === '--new-entity-secret') args.newEntitySecret = true;
    else if (a === '--register-entity-secret') args.registerEntitySecret = true;
    else if (a === '--recovery-dir') args.recoveryDir = argv[++i] ?? '.';
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['dev', 'prod'].includes(args.env)) throw new Error('--env dev|prod is required');
  return args;
}

async function circle<T>(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CIRCLE_API_BASE}${path}`, {
    method,
    headers: circleHeaders(apiKey),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Circle ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { data?: T };
  if (!parsed.data) throw new Error(`Circle ${method} ${path} answered without data`);
  return parsed.data;
}

/** A stable idempotency key per (env, purpose): a rerun replays the same
 *  request and Circle answers 200 with the existing resource. */
function idempotencyKeyFor(env: string, purpose: string): string {
  const h = createHash('sha256').update(`x402:${env}:${purpose}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.CIRCLE_API_KEY?.trim();
  if (!apiKey) throw new Error('CIRCLE_API_KEY is required');

  const publicKeyPem = await fetchEntityPublicKey(apiKey);

  // 1. Entity secret.
  let entitySecret = process.env.CIRCLE_ENTITY_SECRET?.trim() ?? '';
  let generated = false;
  if (args.newEntitySecret) {
    if (entitySecret) throw new Error('CIRCLE_ENTITY_SECRET is set; refusing to generate a second one');
    entitySecret = randomBytes(32).toString('hex');
    generated = true;
  } else if (!entitySecret) {
    throw new Error('CIRCLE_ENTITY_SECRET is required unless --new-entity-secret');
  }
  if (args.newEntitySecret || args.registerEntitySecret) {
    const reg = await circle<{ recoveryFile?: string }>(apiKey, 'POST', '/config/entity/entitySecret', {
      entitySecretCiphertext: entitySecretCiphertext(publicKeyPem, entitySecret),
    });
    if (!reg.recoveryFile) throw new Error('Circle registered the entity secret but returned no recovery file');
    mkdirSync(args.recoveryDir, { recursive: true });
    const recoveryPath = join(args.recoveryDir, `circle-entity-secret-recovery-${args.env}-${Date.now()}.dat`);
    writeFileSync(recoveryPath, reg.recoveryFile, { mode: 0o600 });
    console.log(`entity secret registered; recovery file written to ${recoveryPath} (keep it offline)`);
  }

  // 2. Wallet set.
  const setName = `x402-${args.env}`;
  const sets = await circle<{ walletSets?: Array<{ id: string; name?: string }> }>(apiKey, 'GET', '/walletSets?pageSize=50');
  let walletSet = (sets.walletSets ?? []).find((s) => s.name === setName);
  if (!walletSet) {
    const created = await circle<{ walletSet: { id: string; name?: string } }>(apiKey, 'POST', '/developer/walletSets', {
      idempotencyKey: idempotencyKeyFor(args.env, 'wallet-set'),
      entitySecretCiphertext: entitySecretCiphertext(publicKeyPem, entitySecret),
      name: setName,
    });
    walletSet = created.walletSet;
    console.log(`wallet set ${setName} created: ${walletSet.id}`);
  } else {
    console.log(`wallet set ${setName} exists: ${walletSet.id}`);
  }

  // 3. The one EOA wallet on Base mainnet.
  const listed = await circle<{ wallets?: Array<{ id: string; address: string; blockchain: string; state: string; accountType?: string }> }>(
    apiKey, 'GET', `/wallets?walletSetId=${encodeURIComponent(walletSet.id)}&blockchain=${CIRCLE_BASE_MAINNET}&pageSize=10`,
  );
  let wallet = (listed.wallets ?? []).find((w) => w.blockchain === CIRCLE_BASE_MAINNET);
  if (!wallet) {
    const created = await circle<{ wallets: Array<{ id: string; address: string; blockchain: string; state: string; accountType?: string }> }>(
      apiKey, 'POST', '/developer/wallets', {
        idempotencyKey: idempotencyKeyFor(args.env, 'wallet'),
        entitySecretCiphertext: entitySecretCiphertext(publicKeyPem, entitySecret),
        walletSetId: walletSet.id,
        blockchains: [CIRCLE_BASE_MAINNET],
        accountType: 'EOA',
        count: 1,
        metadata: [{ name: 'x402-wallet' }],
      },
    );
    wallet = created.wallets[0];
    console.log(`wallet created on ${wallet.blockchain}: ${wallet.id}`);
  } else {
    console.log(`wallet exists on ${wallet.blockchain}: ${wallet.id} (${wallet.state})`);
  }

  // 4. What to store.
  console.log('');
  console.log(`CIRCLE_X402_WALLET_ID=${wallet.id}`);
  console.log(`X402_WALLET_ADDRESS=${wallet.address}`);
  console.log(`X402_WALLET_PROVIDER=circle`);
  if (generated) {
    console.log('');
    console.log('The new entity secret, shown once — store it as the x402-circle_entity_secret secret now:');
    console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
