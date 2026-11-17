// A provider nobody added to PROVIDER_MAP leaks the vendor's name.
//
// The lookup is `PROVIDER_MAP[value] ?? value`, so the failure is not a blank
// or an error — it is the customer reading "deepseek" on a surface whose entire
// purpose is that they never do. Five had accumulated: xai, glm, qwen, deepseek
// and kimi all became providers while the map held the six it was born with.
//
// This lives in platform-backend rather than beside the map, because
// src/branding/registry.ts is mirrored byte-for-byte into @liftoffos/shared-types
// and so cannot import from src/. The map stays hand-written; this is what
// makes the hand-written version safe.

import { PROVIDER_MAP, MODEL_ID_MAP } from '../registry';
import { WORKSPACE_AI_VENDORS, type WorkspaceAiVendor } from '../../model-registry/workspace-ai-vendors';

const VENDORS = Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[];

describe('branding covers every provider a run can resolve', () => {
  it('redacts every vendor record provider', () => {
    const unmapped = VENDORS
      .map((v) => WORKSPACE_AI_VENDORS[v].provider)
      .filter((p) => PROVIDER_MAP[p] !== 'liftoff');

    expect({
      unmapped,
      hint: unmapped.length
        ? 'Add these to PROVIDER_MAP in src/branding/registry.ts AND the mirrored '
          + 'copy in packages/shared-types/src/branding.ts. Unmapped, the lookup '
          + "returns the vendor's own name to the customer."
        : '',
    }).toEqual({ unmapped: [], hint: '' });
  });

  // The transport names are not families and are not in the vendor record, but
  // they reach the same lookup: a stored row still says 'openrouter', and
  // Anthropic is reached two ways.
  it('redacts the transport names too', () => {
    for (const name of ['openrouter', 'anthropic-vertex', 'vertex-ai']) {
      expect({ name, codename: PROVIDER_MAP[name] }).toEqual({ name, codename: 'liftoff' });
    }
  });

  // Every tier model of every vendor, under the provider-qualified form a cost
  // surface puts in a payload and under the bare form a usage row carries.
  it('redacts every seeded model under both the bare and qualified forms', () => {
    const missing: string[] = [];
    for (const vendor of VENDORS) {
      const spec = WORKSPACE_AI_VENDORS[vendor];
      // The Frontier model too: its registry row has no tier, so the static map
      // is the ONLY thing that can brand it.
      const ids = [...Object.values(spec.tiers), ...(spec.frontier ? [spec.frontier] : [])];
      for (const modelId of ids) {
        if (!MODEL_ID_MAP[modelId]) missing.push(modelId);
        // The qualified form is derived for namespaced ids only; a bare id
        // (Anthropic, OpenAI, Google, Grok) never appears prefixed in a payload
        // because those rate keys are looked up bare.
        if (modelId.includes('/') && !MODEL_ID_MAP[`${spec.provider}:${modelId}`]) {
          missing.push(`${spec.provider}:${modelId}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
