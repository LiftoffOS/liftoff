// FITNESS FUNCTION — no execution path produces a completed LLM response
// without a usage record.
//
//   Every LLM call the platform makes produces a usage record with input and
//   output token counts, whoever's key paid for it. No exceptions.
//
// This is a property of the platform, not a feature of BYO provider keys. BYOK
// is only the first thing to test it, because it is the first time the paying
// account is not ours — and it is what makes the property load-bearing: a row
// that says "we charged nothing for this" is only auditable if it also says
// what "this" was, a customer who turns BYOK on does not expect their usage
// dashboards to go blank, and a turn served by the managed key after theirs was
// declined can only be told apart from one they funded by its usage record.
//
// The failure this guards against is specific and has a shape: a new vendor
// adapter lands, works, ships, and reports nothing — so a whole provider's
// spend is invisible until somebody reconciles an invoice by hand. A vendor
// path that cannot report token usage back is not shippable, BYOK or not.
//
// Enumerating the DIRECTORY rather than a hand-written list is the point: a new
// adapter added without a usage path fails here, in the change that adds it.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ADAPTER_ROOT = join(__dirname, '..');

/** Every adapter that can be constructed for an engine, found on disk. */
/** Every .ts file an adapter directory owns, concatenated.
 *
 *  The whole directory rather than index.ts alone: an adapter is free to split
 *  its endpoint and model decisions into siblings (each wire vendor keeps its
 *  SDK provider in provider.ts), and a check that reads only the entry point
 *  would call that a missing property when it is a moved one. */
