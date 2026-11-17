#!/usr/bin/env node
// Replace real credentials in a harvested fixture with format-realistic fakes.
//
// Format-REALISTIC matters. Replacing an OpenAI key with "REDACTED" produces a
// fixture that cannot exercise the importer's secret filter, so the filter goes
// untested against the shape it actually has to catch. Each replacement below
// keeps the prefix and length class of the real thing and changes the body to
// an obviously synthetic marker.
//
// This runs over a harvested snapshot before it is committed. It is a
// last-resort net: the harvest uses throwaway credentials in the first place.

'use strict';

const fs = require('fs');
const path = require('path');

const FAKE = 'MUSTNEVERLEAK';

/** Ordered most specific first, mirroring the importer's own detector. */
const RULES = [
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, fake: () => `sk-ant-api03-${FAKE}0123456789abcdef` },
  { name: 'openai', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g, fake: () => `sk-proj${FAKE}0123456789abcdefghij` },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, fake: () => `ghp_${FAKE}0123456789abcdefghijkl` },
  { name: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, fake: () => `github_pat_11${FAKE}_0123456789abcdef` },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, fake: () => `xoxb-1111111111-2222222222-${FAKE}` },
  { name: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, fake: () => 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXX' },
  { name: 'google', re: /\bAIza[A-Za-z0-9_-]{30,}/g, fake: () => `AIzaSy${FAKE}0123456789abcdefghijklmn` },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, fake: () => 'AKIAIOSFODNN7EXAMPLE' },
  { name: 'stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, fake: () => `sk_test_${FAKE}0123456789` },
  { name: 'private_key', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, fake: () => `-----BEGIN RSA PRIVATE KEY-----\n${FAKE}0123456789abcdef\n-----END RSA PRIVATE KEY-----` },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, fake: () => 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.' + FAKE },
  { name: 'db_url', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@]+@[^\s]+/g, fake: () => `postgresql://user:${FAKE}@db.example.invalid:5432/app` },
];

/** Binary-ish files are copied through untouched but reported, so a reviewer
 *  knows a database is present and was not text-scrubbed. */
const BINARY_EXT = new Set(['.sqlite', '.db', '.wal', '.shm', '.png', '.jpg', '.pdf', '.gz', '.zip']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: scrub.js <fixture-dir>');
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`no such directory: ${target}`);
    process.exit(1);
  }

  const counts = Object.create(null);
  const binaries = [];
  let filesChanged = 0;

  for (const file of walk(target)) {
    const ext = path.extname(file).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      binaries.push(path.relative(target, file));
      continue;
    }

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      binaries.push(path.relative(target, file));
      continue;
    }

    let out = text;
    for (const rule of RULES) {
      out = out.replace(new RegExp(rule.re.source, rule.re.flags), () => {
        counts[rule.name] = (counts[rule.name] || 0) + 1;
        return rule.fake();
      });
    }

    if (out !== text) {
      fs.writeFileSync(file, out);
      filesChanged += 1;
    }
  }

  const report = {
    scrubbedAt: new Date().toISOString(),
    filesChanged,
    replacementsByType: counts,
    binaryFilesNotTextScrubbed: binaries,
  };
  fs.writeFileSync(path.join(target, 'SCRUB-REPORT.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`scrubbed ${filesChanged} file(s)`);
  for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
  if (binaries.length > 0) {
    // A harvested session database is expected here. It is committed as-is
    // because the importer must be tested against a real schema — and because
    // the adapters never read its rows, only its presence and table names.
    console.log(`\n${binaries.length} binary file(s) copied without text scrubbing:`);
    for (const b of binaries) console.log(`  ${b}`);
    console.log('\nReview these before committing: they were produced with throwaway');
    console.log('credentials, but a database can still carry conversation content.');
  }
}

main();
