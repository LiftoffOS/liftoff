// Translation resolution — tenant-runtime's stable-name router calls
// resolveTranslations(toolkit, vendorName) to get the per-tool translate
// functions sourced from the overlay map.

import { COMPOSIO_TOOL_OVERLAYS } from './overlays';
import { COMPOSIO_TOOL_SCHEMAS } from './schemas';
import { defaultComposioErrorMap } from './canonical-shapes';
import type { ComposioToolOverlay, NormalizedToolError } from './types';

export interface ResolvedTranslations {
  translateInput?: (canonical: Record<string, unknown>) => Record<string, unknown>;
  translateOutput?: (vendorRespData: unknown) => unknown;
  translateError: (err: { code: number; message: string; data?: unknown }) => NormalizedToolError;
  polling?: ComposioToolOverlay['polling'];
  enrichBeforeExecute?: ComposioToolOverlay['enrichBeforeExecute'];
}

/** Returns the per-tool translation set for a given (toolkit, vendor tool name).
 *  translateError defaults to defaultComposioErrorMap when the overlay omits
 *  one. translateInput / translateOutput / polling / enrichBeforeExecute are
 *  undefined when the overlay doesn't define them — callers default to
 *  passthrough. */
export function resolveTranslations(
  toolkit: string,
  vendorToolName: string,
): ResolvedTranslations {
  const overlay = COMPOSIO_TOOL_OVERLAYS[toolkit]?.[vendorToolName];
  return {
    translateInput: overlay?.translateInput,
    translateOutput: overlay?.translateOutput,
    translateError: overlay?.translateError ?? defaultComposioErrorMap,
    polling: overlay?.polling,
    enrichBeforeExecute: overlay?.enrichBeforeExecute,
  };
}

/** Resolve the overlay record (full object) for a given (toolkit, vendor).
 *  Returns undefined when no overlay exists — caller must hard-fail
 *  (boot-time validator enforces overlay coverage per C2 rules). */
export function resolveOverlay(
  toolkit: string,
  vendorToolName: string,
): ComposioToolOverlay | undefined {
  return COMPOSIO_TOOL_OVERLAYS[toolkit]?.[vendorToolName];
}

/** Reverse lookup: stable name → overlay + vendor tool name (within toolkit).
 *  Used by C5 router after dispatch to find the polling status tool's vendor
 *  name when overlay.polling.statusToolStableName is set. */
export function resolveOverlayByStableName(
  toolkit: string,
  stableName: string,
): { vendorToolName: string; overlay: ComposioToolOverlay } | undefined {
  const block = COMPOSIO_TOOL_OVERLAYS[toolkit];
  if (!block) return undefined;
  for (const [vendor, overlay] of Object.entries(block)) {
    if (overlay.stableName === stableName) {
      return { vendorToolName: vendor, overlay };
    }
  }
  return undefined;
}

/** Verify every schema entry has an overlay entry — used at boot by
 *  connector-service C3 and as a unit test inside the package. */
export interface OverlayCoverageViolation {
  toolkit: string;
  vendorSlug: string;
  reason: 'missing_overlay' | 'duplicate_stable_name';
  detail?: string;
}

export function validateOverlayCoverage(): OverlayCoverageViolation[] {
  const violations: OverlayCoverageViolation[] = [];
  for (const [toolkit, schemas] of Object.entries(COMPOSIO_TOOL_SCHEMAS)) {
    const overlays = COMPOSIO_TOOL_OVERLAYS[toolkit] ?? {};
    const seenStable = new Map<string, string>();
    for (const s of schemas) {
      const overlay = overlays[s.slug];
      if (!overlay) {
        violations.push({ toolkit, vendorSlug: s.slug, reason: 'missing_overlay' });
        continue;
      }
      const existing = seenStable.get(overlay.stableName);
      if (existing) {
        violations.push({
          toolkit,
          vendorSlug: s.slug,
          reason: 'duplicate_stable_name',
          detail: `stableName='${overlay.stableName}' also mapped from '${existing}'`,
        });
      } else {
        seenStable.set(overlay.stableName, s.slug);
      }
    }
  }
  return violations;
}
