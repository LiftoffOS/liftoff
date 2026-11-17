#!/usr/bin/env node
 
/**
 * R5 TE-R4-009: verify every scrubLogger callsite in src/ uses a string-literal
 * `event` that matches a key in src/observability/log-schemas.ts.
 *
 * Belt-and-suspenders to the ESLint rule (which handles the same check at
 * IDE/pre-commit time). This script catches the case where ESLint is
 * bypassed or temporarily disabled.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const SCHEMAS_PATH = path.join(SRC_ROOT, 'observability', 'log-schemas.ts');

function extractKnownEvents(): Set<string> {
  const text = readFileSync(SCHEMAS_PATH, 'utf-8');
  const events = new Set<string>();
  // Matches `  event_name: z.object(` — the key-value form in LogSchemas.
  const re = /^\s{2}([a-z][a-z0-9_]{2,63})\s*:\s*z\.object\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    events.add(m[1]);
  }
  return events;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function checkFile(filePath: string, knownEvents: Set<string>): string[] {
  const text = readFileSync(filePath, 'utf-8');
  const errors: string[] = [];
  // Match scrubLogger.(info|warn|error|debug)({ ... event: '...' ... })
  // Coarse scan — find calls, then look for event: 'name' within the object literal.
  const callRe = /\bscrubLogger\s*\.\s*(info|warn|error|debug)\s*\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const startIdx = m.index;
    // Find the matching close brace
    let depth = 1;
    let i = startIdx + m[0].length;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = text.slice(startIdx + m[0].length, i - 1);
    const eventMatch = body.match(/\bevent\s*:\s*(['"`])([a-z][a-z0-9_]{2,63})\1/);
    if (!eventMatch) {
      // Could be a dynamic event (getEventName()) — forbidden under our conventions
      const line = text.slice(0, startIdx).split('\n').length;
      errors.push(`${filePath}:${line}: scrubLogger call missing string-literal event (dynamic event not allowed)`);
      continue;
    }
    const eventName = eventMatch[2];
    if (!knownEvents.has(eventName)) {
      const line = text.slice(0, startIdx).split('\n').length;
      errors.push(`${filePath}:${line}: unknown log event "${eventName}" (add to log-schemas.ts)`);
    }
  }
  return errors;
}

function main(): void {
  const known = extractKnownEvents();
  if (known.size === 0) {
    console.error('FAIL: could not extract any events from log-schemas.ts');
    process.exit(1);
  }
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const allErrors: string[] = [];
  for (const f of files) {
    allErrors.push(...checkFile(f, known));
  }
  if (allErrors.length > 0) {
    console.error(`FAIL: ${allErrors.length} log-schema violation(s):`);
    for (const e of allErrors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`OK: all scrubLogger callsites use known events (${known.size} events defined).`);
}

main();
