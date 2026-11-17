// Team presets load, validate, and reference real catalog templates.

import * as fs from 'fs';
import * as path from 'path';
import { initTeamPresetLoader, listTeamPresets, getTeamPreset } from '../team-preset-loader';
import { teamPresetZodSchema } from '../team-preset-validator';
import { initTemplateLoader, getTemplate } from '../loader';

const PRESETS_DIR = path.join(__dirname, '..', 'team-presets');
const CATALOG_DIR = path.join(__dirname, '..', 'catalog');

beforeAll(() => {
  initTemplateLoader(CATALOG_DIR);
  initTeamPresetLoader(PRESETS_DIR);
});

describe('team presets — catalog', () => {
  it('every team-presets/*.yaml passes the zod schema', () => {
    const yaml = require('js-yaml');
    const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = yaml.load(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      const parsed = teamPresetZodSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
    }
  });

  it('the software-delivery-team preset loads with its four roles', () => {
    const preset = getTeamPreset('software-delivery-team');
    expect(preset).not.toBeNull();
    expect(preset!.roles.map((r) => r.key).sort()).toEqual(['engineer', 'performance', 'reviewer', 'security']);
  });

  it('every role references a real catalog template id', () => {
    for (const preset of listTeamPresets()) {
      for (const role of preset.roles) {
        expect(getTemplate(role.templateId)).not.toBeNull();
      }
    }
  });

  it('role keys are unique within a preset', () => {
    for (const preset of listTeamPresets()) {
      const keys = preset.roles.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
