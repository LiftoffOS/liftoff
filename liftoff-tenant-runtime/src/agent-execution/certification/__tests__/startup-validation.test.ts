// Startup engine validation.

import { validateEnabledEngines, assertEnabledEnginesInitializable } from '../startup-validation';

// Resolver that pretends a given package is absent (throws), else "resolves".
function resolverMissing(missing: string): (id: string) => string {
  return (id: string) => {
    if (id === missing) throw new Error(`Cannot find module '${id}'`);
    return `/node_modules/${id}`;
  };
}
const resolverAllPresent = (id: string): string => `/node_modules/${id}`;
/** The Gemini CLI binary, present / absent. It is installed globally in the
 *  image and not on a developer machine, so the default-configuration checks
 *  stage it rather than depend on the box they run on. */
const binaryPresent = (): boolean => true;
const binaryAbsent = (): boolean => false;

describe('validateEnabledEngines', () => {
  it('reads an ESM-only SDK as PRESENT — the export map refuses CommonJS, node found the package', () => {
    // The real resolver: @opencode-ai/sdk and @openai/codex-sdk are installed
    // and ESM-only, so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED
    // for both. Read as absence, the DEFAULT configuration — opencode for xAI
    // and the open-weights families, Codex for OpenAI — could never boot a
    // service that had the SDK.
    const { ok, reports } = validateEnabledEngines({}, undefined, binaryPresent);
    const byEngine = Object.fromEntries(reports.map((r) => [r.engine, r]));
    expect(byEngine.opencode.sdkPresent).toBe(true);
    expect(byEngine['openai-codex'].sdkPresent).toBe(true);
    expect(ok).toBe(true);
    // And a package that is not there still reads as absent.
    const notExported = (id: string): string => { const e = new Error(`No "exports" main defined in ${id}/package.json`) as Error & { code: string }; e.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'; throw e; };
    expect(validateEnabledEngines({ OPENAI_ENGINE: 'codex' }, notExported).reports.find((r) => r.engine === 'openai-codex')?.sdkPresent).toBe(true);
    expect(validateEnabledEngines({ OPENAI_ENGINE: 'codex' }, resolverMissing('@openai/codex-sdk')).reports.find((r) => r.engine === 'openai-codex')?.sdkPresent).toBe(false);
  });

  it('passes under the default configuration — every engine recognized', () => {
    const { ok, reports } = validateEnabledEngines({}, resolverAllPresent, binaryPresent);
    expect(ok).toBe(true);
    expect(reports.every((r) => r.recognized && r.ok)).toBe(true);
    // The pairing: each provider's default is its own runtime.
    expect(reports.find((r) => r.provider === 'anthropic')!.engine).toBe('claude-agent-sdk');
    expect(reports.find((r) => r.provider === 'openai')!.engine).toBe('openai-codex');
    expect(reports.find((r) => r.provider === 'xai')!.engine).toBe('opencode');
    expect(reports.find((r) => r.provider === 'glm')!.engine).toBe('opencode');
    expect(reports.find((r) => r.provider === 'google')!.engine).toBe('google-gemini-cli');
  });

  it('checks the Gemini CLI BINARY for Google\'s default, since it has no SDK in the tree', () => {
    const missing = validateEnabledEngines({}, resolverAllPresent, binaryAbsent);
    const google = missing.reports.find((r) => r.provider === 'google')!;
    expect(google.engine).toBe('google-gemini-cli');
    expect(google.sdkPresent).toBe(false);
    expect(google.ok).toBe(false);
    expect(google.detail).toContain('gemini');
    expect(google.detail).toContain('GEMINI_CLI_PATH');
    expect(missing.ok).toBe(false);
    // The override names where it lives, and is what gets probed.
    const probed: string[] = [];
    validateEnabledEngines({ GEMINI_CLI_PATH: '/opt/bin/gemini' }, resolverAllPresent, (p) => { probed.push(p); return true; });
    expect(probed).toContain('/opt/bin/gemini');
  });

  it('checks the self-managing DEFAULTS for their SDKs, not only a flag-selected engine', () => {
    // Codex and opencode are defaults now, so a boot with either SDK missing
    // is a boot that fails on the first OpenAI, Grok or open-weights run.
    const { ok, reports } = validateEnabledEngines({}, resolverMissing('@opencode-ai/sdk'), binaryPresent);
    expect(ok).toBe(false);
    for (const provider of ['xai', 'glm', 'qwen', 'deepseek', 'kimi', 'minimax']) {
      const r = reports.find((x) => x.provider === provider)!;
      expect(r.engine).toBe('opencode');
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('@opencode-ai/sdk');
    }
    expect(reports.find((r) => r.provider === 'openai')!.ok).toBe(true);
  });

  it('passes when the wire escape hatches are selected, even with the self-managing SDKs missing', () => {
    // The wire engines ride core dependencies; a deployment that flips to them
    // needs no ESM-only SDK at all.
    const missingBoth = (id: string): string => {
      if (id === '@opencode-ai/sdk' || id === '@openai/codex-sdk') throw new Error(`Cannot find module '${id}'`);
      return `/node_modules/${id}`;
    };
    const { ok, reports } = validateEnabledEngines(
      { OPENAI_ENGINE: 'agents', XAI_ENGINE: 'wire', OPENROUTER_ENGINE: 'wire', GOOGLE_ENGINE: 'genai' },
      missingBoth,
      binaryAbsent,
    );
    expect(ok).toBe(true);
    expect(reports.find((r) => r.provider === 'openai')!.engine).toBe('openai-agents');
    expect(reports.find((r) => r.provider === 'xai')!.engine).toBe('xai-openai-wire');
    expect(reports.find((r) => r.provider === 'glm')!.engine).toBe('openrouter-openai-wire');
    expect(reports.find((r) => r.provider === 'google')!.engine).toBe('google-genai');
  });

  it('fails when an enabled self-managing engine SDK is not resolvable', () => {
    const { ok, reports } = validateEnabledEngines(
      {},
      resolverMissing('@openai/codex-sdk'),
      binaryPresent,
    );
    expect(ok).toBe(false);
    const codex = reports.find((r) => r.engine === 'openai-codex')!;
    expect(codex.sdkPresent).toBe(false);
    expect(codex.ok).toBe(false);
    expect(codex.detail).toContain('@openai/codex-sdk');
  });

  it('does not require an SDK for eager engines even when a self-managing flag is missing its SDK', () => {
    const { reports } = validateEnabledEngines({ GOOGLE_ENGINE: 'adk' }, resolverMissing('@google/adk'), binaryPresent);
    // google resolves to google-adk which fails; anthropic stays eager + ok.
    expect(reports.find((r) => r.provider === 'anthropic')!.ok).toBe(true);
    expect(reports.find((r) => r.engine === 'google-adk')!.ok).toBe(false);
  });

  it('requires Vertex config when google-adk is explicitly enabled (config presence)', () => {
    const { ok, reports } = validateEnabledEngines({ GOOGLE_ENGINE: 'adk' }, resolverAllPresent, binaryPresent);
    const adk = reports.find((r) => r.engine === 'google-adk')!;
    expect(adk.sdkPresent).toBe(true);
    expect(adk.configPresent).toBe(false);
    expect(adk.missingConfig).toEqual(['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']);
    expect(adk.detail).toContain('missing required config');
    expect(ok).toBe(false);
  });

  it('passes google-adk when SDK AND Vertex config are both present', () => {
    const { ok } = validateEnabledEngines(
      { GOOGLE_ENGINE: 'adk', GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us-central1' },
      resolverAllPresent,
      binaryPresent,
    );
    expect(ok).toBe(true);
  });

  it('does NOT require Vertex config for the google-genai escape hatch', () => {
    const { reports } = validateEnabledEngines({ GOOGLE_ENGINE: 'genai' }, resolverAllPresent, binaryPresent);
    const genai = reports.find((r) => r.engine === 'google-genai')!;
    expect(genai.configPresent).toBe(true);
    expect(genai.ok).toBe(true);
  });
});

describe('assertEnabledEnginesInitializable', () => {
  it('is a no-op under the default configuration, against the real module resolver', () => {
    // The defaults need the ESM-only SDKs, which the real resolver reports
    // through their export map — see the first test above — and the Gemini
    // CLI binary, which lives in the image rather than on this machine.
    expect(() => assertEnabledEnginesInitializable({}, undefined, binaryPresent)).not.toThrow();
  });

  it('throws (fails the revision) when a configured engine cannot initialize', () => {
    expect(() =>
      assertEnabledEnginesInitializable({}, resolverMissing('@opencode-ai/sdk'), binaryPresent),
    ).toThrow(/opencode.*@opencode-ai\/sdk/);
    expect(() =>
      assertEnabledEnginesInitializable({}, resolverAllPresent, binaryAbsent),
    ).toThrow(/google-gemini-cli.*gemini/);
  });

  it('does not throw when the enabled engine SDK is present', () => {
    expect(() =>
      assertEnabledEnginesInitializable({}, resolverAllPresent, binaryPresent),
    ).not.toThrow();
  });
});
