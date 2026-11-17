// Requires: npm install @google-cloud/storage (not a standard dep — ops tool only)

/**
 * tools/cutover-runner/index.ts
 *
 * Manages the GCS mode-flag cut-over for /api/workforce/* traffic.
 *
 * The mode flag is a JSON blob stored in GCS:
 *   { "mode": "legacy" | "holding" | "new", "updatedAt": "<ISO>", "updatedBy": "<string>" }
 *
 * Env vars:
 *   MODE_FLAG_BUCKET  – GCS bucket name (required)
 *   MODE_FLAG_OBJECT  – GCS object path (default: workforce-service-mode-flag.json)
 *
 * Commands (process.argv[2]):
 *   status       – print current mode flag
 *   set-holding  – transition legacy → holding
 *   set-new      – transition holding → new
 *   rollback     – go back one step (new → holding, or holding → legacy)
 *
 * Usage:
 *   npx tsx tools/cutover-runner/index.ts <command>
 */

import { Storage } from '@google-cloud/storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = 'legacy' | 'holding' | 'new';

interface ModeFlag {
  mode: Mode;
  updatedAt: string;
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BUCKET_NAME = process.env['MODE_FLAG_BUCKET'];
const OBJECT_NAME = process.env['MODE_FLAG_OBJECT'] ?? 'workforce-service-mode-flag.json';
const UPDATED_BY = process.env['USER'] ?? 'unknown';

if (!BUCKET_NAME) {
  console.error('ERROR: MODE_FLAG_BUCKET env var is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

// Valid forward transitions
const FORWARD_TRANSITIONS: Record<Mode, Mode | null> = {
  legacy: 'holding',
  holding: 'new',
  new: null, // no forward transition from new
};

// Valid backward (rollback) transitions
const ROLLBACK_TRANSITIONS: Record<Mode, Mode | null> = {
  new: 'holding',
  holding: 'legacy',
  legacy: null, // already at the start
};

// ---------------------------------------------------------------------------
// GCS helpers
// ---------------------------------------------------------------------------

const storage = new Storage();

async function readModeFlag(): Promise<ModeFlag | null> {
  try {
    const [contents] = await storage.bucket(BUCKET_NAME!).file(OBJECT_NAME).download();
    const parsed = JSON.parse(contents.toString('utf-8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'mode' in parsed &&
      typeof (parsed as Record<string, unknown>)['mode'] === 'string'
    ) {
      return parsed as ModeFlag;
    }
    throw new Error('Invalid mode flag object shape in GCS');
  } catch (err: unknown) {
    // If the object doesn't exist yet, treat as legacy
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code: number | string }).code
        : null;
    if (code === 404 || code === '404') {
      return null;
    }
    throw err;
  }
}

async function writeModeFlag(flag: ModeFlag): Promise<void> {
  const json = JSON.stringify(flag, null, 2);
  await storage
    .bucket(BUCKET_NAME!)
    .file(OBJECT_NAME)
    .save(json, { contentType: 'application/json' });
}

function printFlag(flag: ModeFlag | null, label = 'Current mode flag'): void {
  if (!flag) {
    console.log(`${label}: (not set — treating as "legacy")`);
    return;
  }
  console.log(`${label}:`);
  console.log(`  mode      : ${flag.mode}`);
  console.log(`  updatedAt : ${flag.updatedAt}`);
  console.log(`  updatedBy : ${flag.updatedBy}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const flag = await readModeFlag();
  printFlag(flag);
}

async function cmdSetHolding(): Promise<void> {
  const current = await readModeFlag();
  const currentMode: Mode = current?.mode ?? 'legacy';

  const next = FORWARD_TRANSITIONS[currentMode];
  if (next !== 'holding') {
    console.error(
      `ERROR: Cannot transition to "holding" from "${currentMode}". ` +
        `Expected current mode to be "legacy".`,
    );
    process.exit(1);
  }

  const newFlag: ModeFlag = {
    mode: 'holding',
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  };

  printFlag(current, 'Previous mode flag');
  await writeModeFlag(newFlag);
  printFlag(newFlag, 'New mode flag');
  console.log('\nTraffic is now PAUSED (holding). No writes will be accepted.');
}

async function cmdSetNew(): Promise<void> {
  const current = await readModeFlag();
  const currentMode: Mode = current?.mode ?? 'legacy';

  const next = FORWARD_TRANSITIONS[currentMode];
  if (next !== 'new') {
    console.error(
      `ERROR: Cannot transition to "new" from "${currentMode}". ` +
        `Expected current mode to be "holding".`,
    );
    process.exit(1);
  }

  const newFlag: ModeFlag = {
    mode: 'new',
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  };

  printFlag(current, 'Previous mode flag');
  await writeModeFlag(newFlag);
  printFlag(newFlag, 'New mode flag');
  console.log('\nTraffic is now forwarded to the workforce-service ("new").');
}

async function cmdRollback(): Promise<void> {
  const current = await readModeFlag();
  const currentMode: Mode = current?.mode ?? 'legacy';

  const next = ROLLBACK_TRANSITIONS[currentMode];
  if (next === null) {
    console.error(
      `ERROR: Cannot roll back from "${currentMode}" — already at the initial state.`,
    );
    process.exit(1);
  }

  const newFlag: ModeFlag = {
    mode: next,
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  };

  printFlag(current, 'Previous mode flag');
  await writeModeFlag(newFlag);
  printFlag(newFlag, 'New mode flag');
  console.log(`\nRolled back: "${currentMode}" → "${next}".`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'status':
      await cmdStatus();
      break;

    case 'set-holding':
      await cmdSetHolding();
      break;

    case 'set-new':
      await cmdSetNew();
      break;

    case 'rollback':
      await cmdRollback();
      break;

    default:
      console.error(
        `ERROR: Unknown command "${command ?? '(none)'}".\n` +
          'Usage: npx tsx tools/cutover-runner/index.ts <command>\n' +
          'Commands: status | set-holding | set-new | rollback',
      );
      process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('[cutover-runner] FATAL:', err);
  process.exit(1);
});
