// Live sandbox-spawn smoke test for the CloudRunSandboxProvider.
//
// SKIPPED by default. Opt in:
//   LIVE_SANDBOX_SPAWN=true \
//   GCP_PROJECT_ID=YOUR_TENANT_PROJECT \
//   GCP_REGION=us-west1 \
//   SANDBOX_IMAGE_REGISTRY=us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/sandbox-images \
//   AIO_SANDBOX_IMAGE_TAG=latest \
//   SANDBOX_SERVICE_ACCOUNT_EMAIL=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
//     npx jest cloud-run-sandbox-provider-live
//
// SANDBOX_SERVICE_ACCOUNT_EMAIL is REQUIRED: create() fails closed without a
// dedicated sandbox runtime SA (agent code must not run as the runtime SA).
//
// Authenticates via Application Default Credentials. On a developer machine,
// `gcloud auth application-default login` provides them. The caller principal
// needs run.admin on the target project (the dev sandbox-executor SA does).
//
// Why this exists: a sidecar nginx-liveness probe bug (auth-gated path
// returning 401 → composite /health 503 → Cloud Run startup probe failing)
// leaks zombie sandboxes, and it is undetectable unless the per-sandbox spawn
// path is exercised end-to-end. This test exercises it before promoting any
// sandbox-sidecar change.
//
// Cost: ~3-5 minutes wall to spawn + verify + tear down a single sandbox.

const live = process.env.LIVE_SANDBOX_SPAWN === 'true';
const describeLive = live ? describe : describe.skip;

describeLive('CloudRunSandboxProvider — live spawn smoke (LIVE_SANDBOX_SPAWN=true)', () => {
  // Cold-start + 60×5s startup probe window + teardown.
  jest.setTimeout(10 * 60_000);

  it('spawns + tears down a sandbox against the configured GCP project', async () => {
    // Dynamic import so the skipped path never loads the provider (which
    // transitively imports `jose`, an ESM-only package outside Jest's
    // transformIgnorePatterns). Only executes when LIVE_SANDBOX_SPAWN=true.
    const { CloudRunSandboxProvider } = await import('../cloud-run-sandbox-provider');
    const { SandboxConfig } = await import('../types');
    void SandboxConfig;   // type-only re-export; suppresses unused-binding lint

    const projectId = process.env.GCP_PROJECT_ID;
    const region = process.env.GCP_REGION ?? 'us-west1';
    const imageRegistry = process.env.SANDBOX_IMAGE_REGISTRY;
    const defaultImageTag = process.env.AIO_SANDBOX_IMAGE_TAG ?? 'latest';

    if (!projectId) throw new Error('GCP_PROJECT_ID is required for LIVE_SANDBOX_SPAWN');
    if (!imageRegistry) throw new Error('SANDBOX_IMAGE_REGISTRY is required for LIVE_SANDBOX_SPAWN');
    if (!process.env.SANDBOX_SERVICE_ACCOUNT_EMAIL) {
      throw new Error('SANDBOX_SERVICE_ACCOUNT_EMAIL is required for LIVE_SANDBOX_SPAWN (create() fails closed without a dedicated sandbox runtime SA)');
    }

    const provider = new CloudRunSandboxProvider({
      projectId,
      region,
      imageRegistry,
      defaultImageTag,
      runtimeBaseUrl: process.env.TENANT_RUNTIME_INTERNAL_URL,
      sandboxServiceAccountEmail: process.env.SANDBOX_SERVICE_ACCOUNT_EMAIL,
      runtimeServiceAccountEmail: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL,
      kmsKeyName: process.env.SANDBOX_KMS_KEY_NAME,
    });

    const config = {
      template: 'aio-sandbox' as const,
      resourceLimits: { cpuMillis: 4_000, memoryMb: 8_192, maxOutputBytes: 1_048_576 },
      timeoutMs: 10 * 60_000,
      egressPolicy: 'deny-all' as const,
    };

    let sandboxId: string | undefined;
    try {
      const instance = await provider.create(config as Parameters<typeof provider.create>[0]);
      sandboxId = instance.sandboxId;

      // Contract assertions — what every successful spawn must produce:
      expect(instance.sandboxId).toMatch(/^sandbox-[a-f0-9]{8}$/);
      expect(instance.status).toBe('ready');
      expect(instance.workDir).toBe('/workspace');
      expect(instance.createdAt).toBeInstanceOf(Date);
    } finally {
      // Always destroy. Even if the create assertions failed, the Cloud Run
      // service may exist and would leak without this teardown.
      if (sandboxId) {
        await provider.destroy(sandboxId).catch(err =>
          // Don't mask the original assertion failure with teardown noise.
           
          console.warn(`teardown failed for ${sandboxId}: ${(err as Error).message}`),
        );
      }
    }
  });
});
