// Liftoff Switch — local migration state (~/.liftoff/switch-state.json).
//
// Deliberately tiny. This file holds ONLY what is needed to resume: the
// migration id, which source it came from, the installation fingerprint that
// identifies the installation it was taken from, and the last known server
// state. It never holds imported secrets, and never a second copy of the source
// state — the bundle lives on the server once uploaded, and the source
// installation remains the user's own.
//
// Directory 0700, file 0600, matching the existing proxy-state store.

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MigrationSource } from './contract';

/** Server-side orchestration states, mirrored locally only so a re-run can
 *  pick the right resume branch without a round trip when offline. The server
 *  remains authoritative: `switch` re-reads it whenever it can reach the API. */
export type MigrationState =
  | 'importing'
  | 'setup_required'
  | 'payment_required'
  | 'conversion_queued'
  | 'converting'
  | 'conversion_ready'
  | 'ready_to_cutover'
  | 'active'
  | 'failed';

export interface SwitchMigrationRecord {
  migrationId: string;
  source: MigrationSource;
  installationFingerprint: string;
  tenantId: string;
  /** Last state observed from the server. Advisory only. */
  lastKnownState: MigrationState;
  createdAt: string;
  updatedAt: string;
}

export interface SwitchState {
  version: 1;
  /** Keyed by `${source}:${installationFingerprint}` so two installations of
   *  the same source on one machine resume independently. */
  migrations: Record<string, SwitchMigrationRecord>;
}

function getStateDir(): string {
  return path.join(os.homedir(), '.liftoff');
}

function getStatePath(): string {
  return path.join(getStateDir(), 'switch-state.json');
}

export function migrationKey(source: MigrationSource, installationFingerprint: string): string {
  return `${source}:${installationFingerprint}`;
}

function emptyState(): SwitchState {
  return { version: 1, migrations: {} };
}

export function loadSwitchState(): SwitchState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(getStatePath(), 'utf-8'));
  } catch {
    return emptyState();
  }
  const obj = raw as Record<string, unknown>;
  if (obj && obj.version === 1 && typeof obj.migrations === 'object' && obj.migrations !== null) {
    return obj as unknown as SwitchState;
  }
  return emptyState();
}

function writeStateFile(state: SwitchState): void {
  if (!fs.existsSync(getStateDir())) {
    fs.mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function findMigration(
  source: MigrationSource,
  installationFingerprint: string,
): SwitchMigrationRecord | null {
  const state = loadSwitchState();
  return state.migrations[migrationKey(source, installationFingerprint)] ?? null;
}

export function saveMigration(record: SwitchMigrationRecord): void {
  const state = loadSwitchState();
  state.migrations[migrationKey(record.source, record.installationFingerprint)] = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  writeStateFile(state);
}

export function updateMigrationState(
  source: MigrationSource,
  installationFingerprint: string,
  lastKnownState: MigrationState,
): void {
  const existing = findMigration(source, installationFingerprint);
  if (!existing) return;
  saveMigration({ ...existing, lastKnownState });
}

export function deleteMigration(source: MigrationSource, installationFingerprint: string): void {
  const state = loadSwitchState();
  delete state.migrations[migrationKey(source, installationFingerprint)];
  writeStateFile(state);
}
