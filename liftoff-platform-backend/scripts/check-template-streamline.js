#!/usr/bin/env node
// Fidelity checker for the agent-template streamlining pass.
//
// Compares a rewritten template against its pre-rewrite text (read from git)
// and fails on anything the distiller depends on going missing. The rewrite is
// allowed to remove restatement; it is NOT allowed to remove a fact.
//
// Usage: node scripts/check-template-streamline.js [templateId ...]
//        (no args = every template with an uncommitted change)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const DIR = 'src/agent-templates/catalog';

// Sections catalog-renders.test.ts requires. The rewrite keeps the scaffold;
// it just stops each section paraphrasing its neighbours.
const REQUIRED_RESP = ['## Responsibilities', '## Goals', '## Workflows', '## Instructions', '## Outcomes'];
const REQUIRED_ADDL = ['## Rules', '## Constraints', '## Edge cases', '## Anything to avoid'];

// Mirrors SINGLE_SECTION_TEMPLATE_IDS in catalog-renders.test.ts: these carry one
// task-shaped heading in `responsibilities` instead of the strict five. The
// strict-4 additionalContext contract still applies to them.
const SINGLE_SECTION = new Set(['cp-associate', 'credit-agreement-associate', 'shareholder-agreement-associate']);

// Regexes the trigger analyzer runs over `responsibilities` verbatim
// (trigger-config-analyzer.ts REACTIVE_KEYWORD_PATTERNS). Dropping every
// match flips a reactive agent to a manual trigger, which the scheduler pauses.
const REACTIVE = [
  /\bmonitor(?:s|ing)?\b/i, /\bwatch(?:es|ing)?\b/i, /\bpoll(?:s|ing)?\b/i,
  /\b(?:react|respond)(?:s|ing)?\s+to\b/i, /\b(?:when|whenever|as\s+soon\s+as|every|each)\s+(?:a\s+)?new\b/i,
  /\balert\s+when\b/i, /\bnotify\s+when\b/i, /\bfire\s+when\b/i,
  /\bincoming\b/i, /\binbox\b/i, /\bnewly\s+(?:opened|created|received|posted)\b/i,
];

/** Facts a rewrite must never silently drop: money, durations, percentages,
 *  ratios and bare thresholds. These are the calibrated cutoffs the distill
 *  prompt tells the model to surface verbatim (distill-service STEP 3). */
function factTokens(text) {
  const out = new Set();
  const add = (re) => { for (const m of text.matchAll(re)) out.add(m[0].toLowerCase().replace(/\s+/g, ' ')); };
  add(/\$[\d,]+(?:\.\d+)?\s*[kmb]?\b/gi);
  add(/\b\d+(?:\.\d+)?\s*(?:%|percent)\b/gi);
  add(/\b\d+\s*(?:business\s+)?(?:second|minute|hour|day|week|month|year)s?\b/gi);
  add(/\bnet-\d+\b/gi);
  add(/\btop\s+\d+\b/gi);
  return out;
}

/** URLs, ids, addresses, file paths and named entities the distiller is told to
 *  carry through verbatim (USER_INSTRUCTIONS_DESC). */
function identifiers(text) {
  const out = new Set();
  const add = (re) => { for (const m of text.matchAll(re)) out.add(m[0]); };
  add(/https?:\/\/\S+/g);
  add(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g);
  add(/\[[A-Za-z]+\](?:-\[[A-Za-z]+\])+/g);   // naming conventions e.g. [Type]-[Party]-[Date]
  return out;
}

function sections(md) {
  const out = {};
  let cur = null;
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { cur = m[1].trim(); out[cur] = ''; }
    else if (cur) out[cur] += line + '\n';
  }
  return out;
}

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const numberedSteps = (s) => (String(s || '').match(/^\s*\d+\./gm) || []).length;

