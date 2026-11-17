import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { createRequire } from 'module';

// R5 local rules plugin — see eslint-rules/
const require = createRequire(import.meta.url);
const r5LocalPlugin = {
  rules: {
    'log-event-must-be-literal': require('./eslint-rules/log-event-must-be-literal.js'),
    'no-unassigned-isolated-path': require('./eslint-rules/no-unassigned-isolated-path.js'),
    'no-console-in-src': require('./eslint-rules/no-console-in-src.js'),
    'no-stub-success-fallback': require('./eslint-rules/no-stub-success-fallback.js'),
    'memories-must-be-tenant-scoped': require('./eslint-rules/memories-must-be-tenant-scoped.js'),
    'runtime-agent-id-must-be-resolved': require('./eslint-rules/runtime-agent-id-must-be-resolved.js'),
    'no-learned-write-to-system-prompt': require('./eslint-rules/no-learned-write-to-system-prompt.js'),
    'no-process-env-secret': require('./eslint-rules/no-process-env-secret.js'),
    'no-mocked-tenant-registry': require('./eslint-rules/no-mocked-tenant-registry.js'),
    'no-turn-locks-outside-registry': require('./eslint-rules/no-turn-locks-outside-registry.js'),
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.mjs', 'eslint-rules/', 'build/'],
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      r5: r5LocalPlugin,
    },
    rules: {
      // @typescript-eslint/no-unused-vars schema validation is broken on
      // ESLint 10.x + typescript-eslint 8.57.x (the rule's plugin-namespaced
      // form is validated against the no-options schema, rejecting any options
      // payload — error reproduces on main and is not introduced here). Use
      // the base rule with options, and explicitly disable the typescript-
      // eslint version to avoid double-reporting.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-namespace': 'off',
      'no-case-declarations': 'off',
      'no-useless-assignment': 'off',
      'prefer-const': 'warn',
      'preserve-caught-error': 'off',
      // R5 custom rules
      'r5/log-event-must-be-literal': 'error',
      'r5/no-unassigned-isolated-path': 'error',
      'r5/no-console-in-src': 'warn', // warn — lots of existing console.* calls in legacy code
      'r5/no-stub-success-fallback': 'error',
      // INV-PB-018 — a lock is not a heartbeat. `chat_turn_locks` may only be
      // named in SQL by src/interactive-chat/turn-lock-registry.ts. Ships at
      // error with zero pre-existing violations, because the change that adds
      // the rule moves all five owners into that module. Three of them decided
      // liveness from an unexpired lease against a heartbeat ten times slower
      // than it, which is how a dead container can wedge a conversation until
      // the lease runs out — this table has the same shape and the same
      // constants as platform-backend's, so team chat carries the same risk.
      'r5/no-turn-locks-outside-registry': 'error',
    // Error, not warn: an unmigrated read passes every local check and returns
    // undefined only in Cloud Run, so there is no gentle version of this.
    'r5/no-process-env-secret': 'error',
    // A test may not mock infrastructure/tenant-registry, and a servedTenantsPool
    // fixture needs more than one tenant. The registry decides which tenants a
    // sweep covers; a suite that mocks it asserts its own premise, and a
    // one-tenant fixture cannot tell "covers every tenant" from "covers the
    // first and returns".
    'r5/no-mocked-tenant-registry': 'error',
      // WS-8.3 — Layer 3 RLS audit. Ships at warn level so the rule surfaces
      // every raw-SQL-against-memories site for review without immediately
      // failing CI on the ~50 pre-existing call sites that already run
      // inside withTenantScope at a caller level the AST walker can't see.
      // Future tightening: refactor those callers to a memory-scoped helper,
      // then flip to error.
      'r5/memories-must-be-tenant-scoped': 'warn',
      // INV-TR-010 — agent id-space discipline. Flags a control-plane-sourced
      // agent id (HTTP request binding, or one named internalAgentId) reaching
      // a runtime-keyed table's agent_id without translation. Unlike the
      // memories rule above this tracks provenance inside the function rather
      // than flagging every query, so it has no pre-existing violations and
      // ships at `error`: the failures it guards (a memory list keyed on the
      // wrong id space, an attribution column mixing both spaces) are silent,
      // and a warn-level guard against a silent bug is one nobody reads.
      'r5/runtime-agent-id-must-be-resolved': 'error',
      // Base-prompt immutability. BASELINE_SKILLS live in code specifically so
      // reflection cannot mutate them; the distilled instruction.systemPrompt
      // had no equivalent guard, even though buildSystemPrompt layers
      // instructionsMd / learnedInstructionsMd / learned_role_instructions on
      // top of it precisely because learned content is meant to stay separate.
      // Ships at `error` and has no pre-existing violations: a write to the base
      // prompt destroys the operator's own words with no layer underneath to
      // fall back to, and a warn-level guard against that is one nobody reads.
      'r5/no-learned-write-to-system-prompt': 'error',
      // Plan §16 acceptance #1: every TENANT_RUNTIME_URL read goes through
      // infrastructure/runtime-env.ts so the validator + diagnostic state
      // surface fires uniformly. Direct process.env reads bypass the guard
      // and let a missing or malformed runtime URL slip through unreported.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.object.name="process"][object.property.name="env"][property.name="TENANT_RUNTIME_URL"]',
          message: 'Use getTenantRuntimeUrl() or tenantRuntimeUrlState() from src/infrastructure/runtime-env.ts instead of direct process.env.TENANT_RUNTIME_URL access.',
        },
        {
          // Part 7 §F — provider-isolation rule. Branching on model-name prefix
          // sneaks provider knowledge into business-logic code; the right
          // abstraction is `resolvedProvider` or createAdapter().
          selector: "CallExpression[callee.property.name='startsWith'][arguments.0.value=/^(claude|gpt|gemini|o[1-9])/i]",
          message: 'Do not branch on model string prefix. Use resolvedProvider or createAdapter() instead — see ADR-vendor-sdk-adapter-vs-llm-client.',
        },
      ],
    },
  },
  // Part 7 §F — vendor SDK isolation. The adapter implementation files,
  // inner code-session runners, provider files, per-vendor trajectory
  // mappers, and tests are intentional vendor-SDK consumers and are
  // exempt from these import restrictions; the rest of the codebase must
  // route through createAdapter() or LLMClient.
  {
    files: [
      'src/agent-execution/**/*.ts',
      'src/tools/builtins/**/*.ts',
      'src/trajectories/**/*.ts',
    ],
    ignores: [
      'src/agent-execution/adapter/anthropic/**/*.ts',
      // The shared OpenAI-wire loop, and the three endpoint modules that run on
      // it. All four are the adapter layer — the layer this rule exists to keep
      // the vendor SDKs INSIDE — split by which endpoint they answer for rather
      // than bundled under one vendor's name.
      'src/agent-execution/adapter/openai-wire/**/*.ts',
      'src/agent-execution/adapter/openai/**/*.ts',
      'src/agent-execution/adapter/openrouter/**/*.ts',
      'src/agent-execution/adapter/gemini/**/*.ts',
      'src/agent-execution/adapter/gemini-adk/**/*.ts',
      'src/agent-execution/adapter/codex/**/*.ts',
      'src/agent-execution/adapter/opencode/**/*.ts',
      'src/agent-execution/adapter/xai/**/*.ts',
      'src/agent-execution/adapter/tools/code-session/runners/*.ts',
      'src/llm/providers/*.ts',
      'src/trajectories/per-vendor/*.ts',
      // Aggregator files that re-export from vendor-specific layers. Their
      // job IS to import the vendor adapters/runners/mappers and dispatch
      // by provider — they're the seam, not a leak.
      'src/agent-execution/adapter/index.ts',
      'src/agent-execution/adapter/catalog-types.ts',
      // The per-engine "does this engine search natively" answer. It reads one
      // endpoint's model-family predicate to answer for the Agents SDK bridge,
      // and dispatches by engine — a seam, exactly like index.ts.
      'src/agent-execution/adapter/native-web-search.ts',
      'src/agent-execution/adapter/tools/code-session/index.ts',
      'src/trajectories/recorder.ts',
      '**/*.test.ts',
      '**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk'],
            message: 'Vendor SDKs must not leak past the adapter or provider layer. Use createAdapter() or LLMClient.' },
          { group: ['openai', '@openai/agents', '@openai/codex-sdk'],
            message: 'Vendor SDKs must not leak past the adapter or provider layer.' },
          { group: ['@google/genai', '@google/gemini-cli', '@google/adk'],
            message: 'Vendor SDKs must not leak past the adapter or provider layer.' },
          { group: ['@opencode-ai/sdk'],
            message: 'Vendor SDKs must not leak past the adapter or provider layer.' },
          { group: ['tiktoken'],
            message: 'Use LLMClient.countTokens() instead.' },
        ],
      }],
    },
  },
  // Allow direct access ONLY inside the runtime-env module itself + its tests.
  {
    files: ['src/infrastructure/runtime-env.ts', 'src/infrastructure/__tests__/runtime-env.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Tests legitimately use placeholder URLs and stub-shaped fixtures (the
  // push-endpoint healthcheck script's tests verify it rejects
  // placeholder.invalid URLs). Disable the no-stub-success-fallback rule
  // in tests to avoid false positives.
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    rules: { 'r5/no-stub-success-fallback': 'off' },
  },
  // sandbox-sidecar and scripts/ live outside src/ but follow the same
  // unused-vars convention as the runtime: leading underscore = intentionally
  // unused (placeholder for a not-yet-wired API surface, callback signature
  // we can't change, etc.).
  {
    files: ['sandbox-sidecar/src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
