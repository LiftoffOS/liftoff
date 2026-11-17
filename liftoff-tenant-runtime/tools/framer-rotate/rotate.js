#!/usr/bin/env node
// framer-secret-rotate: generates a new framer server secret, adds it as a new
// Secret Manager version, and disables old versions beyond KEEP_VERSIONS.
//
// Env vars (injected by Cloud Run Job via Terraform):
//   SECRET_NAME   — full SM resource name: projects/<proj>/secrets/<name>
//   GCP_PROJECT   — GCP project ID (informational, used in logs)
//   KEEP_VERSIONS — number of enabled versions to retain (default: 2)

'use strict';

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const crypto = require('crypto');

const SECRET_NAME = process.env.SECRET_NAME;
const KEEP_VERSIONS = parseInt(process.env.KEEP_VERSIONS || '2', 10);

if (!SECRET_NAME) {
  console.error('ERROR: SECRET_NAME env var is required');
  process.exit(1);
}

async function main() {
  const client = new SecretManagerServiceClient();

  // Generate a 64-byte random secret (128-char hex string).
  // This length matches the UntrustedContentFramer's {32,64}-byte expectation
  // for the server secret used to derive the HMAC escape key.
  const newSecretValue = crypto.randomBytes(64).toString('hex');

  console.log(`Rotating secret: ${SECRET_NAME}`);

  // Add new version
  const [newVersion] = await client.addSecretVersion({
    parent: SECRET_NAME,
    payload: {
      data: Buffer.from(newSecretValue, 'utf8'),
    },
  });
  console.log(`Added new secret version: ${newVersion.name}`);

  // List all versions to find which to disable
  const [allVersions] = await client.listSecretVersions({
    parent: SECRET_NAME,
  });

  // Filter to ENABLED only and sort by version number descending (newest first)
  const enabled = allVersions
    .filter(v => v.state === 'ENABLED')
    .sort((a, b) => {
      const numA = parseInt(a.name.split('/').pop(), 10);
      const numB = parseInt(b.name.split('/').pop(), 10);
      return numB - numA;
    });

  console.log(`Enabled versions (${enabled.length}): ${enabled.map(v => v.name.split('/').pop()).join(', ')}`);

  // Disable any enabled version beyond KEEP_VERSIONS
  for (let i = KEEP_VERSIONS; i < enabled.length; i++) {
    const versionName = enabled[i].name;
    await client.disableSecretVersion({ name: versionName });
    console.log(`Disabled old version: ${versionName.split('/').pop()}`);
  }

  console.log(`Rotation complete. Keeping ${Math.min(KEEP_VERSIONS, enabled.length)} enabled version(s).`);
}

main().catch(err => {
  console.error('Rotation failed:', err.message);
  process.exit(1);
});
