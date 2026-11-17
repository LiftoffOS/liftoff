// Some Claude models (the Claude 5 family and newer, e.g. `claude-opus-5`)
// reject the `temperature` request parameter outright: the Messages API returns
// 400 "`temperature` is deprecated for this model." The full set is not known
// ahead of time and drifts as new models ship, so we DISCOVER it at runtime:
// the first call to such a model 400s, we record the model here, strip
// `temperature`, and retry — and every subsequent call to that model omits
// `temperature` up front. Shared by both the direct-API and Vertex Anthropic
// providers (a model's capability is global, not transport-specific).

const temperatureUnsupportedModels = new Set<string>();

/** True once we've observed this model reject `temperature`. */
export function modelRejectsTemperature(model: string): boolean {
  return temperatureUnsupportedModels.has(model);
}

/** Record that a model rejects `temperature` (called after its first 400). */
export function markTemperatureUnsupported(model: string): void {
  temperatureUnsupportedModels.add(model);
}

/** Match the Anthropic 400 that signals `temperature` is not accepted for the
 *  model. The SDK surfaces the body both as a parsed `error` object and inside
 *  the `message` string, so we check both. */
export function isTemperatureUnsupportedError(err: unknown): boolean {
  const e = err as
    | { status?: number; message?: string; error?: { error?: { message?: string } } }
    | null
    | undefined;
  if (!e || e.status !== 400) return false;
  const msg = e.error?.error?.message ?? e.message ?? '';
  return /temperature/i.test(msg);
}

/** Test-only reset of the discovered-model cache. */
export function __resetTemperatureSupportForTests(): void {
  temperatureUnsupportedModels.clear();
}
