// Team presets — YAML loader.
//
// The catalog loader (loader.ts) reads only catalog/; presets get their own loader
// over team-presets/. Schema-fatal files throw at boot (same fail-fast posture as the
// catalog). Idempotent: subsequent init calls are no-ops.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { log } from '../infrastructure/logging';
import { teamPresetZodSchema, type TeamPreset } from './team-preset-validator';

const presets = new Map<string, TeamPreset>();
let initialized = false;

function getPresetsDir(overrideDir?: string): string | null {
  if (overrideDir) return overrideDir;
  // ts-jest: __dirname = .../src/agent-templates ; compiled: .../dist/agent-templates
  const candidate1 = path.join(__dirname, 'team-presets');
  if (fs.existsSync(candidate1)) return candidate1;
  const candidate2 = path.join(__dirname, '..', '..', 'src', 'agent-templates', 'team-presets');
  if (fs.existsSync(candidate2)) return candidate2;
  return null;
}

export function initTeamPresetLoader(presetsDirOverride?: string): void {
  if (initialized && !presetsDirOverride) return;
  presets.clear();

  const dir = getPresetsDir(presetsDirOverride);
  if (dir === null) {
    // A missing presets directory disables team-provisioning presets ONLY — it must not
    // crash the whole control-plane API. (Malformed presets below still fail loud.) The
    // Dockerfile copies src/agent-templates/team-presets into dist/ like the catalog.
    log.warn('Team presets directory not found — team presets unavailable (feature disabled)');
    initialized = true;
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    const full = path.join(dir, file);
    const raw = yaml.load(fs.readFileSync(full, 'utf8'));
    const parsed = teamPresetZodSchema.safeParse(raw);
    if (!parsed.success) {
      // Schema-fatal — crash boot rather than serve a malformed preset.
      throw new Error(`Team preset "${file}" failed validation: ${parsed.error.message}`);
    }
    if (presets.has(parsed.data.id)) {
      throw new Error(`Duplicate team preset id "${parsed.data.id}" (${file})`);
    }
    presets.set(parsed.data.id, parsed.data);
  }

  initialized = true;
  log.info({ count: presets.size }, 'Team preset loader initialized');
}

export function listTeamPresets(): TeamPreset[] {
  if (!initialized) initTeamPresetLoader();
  return Array.from(presets.values());
}

export function getTeamPreset(id: string): TeamPreset | null {
  if (!initialized) initTeamPresetLoader();
  return presets.get(id) ?? null;
}