function directorySource(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** The directory whose implementation this one runs on, if it delegates.
 *
 *  A module that shares another's implementation satisfies these properties
 *  THROUGH it: the xAI, OpenAI and OpenRouter modules are TARGETS pointed at the
 *  shared openai-wire loop, and duplicating that loop to satisfy a source scan
 *  would be the opposite of what the scan is for. The base is itself in this
 *  list and checked on its own account, so following the edge cannot launder a
 *  missing property.
 *
 *  Two shapes of delegation, because both have been used here: `extends` (how
 *  the xAI adapter borrowed the loop before it became a target) and importing
 *  the shared adapter class to construct it. Recognising only the first is how
 *  this check would quietly stop covering three vendors the day the subclass
 *  went away. */
function delegatedAdapterDir(source: string): string | null {
  const extended = /class\s+\w+\s+extends\s+(\w+)/.exec(source);
  if (extended) {
    const importLine = new RegExp(`import\\s*\\{[^}]*\\b${extended[1]}\\b[^}]*\\}\\s*from\\s*'\\.\\./([\\w-]+)'`).exec(source);
    return importLine ? join(ADAPTER_ROOT, importLine[1]) : null;
  }
  // A TARGET: it carries this endpoint's answers and runs on the shared loop it
  // imports from. Importing that module at all is the delegation — a target has
  // no implementation of its own to check, and asserting otherwise would push
  // every vendor to copy a loop instead of sharing one.
  if (/from '\.\.\/(openai-wire)(?:\/[\w-]+)?'/.test(source)) {
    return join(ADAPTER_ROOT, 'openai-wire');
  }
  return null;
}

function adapterEntryPoints(): Array<{ name: string; source: string }> {
  return readdirSync(ADAPTER_ROOT)
    .filter((entry) => {
      const full = join(ADAPTER_ROOT, entry);
      // Not vendors: the shared OpenAI-wire loop is an IMPLEMENTATION that
      // several vendors run on, and it is checked through each of them — every
      // wire target folds its source in, so removing usage emission there fails
      // this suite three times over rather than none.
      if (entry === '__tests__' || entry === 'tools' || entry === 'openai-wire') return false;
      try {
        return statSync(full).isDirectory() && statSync(join(full, 'index.ts')).isFile();
      } catch {
        return false;
      }
    })
    .map((name) => {
      const dir = join(ADAPTER_ROOT, name);
      const own = directorySource(dir);
      const baseDir = delegatedAdapterDir(own);
      return { name, source: baseDir ? `${own}\n${directorySource(baseDir)}` : own };
    });
}

describe('every vendor adapter reports token usage', () => {
  const adapters = adapterEntryPoints();

  it('finds adapters at all, so this cannot pass vacuously', () => {
    expect(adapters.length).toBeGreaterThan(0);
  });

  it.each(adapters.map((a) => a.name))('%s emits a usage event', (name) => {
    const source = adapters.find((a) => a.name === name)!.source;
    // The event the outer loop meters from. An adapter that never emits one
    // publishes inputTokens=0 / outputTokens=0 to billing, which is
    // indistinguishable from a free call and stays that way indefinitely.
    expect(source).toMatch(/type:\s*'usage'/);
  });

  it.each(adapters.map((a) => a.name))(
    '%s carries both halves of the count, not just one',
    (name) => {
      const source = adapters.find((a) => a.name === name)!.source;
      // Input and output are separate rates at every vendor, so one without the
      // other cannot be priced. A tokens-in-only adapter under-reports every
      // call by the more expensive half.
      expect(source).toMatch(/inputTokens/);
      expect(source).toMatch(/outputTokens/);
    },
  );
});

describe('every vendor adapter can be funded by a customer key', () => {
  // Using the customer's key changes WHO PAYS for the tokens. It changes
  // nothing about whether we count them — which is why this suite sits beside
  // the usage assertions rather than in a BYOK-only file.
  //
  // And the two questions have since met in the middle. A gateway session is no
  // longer only a customer's key: a MANAGED session carries Liftoff's own
  // credential through the same seam, for the engines whose own summary cannot be
  // priced from. So `input.byok` is the wiring both answers ride on, and an
  // adapter that reads it satisfies this suite whichever key ends up on the
  // wire.
  const adapters = adapterEntryPoints();

  /**
   * Engines that CANNOT be funded by a customer key, each because of the
   * provider rather than because of missing wiring.
   *
   * Named rather than pattern-matched: an adapter that quietly stops reading
   * `input.byok` should fail this suite, not join a category by omission. Adding
   * a name here is a deliberate edit a reviewer can question.
   */
  const NOT_FUNDABLE: Record<string, string> = {
    // The OpenRouter TARGET. The invoice is Liftoff's and the keys card offers
    // no OpenRouter field, because a customer cannot hold a key for our
    // account. Grok was the one OpenRouter-hosted vendor a customer COULD fund,
    // and it left for its own provider precisely so that funding it did not
    // mean leaving OpenRouter mid-run.
    //
    // opencode is NOT here any more. It serves the open-weights families on
    // that same OpenRouter invoice AND Grok on xAI's — and an xAI account is one
    // a customer can hold, so on opencode the customer's key CAN pay. The
    // engine's funding is asserted below, per host.
    openrouter: 'openrouter invoices are Liftoff\'s; no customer key exists for them',
    // The two Gemini engines. Google BYOK is deliberately scoped to the
    // llmClient path, so an agent TURN routed to Gemini runs on Liftoff's Vertex
    // project. This is a scope boundary rather than a technical one, and both
    // headers say what wiring it would take — which is the difference between a
    // decision and an oversight.
    gemini: 'google BYOK is scoped to the llmClient path',
    'gemini-adk': 'google BYOK is scoped to the llmClient path',
    //
    // gemini-cli is NOT here any more, and not because Google BYOK moved: an agent
    // TURN routed to Gemini still runs on Liftoff's own Vertex project. What that
    // engine reads `input.byok` for is a MANAGED gateway session — Liftoff's own
    // capacity through Liftoff's own gateway — because the CLI's `stats` never
    // name `thoughts` or `tool`. This suite asks whether an adapter honours the
    // credential it is handed, and it does.
  };

  it.each(adapters.map((a) => a.name))(
    '%s honours a BYOK credential unless its provider cannot be funded at all',
    (name) => {
      const source = adapters.find((a) => a.name === name)!.source;
      if (NOT_FUNDABLE[name]) {
        // A stated exception still has to say so in its own header, where
        // somebody reading the adapter finds it.
        expect(source).toMatch(/BYO PROVIDER KEYS:/);
        return;
      }
      expect(source).toMatch(/input\.byok/);
    },
  );

  it('carries no exception for an adapter that no longer exists', () => {
    const names = new Set(adapters.map((a) => a.name));
    expect(Object.keys(NOT_FUNDABLE).filter((n) => !names.has(n))).toEqual([]);
  });
});

describe('opencode funds Grok from whichever xAI account is paying', () => {
  // One engine, two hosts, two funding models on one of them. The open-weights
  // families always run on Liftoff's OpenRouter key; Grok runs on Liftoff's xAI
  // key or, when the customer's key is on the run, on the gateway token that
  // stands in for it. Each is a distinct credential path the source has to
  // name, and each has to be read from the same switch so a change to one
  // cannot silently take the other with it.
  const source = adapterEntryPoints().find((a) => a.name === 'opencode')!.source;

  it('reads Liftoff\'s xAI key for a managed Grok run', () => {
    expect(source).toMatch(/getXaiApiKey\(\)/);
  });

  it('reads the gateway token for a customer-funded Grok run', () => {
    expect(source).toMatch(/byok\?\.vendor === 'xai'/);
    expect(source).toMatch(/byokXai\.token/);
    // The token is only good at the gateway, so the host has to move with it.
    expect(source).toMatch(/byokXai\.baseUrl/);
  });

  it('still reads Liftoff\'s OpenRouter key for the open-weights families', () => {
    expect(source).toMatch(/getOpenRouterApiKey\(\)/);
  });
});
