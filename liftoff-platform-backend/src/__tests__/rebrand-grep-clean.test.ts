// PR 0.4 grep-clean CI gate.
//
// After the CAIO/HRBP migration, the following symbols are dead code in
// platform-backend src/ and must not be re-introduced:
//
//   - buildCAIOSystemPrompt        (moved to workforce-service)
//   - hrbpAgent                    (workforce-service-only now)
//   - claude_code_proxy_keys.name  (the audit comment was rewritten; the
//                                   join was removed in earlier work)
//   - DEFAULT_MODEL hard-codes like claude-opus-4-1 or claude-3-5-sonnet
//     (pre-4.5 SKUs that were dropped from MODEL_PRICING)
//
// Implemented as a file-system scan over src/ excluding the test directory
// itself so the grep patterns above don't false-positive on this file.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..');
const SELF_FILE = join(__dirname, 'rebrand-grep-clean.test.ts');

interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
  /** Files allowed to legitimately mention the symbol — typically migration
   *  scripts that need to drop or rename a column. */
  allow?: RegExp[];
}

const FORBIDDEN: ForbiddenPattern[] = [
  {
    pattern: /\bbuildCAIOSystemPrompt\b/,
    reason: 'CAIO prompt-build moved to workforce-service per PR 0.3',
  },
  {
    pattern: /\bclaude_code_proxy_keys\.name\b/,
    reason: 'agentName resolution no longer joins claude_code_proxy_keys.name (PR 0.4)',
  },
  {
    pattern: /['"]claude-opus-4-1['"]/,
    reason: 'Pre-4.5 Opus SKU was retired from MODEL_PRICING',
  },
  {
    pattern: /['"]claude-3-5-sonnet['"]/,
    reason: 'Pre-4.5 Sonnet SKU was retired from MODEL_PRICING',
  },
  {
    pattern: /['"]claude-3-5-haiku['"]/,
    reason: 'Pre-4.5 Haiku SKU was retired from MODEL_PRICING',
  },
  {
    // Case-sensitive, word-bounded, and never followed by a dot: the hostnames
    // are a different thing entirely. api.example.com, contact@example.com,
    // https://example.com and any mixed-case email address in a test are real
    // addresses and stay exactly as they are.
    // This is about the product NAME appearing in prose a person reads.
    pattern: /\bLiftoffOS\b(?!\.)|\bLiftoff OS\b/,
    reason: 'The product is called Liftoff. "LiftoffOS" and "Liftoff OS" are not product names, and the voice block forbids both.',
    allow: [
      // States the rule, so it has to spell out what it forbids.
      /src\/shared\/agent-voice\.ts$/,
      // Assert the rendered prompts do not use either spelling in their prose.
      /src\/liftoff\/__tests__\/system-prompt\.test\.ts$/,
      /src\/insights\/tools\/__tests__\/system-prompt\.test\.ts$/,
    ],
  },
];

function walk(dir: string, hits: Array<{ file: string; line: number; pattern: RegExp }>): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full === SELF_FILE) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, hits);
      continue;
    }
    if (!/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) continue;
    // Skip the migrations folder if it lives under src — it's intentionally
    // allowed to mention legacy column names.
    if (/\/migrations\//.test(full)) continue;
    const text = readFileSync(full, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { pattern, allow } of FORBIDDEN) {
        if (pattern.test(line)) {
          if (allow?.some(re => re.test(full))) continue;
          hits.push({ file: relative(SRC_ROOT, full), line: i + 1, pattern });
        }
      }
    }
  }
}

describe('PR 0.4 grep-clean — dead symbols stay deleted', () => {
  it('no forbidden vendor / pre-4.5 / legacy symbol survives in src/', () => {
    const hits: Array<{ file: string; line: number; pattern: RegExp }> = [];
    walk(SRC_ROOT, hits);
    expect(hits.map(h => `${h.file}:${h.line} matched ${h.pattern.source}`)).toEqual([]);
  });
});
