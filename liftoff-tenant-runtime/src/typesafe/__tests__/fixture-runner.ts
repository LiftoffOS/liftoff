// The fixture contract: what a pinned question set must answer, on record.
//
// A fixture is `{ set: { id, version, model }, state, expect, note? }` under
// src/typesafe/fixtures/<item>/*.json. `expect` names, per question, the
// label the answer must choose and the band its probability must sit in.
// A fixture whose set version or model differs from the current set fails
// with "re-pin required": a threshold tuned against one version says
// nothing about the next.
//
// The same contract as the control plane's (fixture-runner.ts there); this
// runtime's live test (fixtures.live.test.ts) reads it. Both print the
// tightest passing band per threshold so a person can review and commit it.
//
// A runtime fixture may carry, beside `state`, what its set's BUILDER needs:
// the `browser_step` set is built from a recorded page (`page`, `goal`,
// `history`, `parameters`), and the state with it; the others carry `state`
// as sent, and the builder's argument is read off it.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface FixtureExpectation {
  /** The label the answer must choose. */
  choice?: string;
  /** The probability of `label` (the chosen one when absent) must be at least this. */
  min?: number;
  /** ... and at most this. */
  max?: number;
  /** Which label the min/max apply to, when not the chosen one. */
  label?: string;
  /** A miss is reported in the band output and never fails the run. The
   *  seed regression set marks its "no" expectations this way: the contract
   *  claims a category is omitted only on a confident no, not that Jev never
   *  adds one the seed lacks. */
  advisory?: boolean;
}

export interface Fixture {
  file: string;
  set: { id: string; version: number; model: string };
  state?: unknown;
  /** browser_step: the recorded page the request is built from. */
  page?: unknown;
  goal?: string;
  history?: unknown[];
  parameters?: Record<string, unknown>;
  expect: Record<string, FixtureExpectation>;
  /** Free text: where the fixture came from, and what its expectation is
   *  worth. The seed regression set says its reviewer values are seed
   *  markers, not human adjudication. */
  note?: string;
}

export function loadFixtures(dir: string): Fixture[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Omit<Fixture, 'file'>;
    return { file: f, ...raw };
  });
}

/** Null when the fixture is pinned to the current set; the reason otherwise. */
export function repinReason(fixture: Fixture, current: { id: string; version: number; model: string }): string | null {
  if (fixture.set.id !== current.id) return `set id ${fixture.set.id} is not ${current.id}`;
  if (fixture.set.version !== current.version) return `re-pin required: fixture pinned to set v${fixture.set.version}, current is v${current.version}`;
  if (fixture.set.model !== current.model) return `re-pin required: fixture pinned to model ${fixture.set.model}, current is ${current.model}`;
  return null;
}

export interface AnswerLike {
  choice?: string;
  probabilities?: Record<string, number>;
  noul?: number;
}

/** Every way the answers miss the fixture's expectation: `misses` fail the
 *  run, `advisories` are reported beside the bands. */
export function checkExpectations(
  answers: Record<string, AnswerLike>,
  expectations: Record<string, FixtureExpectation>,
): { misses: string[]; advisories: string[] } {
  const misses: string[] = [];
  const advisories: string[] = [];
  for (const [question, exp] of Object.entries(expectations)) {
    const sink = exp.advisory ? advisories : misses;
    const a = answers[question];
    if (!a) { sink.push(`${question}: no answer`); continue; }
    if (exp.choice !== undefined && a.choice !== exp.choice) {
      sink.push(`${question}: chose ${a.choice}, expected ${exp.choice}`);
    }
    const label = exp.label ?? exp.choice ?? a.choice;
    const p = typeof a.noul === 'number' ? a.noul : label ? a.probabilities?.[label] : undefined;
    if (typeof p !== 'number') { if (exp.min !== undefined || exp.max !== undefined) sink.push(`${question}: no probability for ${label}`); continue; }
    if (exp.min !== undefined && p < exp.min) sink.push(`${question}: p(${label})=${p.toFixed(3)} < min ${exp.min}`);
    if (exp.max !== undefined && p > exp.max) sink.push(`${question}: p(${label})=${p.toFixed(3)} > max ${exp.max}`);
  }
  return { misses, advisories };
}

/**
 * The tightest band the observed probabilities admit, per labelled group: for
 * every fixture that expects `label` on `question`, the minimum probability
 * seen (the highest a "must clear" threshold could be); for every fixture
 * that expects any other label, the maximum probability of `label` seen (the
 * lowest a "must not clear" threshold could be). A person reads the two and
 * pins a threshold between them.
 */
export interface Band { question: string; label: string; minWhenExpected: number | null; maxWhenNotExpected: number | null; expected: number; notExpected: number }

export function tightestBands(
  observations: Array<{ answers: Record<string, AnswerLike>; expect: Record<string, FixtureExpectation> }>,
  questions: readonly string[],
  labels: readonly string[],
): Band[] {
  const out: Band[] = [];
  for (const question of questions) {
    for (const label of labels) {
      let minWhenExpected: number | null = null;
      let maxWhenNotExpected: number | null = null;
      let expected = 0;
      let notExpected = 0;
      for (const o of observations) {
        const exp = o.expect[question];
        if (!exp) continue;
        const a = o.answers[question];
        const p = typeof a?.noul === 'number' ? (label === 'true' ? a.noul : 1 - a.noul) : a?.probabilities?.[label];
        if (typeof p !== 'number') continue;
        // A Choice fixture names the label it expects; a Noul fixture (and a
        // band-only Choice fixture) states a min (the label is expected) or
        // a max (it is not).
        const bandLabel = exp.label ?? exp.choice ?? (typeof a?.noul === 'number' ? 'true' : undefined);
        const isExpected = exp.choice !== undefined ? exp.choice === label : (bandLabel === label && exp.min !== undefined);
        const isNotExpected = exp.choice !== undefined ? exp.choice !== label : (bandLabel === label && exp.max !== undefined);
        if (isExpected) {
          expected += 1;
          minWhenExpected = minWhenExpected === null ? p : Math.min(minWhenExpected, p);
        } else if (isNotExpected) {
          notExpected += 1;
          maxWhenNotExpected = maxWhenNotExpected === null ? p : Math.max(maxWhenNotExpected, p);
        }
      }
      if (expected + notExpected > 0) out.push({ question, label, minWhenExpected, maxWhenNotExpected, expected, notExpected });
    }
  }
  return out;
}

export function formatBands(setId: string, bands: Band[]): string {
  const lines = [`${setId}: tightest passing bands (pin a threshold between max-when-not-expected and min-when-expected)`];
  for (const b of bands) {
    lines.push(
      `  ${b.question}.${b.label}: min when expected = ${b.minWhenExpected === null ? 'n/a' : b.minWhenExpected.toFixed(3)} (${b.expected}), `
      + `max when not expected = ${b.maxWhenNotExpected === null ? 'n/a' : b.maxWhenNotExpected.toFixed(3)} (${b.notExpected})`,
    );
  }
  return lines.join('\n');
}

/** For a target head whose ids are indexes: the id whose criteria `element`
 *  text contains `label`. Lets a browser fixture name a control by what it
 *  says rather than by an index that depends on the snapshot's order. */
export function targetIdByElement(criteria: Record<string, { element?: string } | string>, label: string): string | undefined {
  for (const [id, c] of Object.entries(criteria)) {
    const element = typeof c === 'string' ? c : c.element ?? '';
    if (element.includes(label)) return id;
  }
  return undefined;
}
