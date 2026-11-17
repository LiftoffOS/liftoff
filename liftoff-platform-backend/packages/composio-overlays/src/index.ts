// @liftoffos/composio-overlays — public surface.

export type {
  ComposioVendorSchema,
  ComposioToolOverlay,
  HistoryToolMapping,
  NormalizedToolError,
} from './types';

export {
  CANONICAL_RESPONSE_SHAPES,
  defaultComposioErrorMap,
  normalizedError,
  type CanonicalKey,
} from './canonical-shapes';

export {
  resolveTranslations,
  resolveOverlay,
  resolveOverlayByStableName,
  validateOverlayCoverage,
  type ResolvedTranslations,
  type OverlayCoverageViolation,
} from './resolve';

export { agentFacingInputSchema, type PublishedInputSchema } from './agent-facing-schema';
export { COMPOSIO_TOOL_SCHEMAS } from './schemas';
export { COMPOSIO_TOOL_OVERLAYS, COMPOSIO_HISTORY_MAPPINGS } from './overlays';
export {
  COMPOSIO_TOOLKIT_SLUG_BY_TYPE,
  getToolkitSlugForConnectorType,
} from './toolkit-slugs';
