import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const lintScript = resolve(__dirname, '..', 'lint-cloudbuild.mjs');

function runLint(yaml: string): { exitCode: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-cloudbuild-'));
  const path = join(dir, 'cloudbuild.yaml');
  writeFileSync(path, yaml);
  try {
    const stdout = execSync(`node ${lintScript}`, {
      env: { ...process.env, CLOUDBUILD_YAML: path },
      stdio: 'pipe',
    }).toString();
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    return {
      exitCode: e.status ?? 1,
      stderr: e.stderr?.toString() ?? '',
      stdout: e.stdout?.toString() ?? '',
    };
  }
}

describe('lint-cloudbuild', () => {
  it('detects when coordinator-service is missing TENANT_RUNTIME_URL', () => {
    const yaml = `
steps:
  - name: cloudsdk
    args:
      - gcloud run services update coordinator-service --set-env-vars "SERVICE_TYPE=coordinator,GCP_PROJECT_ID=foo,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/coordinator-service.*TENANT_RUNTIME_URL/);
  });

  it('passes when all services have required env', () => {
    const yaml = `
steps:
  - args:
      - gcloud run deploy agent-service --set-env-vars "SERVICE_TYPE=agent,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PLATFORM_BACKEND_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run deploy coordinator-service --set-env-vars "SERVICE_TYPE=coordinator,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PUBSUB_PUSH_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run deploy tool-gateway-service --set-env-vars "SERVICE_TYPE=tool-gateway,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p"
  - args:
      - gcloud run deploy reflection-service --set-env-vars "SERVICE_TYPE=reflection,GCP_PROJECT_ID=p"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/cloudbuild lint OK/);
  });

  it('reads a list in gcloud’s alternate-delimiter form, where a value may hold a comma', () => {
    // `^~^A=1~B=x,y` is one list of two pairs, the second value holding a comma.
    // Split on commas it read as a key named `^~^SERVICE_TYPE` and a missing
    // GCP_PROJECT_ID, and failed the build that introduced the form.
    const yaml = `
steps:
  - args:
      - gcloud run deploy agent-service --set-env-vars "SERVICE_TYPE=agent,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PLATFORM_BACKEND_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run deploy coordinator-service --set-env-vars "SERVICE_TYPE=coordinator,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PUBSUB_PUSH_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run deploy tool-gateway-service --set-env-vars "^~^SERVICE_TYPE=tool-gateway~TENANT_RUNTIME_URL=https://x~GCP_PROJECT_ID=p~PROVENANCE_ENFORCE_CONNECTORS=github,google_mail"
  - args:
      - gcloud run deploy reflection-service --set-env-vars "SERVICE_TYPE=reflection,GCP_PROJECT_ID=p"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(0);
  });

  it('unions --set-env-vars and --update-env-vars across multiple gcloud calls', () => {
    const yaml = `
steps:
  - args:
      - gcloud run deploy agent-service --set-env-vars "SERVICE_TYPE=agent,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PLATFORM_BACKEND_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run services update agent-service --update-env-vars "TENANT_RUNTIME_URL=https://x"
  - args:
      - gcloud run deploy coordinator-service --set-env-vars "SERVICE_TYPE=coordinator,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa,PUBSUB_PUSH_SA_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  - args:
      - gcloud run deploy tool-gateway-service --set-env-vars "SERVICE_TYPE=tool-gateway,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p"
  - args:
      - gcloud run deploy reflection-service --set-env-vars "SERVICE_TYPE=reflection,GCP_PROJECT_ID=p"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(0);
  });

  it('detects when coordinator-service is missing PUBSUB_PUSH_SA_EMAIL (Phase 5 push migration)', () => {
    // Required because coordinator-service exposes POST /internal/pubsub/:topic
    // and verifies the inbound OIDC `email` claim against PUBSUB_PUSH_SA_EMAIL.
    const yaml = `
steps:
  - args:
      - gcloud run deploy coordinator-service --set-env-vars "SERVICE_TYPE=coordinator,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/coordinator-service.*PUBSUB_PUSH_SA_EMAIL/);
  });

  it('detects when agent-service is missing PLATFORM_BACKEND_SA_EMAIL', () => {
    // Required because agent-service mounts the reconciler-facing
    // /internal/agents/sync-state route which validates inbound OIDC tokens.
    const yaml = `
steps:
  - args:
      - gcloud run deploy agent-service --set-env-vars "SERVICE_TYPE=agent,TENANT_RUNTIME_URL=https://x,GCP_PROJECT_ID=p,CLOUD_SCHEDULER_SERVICE_ACCOUNT=sa"
`;
    const result = runLint(yaml);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/agent-service.*PLATFORM_BACKEND_SA_EMAIL/);
  });
});