function loadHead(file) {
  try {
    return yaml.load(execFileSync('git', ['show', `HEAD:${DIR}/${file}`], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function changedFiles() {
  const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', DIR], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((p) => path.basename(p));
}

function check(file) {
  const after = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const before = loadHead(file);
  const errs = [];
  const warns = [];

  const aResp = after.responsibilities || '';
  const aAddl = after.additionalContext || '';
  const aAll = `${aResp}\n${aAddl}`;

  // ── Structure the catalog tests enforce ──────────────────────────────
  if (SINGLE_SECTION.has(after.id)) {
    if (!/^\s*##\s/m.test(aResp)) errs.push('responsibilities needs at least one ## heading');
  } else {
    for (const h of REQUIRED_RESP) if (!aResp.includes(h)) errs.push(`responsibilities missing "${h}"`);
  }
  for (const h of REQUIRED_ADDL) if (!aAddl.includes(h)) errs.push(`additionalContext missing "${h}"`);
  if (aResp.trim().length <= 100) errs.push(`responsibilities must exceed 100 chars (is ${aResp.trim().length})`);
  if (aAddl.trim().length <= 50) errs.push(`additionalContext must exceed 50 chars (is ${aAddl.trim().length})`);

  // ── The workflowSteps emission trigger ───────────────────────────────
  // distill-service STEP 1: the "## Workflows" section with numbered
  // sub-tasks is what makes workflowSteps mandatory. The preset path proved
  // that losing it yields 0 steps on every agent.
  const secs = sections(aResp);
  const wf = secs['Workflows'] || '';
  if (before) {
    const bSteps = numberedSteps(sections(before.responsibilities || '')['Workflows'] || '');
    const aSteps = numberedSteps(wf);
    if (bSteps > 0 && aSteps === 0) errs.push('## Workflows lost every numbered step — workflowSteps will not be emitted');
    else if (bSteps > 0 && aSteps < Math.ceil(bSteps * 0.6)) {
      warns.push(`## Workflows numbered steps ${bSteps} -> ${aSteps} (kept ${Math.round(100 * aSteps / bSteps)}%)`);
    }
  }

  if (!before) return { file, errs, warns, skipped: 'no HEAD version to compare' };

  const bResp = before.responsibilities || '';
  const bAddl = before.additionalContext || '';
  const bAll = `${bResp}\n${bAddl}`;

  // ── Facts, identifiers, reactive verbs ───────────────────────────────
  const lostFacts = [...factTokens(bAll)].filter((t) => !factTokens(aAll).has(t));
  if (lostFacts.length) errs.push(`dropped numeric cutoffs: ${lostFacts.join(', ')}`);

  const lostIds = [...identifiers(bAll)].filter((t) => !aAll.includes(t));
  if (lostIds.length) errs.push(`dropped identifiers: ${lostIds.join(', ')}`);

  if (REACTIVE.some((re) => re.test(bResp)) && !REACTIVE.some((re) => re.test(aResp))) {
    errs.push('lost every reactive keyword — the trigger analyzer will allow a manual trigger');
  }

  // ── Connector coverage ───────────────────────────────────────────────
  // Structured connector declarations are NOT passed to distillation, so the
  // prose is the only channel telling the model which tool serves which step.
  const conns = [...(after.requiredConnectors || [])].map((c) => String(c.connectorType || c.capability || ''));
  for (const c of conns) {
    const bare = c.replace(/_/g, ' ');
    const named = (t) => t.toLowerCase().includes(bare.toLowerCase()) || t.toLowerCase().includes(c.toLowerCase());
    if (named(bAll) && !named(aAll)) warns.push(`required connector "${c}" no longer named in the prose`);
  }

  // ── Contrastive pairs ────────────────────────────────────────────────
  // instructionsMd's "## Pitfalls and gotchas" is built to preserve do/don't
  // guidance as BOTH halves. Collapsing them to bare imperatives loses the half
  // that section consumes.
  const bAvoid = words(sections(bAddl)['Anything to avoid'] || '');
  const aAvoid = words(sections(aAddl)['Anything to avoid'] || '');
  if (bAvoid > 0 && aAvoid < bAvoid * 0.35) {
    warns.push(`"Anything to avoid" ${bAvoid} -> ${aAvoid} words — keep the negative half of each pair`);
  }

  const bTotal = words(bResp) + words(bAddl);
  const aTotal = words(aResp) + words(aAddl);
  return {
    file, errs, warns,
    stat: `${bTotal} -> ${aTotal} words (${Math.round(100 * (1 - aTotal / bTotal))}% cut)`,
  };
}

const args = process.argv.slice(2);
const files = args.length
  ? args.map((a) => (a.endsWith('.yaml') ? a : `${a}.yaml`))
  : changedFiles();

if (!files.length) {
  console.log('No changed templates to check.');
  process.exit(0);
}

let failed = 0;
for (const f of files) {
  const r = check(f);
  const tag = r.errs.length ? 'FAIL' : 'ok  ';
  console.log(`${tag} ${r.file.replace('.yaml', '').padEnd(38)} ${r.stat || r.skipped || ''}`);
  for (const e of r.errs) console.log(`       ERROR  ${e}`);
  for (const w of r.warns) console.log(`       warn   ${w}`);
  if (r.errs.length) failed++;
}
console.log(`\n${files.length - failed}/${files.length} passed`);
process.exit(failed ? 1 : 0);
