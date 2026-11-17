#!/usr/bin/env node
// Static check: every gcloud-run-deploy or gcloud-run-services-update call in
// cloudbuild.yaml MUST include TENANT_RUNTIME_URL in its env for any service in
// REQUIRED_ENV_PER_SERVICE. Mismatches fail with exit 1.
//
// Why: a wire-peer-urls step that updates agent-service with
// TENANT_RUNTIME_URL but forgets coordinator-service regresses silently.
//
// Plain ESM JS so this can run in node:20-alpine without ts-node/typescript.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_ENV_PER_SERVICE = {
  'agent-service':        ['SERVICE_TYPE', 'TENANT_RUNTIME_URL', 'GCP_PROJECT_ID', 'CLOUD_SCHEDULER_SERVICE_ACCOUNT', 'PLATFORM_BACKEND_SA_EMAIL'],
  'coordinator-service':  ['SERVICE_TYPE', 'TENANT_RUNTIME_URL', 'GCP_PROJECT_ID', 'CLOUD_SCHEDULER_SERVICE_ACCOUNT', 'PUBSUB_PUSH_SA_EMAIL'],
  'tool-gateway-service': ['SERVICE_TYPE', 'TENANT_RUNTIME_URL', 'GCP_PROJECT_ID'],
  'reflection-service':   ['SERVICE_TYPE', 'GCP_PROJECT_ID'],
};

const cloudbuildPath = process.env.CLOUDBUILD_YAML ?? resolve(process.cwd(), 'cloudbuild.yaml');
const yaml = readFileSync(cloudbuildPath, 'utf8');

/** gcloud's list syntax: comma-separated, unless the list opens with `^X^`,
 *  in which case X is the separator — the form a list must take when a value
 *  itself holds a comma (the gateway's connector list does). */
function splitEnvList(list) {
  const alt = /^\^([^^]+)\^/.exec(list);
  if (!alt) return list.split(',');
  return list.slice(alt[0].length).split(alt[1]);
}

function envKeysForService(service) {
  const keys = new Set();
  const blocks = yaml.split(/(?=gcloud run (?:deploy|services update) )/);
  for (const block of blocks) {
    const head = block.slice(0, 200);
    if (!head.includes(service)) continue;
    for (const match of block.matchAll(/--(?:set|update)-env-vars\s+"([^"]+)"/g)) {
      for (const pair of splitEnvList(match[1])) {
        const k = pair.split('=')[0].trim();
        if (k) keys.add(k);
      }
    }
  }
  return keys;
}

let failed = false;
for (const [service, required] of Object.entries(REQUIRED_ENV_PER_SERVICE)) {
  const got = envKeysForService(service);
  for (const key of required) {
    if (!got.has(key)) {
      console.error(`✗ ${service}: missing required env ${key} (got: ${[...got].sort().join(', ')})`);
      failed = true;
    }
  }
}

// ── Unescaped shell variables ────────────────────────────────────────────
//
// Cloud Build expands `$NAME` as one of ITS substitutions before the shell ever
// sees it, and rejects the WHOLE build at validation time — before a single step
// runs, with an empty log and
//   key in the template "NAME" is not a valid built-in substitution
// A shell variable therefore has to be written `$$NAME`.
//
// Invisible locally: the YAML parses, the script is valid bash, and every other
// check here passes. One `$STATUS` in an inline script is enough to fail the
// build, and without this check it is found only by pushing.
const BUILT_INS = new Set([
  'PROJECT_ID', 'BUILD_ID', 'PROJECT_NUMBER', 'LOCATION',
  'REPO_NAME', 'REPO_FULL_NAME', 'BRANCH_NAME', 'TAG_NAME', 'REVISION_ID',
  'COMMIT_SHA', 'SHORT_SHA', 'TRIGGER_NAME', 'TRIGGER_BUILD_CONFIG_PATH',
  'SERVICE_ACCOUNT_EMAIL', 'SERVICE_ACCOUNT',
]);

yaml.split('\n').forEach((line, i) => {
  // YAML comments never reach the substitution pass.
  if (/^\s*#/.test(line)) return;
  for (const m of line.matchAll(/(?<![$\\])\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const name = m[1];
    // User-defined substitutions are underscore-prefixed and ARE meant to expand.
    if (BUILT_INS.has(name) || name.startsWith('_')) continue;
    console.error(
      `\u2717 cloudbuild.yaml:${i + 1}: $${name} will be read as a Cloud Build substitution, ` +
      `not a shell variable — write $$${name}. Left as-is the build is rejected at ` +
      `validation with an empty log.`,
    );
    failed = true;
  }
});

// A `#` comment between a line ending in `\` and the flag that follows it.
//
// Bash ends the command AT the comment, so every flag after it is dropped and
// the next line runs as its own command. Nothing about that reads as a
// misplaced comment: the deploy reports success, having quietly ignored the
// rest of its arguments, and the step then fails with
//
//   bash: line 126: --clear-secrets: command not found
//
// which names the flag and not the cause. It cost two builds, and the
// dangerous half is the SILENT half — agent-service deployed with its secrets
// still bound while the log only complained about an unknown command.
//
// Put the prose above the command. A trailing comment on the LAST line of a
// command is fine and stays allowed.
yaml.split('\n').forEach((line, i, all) => {
  if (!/^\s*#/.test(line)) return;
  // Walk back over any comment block to the last real line.
  let j = i - 1;
  while (j >= 0 && /^\s*#/.test(all[j])) j -= 1;
  if (j < 0 || !/\\\s*$/.test(all[j])) return;
  console.error(
    `\u2717 cloudbuild.yaml:${i + 1}: a comment sits inside a \\-continued shell command ` +
    `(continued from line ${j + 1}). Bash ends the command at the '#', so every flag below ` +
    `is dropped and the next line runs on its own. Move the comment above the command.`,
  );
  failed = true;
});

if (failed) {
  console.error('\nFailing cloudbuild lint. See cloudbuild.yaml.');
  process.exit(1);
}
console.log('cloudbuild lint OK');
