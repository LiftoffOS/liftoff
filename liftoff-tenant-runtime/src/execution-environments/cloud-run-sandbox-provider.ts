// Cloud Run Sandbox Provider
// Concrete implementation of SandboxProviderV2 using Cloud Run Services with a sidecar agent.
// The sidecar exposes an HTTP API under /v1/* (shell, file, browser, bash, nodejs, code, util, mcp, proxy, sandbox-meta).
// Uses the Cloud Run Admin API v2 REST endpoints for lifecycle (create/destroy).

import { v4 as uuid } from 'uuid';
import { sandboxVpcAccess } from './sandbox-vpc-access';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { randomBytes } from 'crypto';
import { SignJWT } from 'jose';
import { log } from '../infrastructure/logging';
import {
  SandboxProviderV2,
  SandboxConfig,
  SandboxInstance,
  ExecutionEnvironmentType,
  ExecOpts,
  ExecResult,
  PtyCreateOpts,
  ShellSessionHandle,
  ShellSessionView,
  BrowserActionResult,
  BrowserPageHandle,
  FileWatcherHandle,
  FileWatchEvent,
} from './types';

const SIDECAR_PORT = 8080;
const EXEC_PATH = '/v1/shell/exec';
const READ_FILE_PATH = '/v1/file/read';
const WRITE_FILE_PATH = '/v1/file/write';
const SHELL_SESSION_PATH = '/v1/shell/sessions';
const FILE_EDITOR_PATH = '/v1/file/str_replace_editor';
const FILE_GREP_PATH = '/v1/file/grep';
const FILE_GLOB_PATH = '/v1/file/glob';
const FILE_FIND_PATH = '/v1/file/find';
const FILE_WATCH_PATH = '/v1/file/watch';
const BROWSER_PATH = '/v1/browser';
const SANDBOX_INFO_PATH = '/v1/sandbox/info';
const AUTH_TICKETS_PATH = '/v1/auth/tickets';

export interface CloudRunSandboxProviderConfig {
  projectId: string;
  region: string;
  imageRegistry: string;
  serviceUrlTemplate?: string;
  kmsKeyName: string;
  defaultImageTag: string;
  runtimeBaseUrl?: string;
  /**
   * Runtime service account email — granted `roles/run.invoker` on each
   * per-sandbox Cloud Run service so the provider's OIDC ID-token calls
   * pass IAM. Defaults to inferring from K_SERVICE_ACCOUNT (set by Cloud
   * Run); set explicitly in tests + monolith deployments.
   */
  runtimeServiceAccountEmail?: string;
  /**
   * Email of the dedicated, least-privilege SA that the per-sandbox container
   * runs as (the `sandbox-runtime` SA — zero project roles). REQUIRED: create()
   * fails closed if this is unset. It must NOT be the privileged runtime SA — a
   * metadata token minted by agent code inside the sandbox must be near-useless.
   */
  sandboxServiceAccountEmail?: string;
}

async function getAccessToken(): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) throw new Error('Failed to get GCP access token');
  return tokenResponse.token;
}

/**
 * Mint a Cloud Run OIDC ID token with `audience` set to the sandbox service
 * URL. Cloud Run validates this against IAM (roles/run.invoker on caller),
 * never forwards it to the container, and leaves the regular Authorization
 * header free for the sandbox JWT.
 */
async function getIdToken(audience: string): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  // request() against the audience returns the token in the auth header of
  // a self-call — simpler: fetchIdToken on the underlying OAuth2Client.
  const token = await client.idTokenProvider.fetchIdToken(audience);
  if (!token) throw new Error('Failed to mint OIDC id_token');
  return token;
}

async function kmsEncrypt(kmsKeyName: string, plaintext: string): Promise<Buffer> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();
  const [resp] = await client.encrypt({ name: kmsKeyName, plaintext: Buffer.from(plaintext, 'hex') });
  return Buffer.from(resp.ciphertext as Uint8Array);
}

async function kmsDecrypt(kmsKeyName: string, ciphertext: Buffer): Promise<string> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms');
  const client = new KeyManagementServiceClient();
  const [resp] = await client.decrypt({ name: kmsKeyName, ciphertext });
  return Buffer.from(resp.plaintext as Uint8Array).toString('hex');
}

/** Image repository for a template. Only the coding variant has its own; every
 *  other template runs the standard image, which is what they have always run. */
function imageRepositoryFor(template: ExecutionEnvironmentType | undefined): string {
  return template === 'aio-sandbox-coding' ? 'aio-sandbox-coding' : 'aio-sandbox';
}

export class CloudRunSandboxProvider implements SandboxProviderV2 {
  private readonly serviceUrls = new Map<string, string>();
  private readonly jwtSecretCache = new Map<string, { secret: string; expires: number }>();
  private readonly encryptedSecretCache = new Map<string, Buffer>();

  constructor(private readonly config: CloudRunSandboxProviderConfig) {}

  /**
   * Returns the encrypted JWT secret captured at create() time so callers can
   * persist it to sandbox_state.jwt_secret_encrypted.
   */
  getEncryptedSecret(sandboxId: string): Buffer | null {
    return this.encryptedSecretCache.get(sandboxId) ?? null;
  }

  async create(sandboxConfig: SandboxConfig, providedSandboxId?: string): Promise<SandboxInstance> {
    if (!this.config.sandboxServiceAccountEmail) {
      throw new Error('Refusing to create sandbox: no dedicated sandbox runtime SA configured (SANDBOX_SERVICE_ACCOUNT_EMAIL). Agent code must not run as the runtime SA.');
    }
    const sandboxId = providedSandboxId ?? `sandbox-${uuid().slice(0, 8)}`;
    // The template selects the image REPOSITORY; the tag is the same build for
    // both, so a deploy moves them together and they cannot skew.
    //
    // This used to be the literal `aio-sandbox` while the log line below
    // faithfully printed `sandboxConfig.template` beside it — so a template
    // that was never honoured still read as honoured in the logs.
    const image = `${this.config.imageRegistry}/${imageRepositoryFor(sandboxConfig.template)}`
      + `:${this.config.defaultImageTag}`;

    log.info({
      message: 'Creating Cloud Run sandbox service',
      sandboxId,
      template: sandboxConfig.template,
      image,
    });

    const jwtSecret = randomBytes(32).toString('hex');
    let jwtSecretEncrypted: Buffer | null = null;
    if (this.config.kmsKeyName) {
      try {
        jwtSecretEncrypted = await kmsEncrypt(this.config.kmsKeyName, jwtSecret);
        this.encryptedSecretCache.set(sandboxId, jwtSecretEncrypted);
      } catch (err) {
        log.warn({ message: 'KMS encrypt failed; secret not persisted', error: (err as Error).message });
      }
    }
    this.jwtSecretCache.set(sandboxId, { secret: jwtSecret, expires: Date.now() + 6 * 60 * 60 * 1000 });

    // Tracks whether the Cloud Run service was created successfully so the catch
    // block can delete it if a downstream step (IAM binding, waitForServiceReady)
    // throws. Without this, a failed create leaks a `minScale=1` service that
    // Cloud Run perpetually retries the broken probe against. When the
    // sidecar's nginx-liveness probe is failing, services never become Ready,
    // but the half-created Cloud Run resources stay alive consuming quota for
    // days.
    let serviceCreated = false;
    try {
      const token = await getAccessToken();
      const parent = `projects/${this.config.projectId}/locations/${this.config.region}`;

      const createResponse = await fetch(
        `https://run.googleapis.com/v2/${parent}/services?serviceId=${sandboxId}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template: {
              executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
              // Put the sandbox on the tenant VPC with ALL_TRAFFIC egress — the
              // same config the runtime services use. Without this the sandbox is
              // off-VPC and CANNOT reach the internal-ingress runtime, so the
              // sidecar's callbacks (events, mcp tools, mcp dispatch) all fail
              // with an HTML ingress-rejection. ALL_TRAFFIC routes internet out
              // through the VPC's Cloud NAT, so agent code keeps full internet
              // access (NOT restricted) while internal services become reachable.
              ...sandboxVpcAccess(process.env),
              containers: [{
                image,
                ports: [{ containerPort: SIDECAR_PORT }],
                resources: {
                  limits: {
                    cpu: `${Math.ceil(sandboxConfig.resourceLimits.cpuMillis / 1000)}`,
                    memory: `${sandboxConfig.resourceLimits.memoryMb}Mi`,
                  },
                  // Extra CPU while the container starts, released once it is
                  // serving. Every provision here is a cold start by
                  // construction — the service is created per sandbox and
                  // destroyed after — so the boost applies to all of them, and
                  // the thing it accelerates is exactly this image's slow part:
                  // supervisord bringing up six processes before the sidecar
                  // binds /health. Costs nothing at rest because nothing here
                  // is ever at rest.
                  startupCpuBoost: true,
                },
                env: [
                  { name: 'SANDBOX_ID', value: sandboxId },
                  // Prefer THIS sandbox's session identity (passed in sandboxConfig)
                  // over the sandbox-executor's shared process.env, which is the
                  // same for every agent in the tenant and therefore a placeholder
                  // (AGENT_ID unset → 'unknown', TENANT_ID = slug). The sidecar
                  // signs these into its callback JWTs, so getting them right is
                  // what lets connector dispatch from sandbox code resolve the
                  // correct agent's tools/bindings/oversight.
                  { name: 'TENANT_ID', value: sandboxConfig.tenantId ?? process.env.TENANT_ID ?? 'unknown' },
                  { name: 'AGENT_ID', value: sandboxConfig.agentId ?? process.env.AGENT_ID ?? 'unknown' },
                  { name: 'INSTRUCTION_VERSION', value: String(sandboxConfig.instructionVersion ?? process.env.INSTRUCTION_VERSION ?? '1') },
                  { name: 'RUNTIME_BASE_URL', value: this.config.runtimeBaseUrl ?? process.env.TENANT_RUNTIME_INTERNAL_URL ?? '' },
                  { name: 'SANDBOX_JWT_SECRET', value: jwtSecret },
                  { name: 'WORKSPACE_DIR', value: '/workspace' },
                  { name: 'MAX_OUTPUT_BYTES', value: String(sandboxConfig.resourceLimits.maxOutputBytes) },
                  { name: 'ENABLE_VNC', value: 'true' },
                  { name: 'ENABLE_VSCODE', value: 'true' },
                ],
                // aio-sandbox is ~3 GB and the inner stack (supervisord →
                // xvfb / x11vnc / novnc / openvscode / sidecar / nginx) takes
                // several minutes to come up the first time a Cloud Run
                // worker pulls the image cross-project. 12×5s=60s was below
                // the floor; the BUDGET is periodSeconds × failureThreshold and
                // it must stay at 300s. Do not shrink it by lowering the
                // threshold when changing the period.
                //
                // The period is separately a LATENCY cost, and it was paying
                // twice: readiness can go unnoticed for several seconds after
                // the container's first log line, none of it work. A 5s initial
                // delay before the first check, then up to another 5s until the
                // next one, on a sidecar that binds /health as soon as it is up.
                //
                // 0 + 2×150 keeps the same 300s window and detects readiness
                // within ~2s instead of ~10s. There is nothing to wait for
                // before the first probe: a probe that arrives too early simply
                // fails and is retried.
                startupProbe: {
                  httpGet: { path: '/health', port: 8080 },
                  initialDelaySeconds: 0,
                  periodSeconds: 2,
                  timeoutSeconds: 3,
                  failureThreshold: 150,
                },
                livenessProbe: {
                  httpGet: { path: '/health', port: 8080 },
                  periodSeconds: 30,
                  timeoutSeconds: 5,
                  failureThreshold: 3,
                },
              }],
              // Per-sandbox container runs as the dedicated least-privilege
              // `sandbox-runtime` SA (zero project roles), NOT the project compute
              // default and NOT the privileged runtime SA. Setting it here also
              // satisfies Cloud Run's actAs check via the iam.serviceAccountUser
              // binding the sandbox-executor SA holds on sandbox-runtime
              // (executor_actas_sandbox_runtime). Guaranteed present by the
              // fail-closed guard at the top of create().
              serviceAccount: this.config.sandboxServiceAccountEmail,
              timeout: `${Math.ceil(sandboxConfig.timeoutMs / 1000)}s`,
              scaling: { minInstanceCount: 1, maxInstanceCount: 1 },
            },
            ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
          }),
        },
      );

      if (!createResponse.ok) {
        const errorBody = await createResponse.text();
        throw new Error(`Cloud Run API error (${createResponse.status}): ${errorBody}`);
      }
      // From this point on the service exists in Cloud Run and the catch block
      // owns cleanup if anything downstream throws.
      serviceCreated = true;

      // Bind the runtime SA as run.invoker so the provider's OIDC-authenticated
      // calls can reach the new service. Default IAM = nobody, so without this
      // every subsequent post/get/del would 401 at Cloud Run's frontend before
      // reaching the sidecar.
      const invokerEmail = this.config.runtimeServiceAccountEmail
        ?? process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL
        ?? '';
      if (invokerEmail) {
        await this.setInvokerBinding(sandboxId, invokerEmail, token);
      } else {
        log.warn({
          message: 'Sandbox service created without runtime SA invoker binding',
          sandboxId,
          hint: 'Set CloudRunSandboxProviderConfig.runtimeServiceAccountEmail or RUNTIME_SERVICE_ACCOUNT_EMAIL env',
        });
      }

      const serviceUrl = await this.waitForServiceReady(sandboxId, token);
      this.serviceUrls.set(sandboxId, serviceUrl);

      log.info({ message: 'Sandbox service created', sandboxId, serviceUrl, jwtSecretEncryptedBytes: jwtSecretEncrypted?.length ?? 0 });

      return {
        sandboxId,
        status: 'ready',
        workDir: '/workspace',
        createdAt: new Date(),
        lastHeartbeatAt: new Date(),
      };
    } catch (err) {
      log.error({ message: 'Failed to create sandbox service', sandboxId, error: (err as Error).message });
      if (serviceCreated) {
        // Best-effort orphan cleanup: the Cloud Run service exists but never
        // became Ready (or a later step failed). Delete it so it does not leak
        // as a perpetually-retrying minScale=1 instance. Swallow secondary
        // errors — the original throw is what the caller needs to see.
        try {
          await this.destroy(sandboxId);
          log.info({ message: 'Orphaned sandbox service deleted after create failure', sandboxId });
        } catch (cleanupErr) {
          log.warn({
            message: 'Failed to delete orphaned sandbox service; GC sweep will retry',
            sandboxId,
            cleanupError: (cleanupErr as Error).message,
          });
        }
      }
      // Tidy local caches: the JWT secret and encrypted-secret entries were
      // pre-allocated for the doomed service and are no longer useful.
      this.jwtSecretCache.delete(sandboxId);
      this.encryptedSecretCache.delete(sandboxId);
      throw new Error(`Sandbox creation failed: ${(err as Error).message}`);
    }
  }

  private async signJwt(sandboxId: string): Promise<string> {
    const secret = await this.getJwtSecret(sandboxId);
    return new SignJWT({ sandboxId, scope: 'sandbox' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(Buffer.from(secret, 'hex'));
  }

  private async getJwtSecret(sandboxId: string): Promise<string> {
    const cached = this.jwtSecretCache.get(sandboxId);
    if (cached && cached.expires > Date.now()) return cached.secret;
    throw new Error(`No JWT secret available for sandbox ${sandboxId}; expired or never created`);
  }

  /**
   * Hydrate the cache when the runtime restarts; takes the ciphertext that
   * was stored in sandbox_state.jwt_secret_encrypted, KMS-decrypts it, and
   * seeds the in-memory cache.
   */
  async restoreJwtSecret(sandboxId: string, ciphertext: Buffer): Promise<void> {
    const secret = await kmsDecrypt(this.config.kmsKeyName, ciphertext);
    this.jwtSecretCache.set(sandboxId, { secret, expires: Date.now() + 6 * 60 * 60 * 1000 });
  }

  /**
   * Build the two auth headers for a per-sandbox HTTP call:
   *   - `X-Serverless-Authorization: Bearer <oidc>` — Cloud Run consumes this
   *     for IAM (roles/run.invoker check against the runtime SA), never
   *     forwards it to the container.
   *   - `Authorization: Bearer <sandbox-jwt>` — reaches the sidecar's nginx
   *     auth subrequest, which HS256-verifies against the per-sandbox secret.
   *
   * If serviceUrlTemplate is in use (test override), skip the OIDC mint:
   * tests point at a local fake that doesn't enforce Cloud Run IAM.
   */
  private async authHeaders(sandboxId: string, baseUrl: string): Promise<Record<string, string>> {
    const jwt = await this.signJwt(sandboxId);
    if (this.config.serviceUrlTemplate) {
      return { Authorization: `Bearer ${jwt}` };
    }
    const oidc = await getIdToken(baseUrl);
    return {
      'X-Serverless-Authorization': `Bearer ${oidc}`,
      Authorization: `Bearer ${jwt}`,
    };
  }

  private async post<T>(sandboxId: string, urlPath: string, body: unknown): Promise<T> {
    const baseUrl = this.getServiceUrl(sandboxId);
    const headers = await this.authHeaders(sandboxId, baseUrl);
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await readBoundedErrorText(res);
      throw new Error(`Sandbox ${urlPath} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async get<T>(sandboxId: string, urlPath: string): Promise<T> {
    const baseUrl = this.getServiceUrl(sandboxId);
    const headers = await this.authHeaders(sandboxId, baseUrl);
    const res = await fetch(`${baseUrl}${urlPath}`, { headers });
    if (!res.ok) {
      const text = await readBoundedErrorText(res);
      throw new Error(`Sandbox ${urlPath} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async del<T>(sandboxId: string, urlPath: string): Promise<T> {
    const baseUrl = this.getServiceUrl(sandboxId);
    const headers = await this.authHeaders(sandboxId, baseUrl);
    const res = await fetch(`${baseUrl}${urlPath}`, { method: 'DELETE', headers });
    if (!res.ok) {
      const text = await readBoundedErrorText(res);
      throw new Error(`Sandbox ${urlPath} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Grant the runtime SA `roles/run.invoker` on the freshly-created sandbox
   * service. Required because Cloud Run defaults to no invokers, so the
   * provider's subsequent OIDC-authenticated calls would 401 at the frontend
   * before reaching the sidecar.
   */
  private async setInvokerBinding(sandboxId: string, invokerEmail: string, accessToken: string): Promise<void> {
    const name = `projects/${this.config.projectId}/locations/${this.config.region}/services/${sandboxId}`;
    const res = await fetch(`https://run.googleapis.com/v2/${name}:setIamPolicy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy: {
          bindings: [{ role: 'roles/run.invoker', members: [`serviceAccount:${invokerEmail}`] }],
        },
      }),
    });
    if (!res.ok) {
      const text = await readBoundedErrorText(res);
      log.warn({ message: 'setIamPolicy failed on sandbox service', sandboxId, status: res.status, text });
      throw new Error(`setIamPolicy failed (${res.status}): ${text}`);
    }
  }

  async exec(sandboxId: string, args: string[], opts?: ExecOpts): Promise<ExecResult> {
    return this.post<ExecResult>(sandboxId, EXEC_PATH, {
      args,
      workDir: opts?.workDir ?? '/workspace',
      timeout: opts?.timeout ?? 60_000,
      env: opts?.env,
    });
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const result = await this.post<{ content: string }>(sandboxId, READ_FILE_PATH, { path });
    return result.content;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.post(sandboxId, WRITE_FILE_PATH, { path, content });
  }

  /**
   * Enumerate every Cloud Run service in the project whose name starts with
   * `sandbox-` (the provider's create() prefix). Returns the sandbox id and the
   * service's age in seconds so the executor's orphan sweep can skip in-flight
   * creates whose sandbox_state row hasn't been inserted yet.
   *
   * Uses the v2 services.list endpoint with pagination. 50 services per page is
   * the default; we walk pageToken until exhausted.
   */
  async listSandboxServices(): Promise<import('./types').SandboxServiceRecord[]> {
    const token = await getAccessToken();
    const parent = `projects/${this.config.projectId}/locations/${this.config.region}`;
    const records: import('./types').SandboxServiceRecord[] = [];
    const nowMs = Date.now();
    let pageToken: string | undefined;

    do {
      const url = new URL(`https://run.googleapis.com/v2/${parent}/services`);
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`Cloud Run list services failed (${res.status}): ${await readBoundedErrorText(res)}`);
      }
      const body = (await res.json()) as {
        services?: Array<{ name?: string; createTime?: string }>;
        nextPageToken?: string;
      };

      for (const svc of body.services ?? []) {
        // svc.name is "projects/{p}/locations/{r}/services/{serviceId}".
        const serviceId = svc.name?.split('/').pop() ?? '';
        if (!serviceId.startsWith('sandbox-')) continue;
        // Exclude the orchestrator itself — sandbox-executor uses the same prefix.
        if (serviceId === 'sandbox-executor') continue;

        const createdMs = svc.createTime ? Date.parse(svc.createTime) : nowMs;
        const ageSeconds = Math.floor((nowMs - createdMs) / 1000);
        records.push({ sandboxId: serviceId, ageSeconds });
      }

      pageToken = body.nextPageToken;
    } while (pageToken);

    return records;
  }

  async destroy(sandboxId: string): Promise<void> {
    log.info({ message: 'Destroying sandbox service', sandboxId });
    try {
      const token = await getAccessToken();
      const name = `projects/${this.config.projectId}/locations/${this.config.region}/services/${sandboxId}`;
      const response = await fetch(`https://run.googleapis.com/v2/${name}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 404) {
        const errorBody = await readBoundedErrorText(response);
        throw new Error(`Cloud Run delete failed (${response.status}): ${errorBody}`);
      }
      this.serviceUrls.delete(sandboxId);
      this.jwtSecretCache.delete(sandboxId);
      this.encryptedSecretCache.delete(sandboxId);
      log.info({ message: 'Sandbox service destroyed', sandboxId });
    } catch (err) {
      if ((err as Error).message?.includes('404')) {
        this.serviceUrls.delete(sandboxId);
        return;
      }
      log.error({ message: 'Failed to destroy sandbox service', sandboxId, error: (err as Error).message });
      throw err;
    }
  }

  // ─── Shell PTY ─────────────────────────────────────────────────────────
  async shellSessionCreate(sandboxId: string, opts: PtyCreateOpts): Promise<ShellSessionHandle> {
    return this.post<ShellSessionHandle>(sandboxId, `${SHELL_SESSION_PATH}/create`, opts);
  }
  async shellSessionWrite(sandboxId: string, sessionId: string, data: string): Promise<void> {
    await this.post(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}/write`, { data });
  }
  async shellSessionView(sandboxId: string, sessionId: string, offset?: number): Promise<ShellSessionView> {
    return this.get<ShellSessionView>(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}/view?offset=${offset ?? 0}`);
  }
  async shellSessionWait(sandboxId: string, sessionId: string, timeoutMs: number): Promise<{ exitCode: number | null }> {
    return this.post<{ exitCode: number | null }>(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}/wait`, { timeout_ms: timeoutMs });
  }
  async shellSessionKill(sandboxId: string, sessionId: string): Promise<void> {
    await this.del(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}`);
  }
  async shellSessionResize(sandboxId: string, sessionId: string, cols: number, rows: number): Promise<void> {
    const url = `${this.getServiceUrl(sandboxId)}${SHELL_SESSION_PATH}/${sessionId}`;
    const jwt = await this.signJwt(sandboxId);
    await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ cols, rows }) });
  }
  async shellSessionList(sandboxId: string) {
    return this.get<{ sessions: Array<{ sessionId: string; createdAt: string; status: 'active' | 'exited' }> }>(sandboxId, SHELL_SESSION_PATH);
  }
  async shellSessionStats(sandboxId: string, sessionId: string) {
    return this.get<Record<string, unknown>>(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}/stats`);
  }
  async shellSessionCleanup(sandboxId: string, sessionId: string): Promise<void> {
    await this.post(sandboxId, `${SHELL_SESSION_PATH}/${sessionId}/cleanup`, {});
  }
  async shellSessionCleanupAll(sandboxId: string): Promise<void> {
    await this.post(sandboxId, `${SHELL_SESSION_PATH}/cleanup-all`, {});
  }

  // ─── File richer ops ──────────────────────────────────────────────────
  async fileStrReplaceEditor(sandboxId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(sandboxId, FILE_EDITOR_PATH, body);
  }
  async fileGrep(sandboxId: string, opts: { pattern: string; path?: string; glob?: string }) {
    return this.post<{ matches: Array<{ path: string; line: number; text: string }> }>(sandboxId, FILE_GREP_PATH, opts);
  }
  async fileGlob(sandboxId: string, opts: { pattern: string; root?: string }) {
    return this.post<{ paths: string[] }>(sandboxId, FILE_GLOB_PATH, opts);
  }
  async fileFind(sandboxId: string, opts: { pattern: string; path?: string; type?: 'f' | 'd' }) {
    return this.post<{ paths: string[] }>(sandboxId, FILE_FIND_PATH, opts);
  }
  async fileWatchCreate(sandboxId: string, paths: string[]): Promise<FileWatcherHandle> {
    const result = await this.post<{ watcher_id: string }>(sandboxId, `${FILE_WATCH_PATH}/create`, { paths });
    return { watcherId: result.watcher_id };
  }
  async fileWatchPoll(sandboxId: string, watcherId: string, sinceTs?: number) {
    return this.post<{ events: FileWatchEvent[] }>(sandboxId, `${FILE_WATCH_PATH}/poll`, { watcher_id: watcherId, since: sinceTs });
  }
  async fileWatchStop(sandboxId: string, watcherId: string): Promise<void> {
    await this.post(sandboxId, `${FILE_WATCH_PATH}/stop`, { watcher_id: watcherId });
  }

  // ─── Bash sessions ────────────────────────────────────────────────────
  async bashSessionCreate(sandboxId: string, opts: { cwd?: string; env?: Record<string, string> }): Promise<{ sessionId: string }> {
    return this.post(sandboxId, `/v1/bash/sessions/create`, opts);
  }
  async bashSessionExec(sandboxId: string, sessionId: string, args: string[], timeoutMs?: number) {
    return this.post<{ stdout: string; stderr: string; exitCode: number; cwdAfter: string }>(sandboxId, `/v1/bash/sessions/${sessionId}/exec`, { args, timeout: timeoutMs });
  }
  async bashSessionKill(sandboxId: string, sessionId: string): Promise<void> {
    await this.post(sandboxId, `/v1/bash/sessions/${sessionId}/kill`, {});
  }
  async bashSessionList(sandboxId: string) {
    return this.get<{ sessions: Array<{ id: string; cwd: string; createdAt: string }> }>(sandboxId, `/v1/bash/sessions`);
  }

  // ─── Node.js sessions ──────────────────────────────────────────────────
  async nodejsSessionCreate(sandboxId: string): Promise<{ sessionId: string }> {
    return this.post(sandboxId, `/v1/nodejs/sessions/create`, {});
  }
  async nodejsExecute(sandboxId: string, sessionId: string, code: string) {
    return this.post<{ stdout: string; stderr: string; exitCode: number }>(sandboxId, `/v1/nodejs/sessions/${sessionId}/execute`, { code });
  }
  async nodejsSessionDelete(sandboxId: string, sessionId: string): Promise<void> {
    await this.del(sandboxId, `/v1/nodejs/sessions/${sessionId}`);
  }

  // ─── Code router ──────────────────────────────────────────────────────
  async codeExecute(sandboxId: string, opts: { language: 'python' | 'javascript' | 'bash'; code: string; session_id?: string; timeout_ms?: number }) {
    return this.post<Record<string, unknown>>(sandboxId, `/v1/code/execute`, opts);
  }

  // ─── util ─────────────────────────────────────────────────────────────
  async utilConvertToMarkdown(sandboxId: string, opts: { path?: string; content?: string; mime?: string }) {
    return this.post<{ markdown: string }>(sandboxId, `/v1/util/convertToMarkdown`, opts);
  }

  // ─── Browser core verbs ───────────────────────────────────────────────
  async browserNavigate(sandboxId: string, tabId: string | undefined, url: string) {
    return this.post<BrowserActionResult & { tabId: string }>(sandboxId, `${BROWSER_PATH}/page/navigate`, { tabId, url });
  }
  async browserClick(sandboxId: string, tabId: string, selector: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/click`, { tabId, selector }); }
  async browserFill(sandboxId: string, tabId: string, selector: string, value: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/fill`, { tabId, selector, value }); }
  async browserType(sandboxId: string, tabId: string, selector: string, value: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/type`, { tabId, selector, value }); }
  async browserPressKey(sandboxId: string, tabId: string, key: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/press_key`, { tabId, key }); }
  async browserHover(sandboxId: string, tabId: string, selector: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/hover`, { tabId, selector }); }
  async browserSelectOption(sandboxId: string, tabId: string, selector: string, value: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/select_option`, { tabId, selector, value }); }
  async browserCheck(sandboxId: string, tabId: string, selector: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/check`, { tabId, selector }); }
  async browserUncheck(sandboxId: string, tabId: string, selector: string) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/uncheck`, { tabId, selector }); }
  async browserScroll(sandboxId: string, tabId: string, dx: number, dy: number) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/scroll`, { tabId, dx, dy }); }
  async browserWaitFor(sandboxId: string, tabId: string, selector: string, timeoutMs: number) { return this.post<BrowserActionResult>(sandboxId, `${BROWSER_PATH}/page/wait_for`, { tabId, selector, timeout_ms: timeoutMs }); }
  async browserScreenshot(sandboxId: string, tabId: string, selector?: string) { return this.post<{ pngBase64: string }>(sandboxId, `${BROWSER_PATH}/screenshot`, { tabId, selector }); }
  async browserEvaluate(sandboxId: string, tabId: string, script: string) { return this.post<{ result: unknown }>(sandboxId, `${BROWSER_PATH}/page/evaluate`, { tabId, script }); }
  async browserExtractText(sandboxId: string, tabId: string, selector?: string) { return this.post<{ text: string }>(sandboxId, `${BROWSER_PATH}/page/text`, { tabId, selector }); }
  async browserExtractMarkdown(sandboxId: string, tabId: string) { return this.post<{ markdown: string }>(sandboxId, `${BROWSER_PATH}/page/markdown`, { tabId }); }
  async browserExtractHtml(sandboxId: string, tabId: string) { return this.post<{ html: string }>(sandboxId, `${BROWSER_PATH}/page/html`, { tabId }); }
  async browserListTabs(sandboxId: string) { return this.get<{ tabs: Array<{ tabId: string; url: string; title: string }> }>(sandboxId, `${BROWSER_PATH}/tabs`); }
  async browserNewTab(sandboxId: string): Promise<BrowserPageHandle> { return this.post<BrowserPageHandle>(sandboxId, `${BROWSER_PATH}/tabs/new`, {}); }
  async browserCloseTab(sandboxId: string, tabId: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/tabs/close`, { tabId }); }

  // ─── Browser additional page methods ──────────────────────────────────
  async browserBack(sandboxId: string, tabId: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/back`, { tabId }); }
  async browserForward(sandboxId: string, tabId: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/forward`, { tabId }); }
  async browserReload(sandboxId: string, tabId: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/reload`, { tabId, waitUntil }); }
  async browserHotKey(sandboxId: string, tabId: string, keys: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/hot_key`, { tabId, keys }); }
  async browserUploadFile(sandboxId: string, tabId: string, selector: string, filePaths: string[]): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/upload_file`, { tabId, selector, filePaths }); }
  async browserGetElements(sandboxId: string, tabId: string, selector: string) { return this.post<{ elements: Array<{ tag: string; text: string; attrs: Record<string, string> }> }>(sandboxId, `${BROWSER_PATH}/page/get_elements`, { tabId, selector }); }
  async browserGetConsole(sandboxId: string, tabId: string, since?: number) { return this.post<{ messages: Array<{ level: string; text: string; ts: number }> }>(sandboxId, `${BROWSER_PATH}/page/get_console`, { tabId, since }); }
  async browserExportConsole(sandboxId: string, tabId: string) { return this.post<{ path: string }>(sandboxId, `${BROWSER_PATH}/page/export_console`, { tabId }); }
  async browserFindText(sandboxId: string, tabId: string, text: string) { return this.post<{ found: boolean; selector?: string; bounding_box?: { x: number; y: number; width: number; height: number } }>(sandboxId, `${BROWSER_PATH}/page/find_text`, { tabId, text }); }
  async browserScrollTo(sandboxId: string, tabId: string, x: number, y: number): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/scroll_to`, { tabId, x, y }); }
  async browserScrollToElement(sandboxId: string, tabId: string, selector: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/page/scroll_to_element`, { tabId, selector }); }

  // ─── Browser state ────────────────────────────────────────────────────
  async browserStateSave(sandboxId: string, tabId: string, stateId?: string) { return this.post<{ stateId: string; path: string }>(sandboxId, `${BROWSER_PATH}/state/save`, { tabId, stateId }); }
  async browserStateLoad(sandboxId: string, stateId: string) { return this.post<{ tabId: string }>(sandboxId, `${BROWSER_PATH}/state/load`, { stateId }); }
  async browserStateList(sandboxId: string) { return this.get<{ states: Array<{ stateId: string; createdAt: string; size: number }> }>(sandboxId, `${BROWSER_PATH}/state`); }
  async browserStateDelete(sandboxId: string, stateId: string): Promise<void> { await this.del(sandboxId, `${BROWSER_PATH}/state/${stateId}`); }

  // ─── Browser network ──────────────────────────────────────────────────
  async browserRouteAdd(sandboxId: string, tabId: string, urlPattern: string, action: 'block' | 'fulfill' | 'continue', fulfill?: { status: number; body: string; headers: Record<string, string> }) {
    return this.post<{ routeId: string }>(sandboxId, `${BROWSER_PATH}/network/routes/add`, { tabId, urlPattern, action, fulfill });
  }
  async browserRouteRemove(sandboxId: string, routeId: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/network/routes/remove`, { routeId }); }
  async browserRouteList(sandboxId: string) { return this.get<{ routes: Array<{ routeId: string; tabId: string; urlPattern: string; action: 'block' | 'fulfill' | 'continue' }> }>(sandboxId, `${BROWSER_PATH}/network/routes`); }
  async browserHeadersSet(sandboxId: string, tabId: string, headers: Record<string, string>): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/network/headers/set`, { tabId, headers }); }
  async browserHeadersScoped(sandboxId: string, tabId: string, urlPattern: string, headers: Record<string, string>) { return this.post<{ routeId: string }>(sandboxId, `${BROWSER_PATH}/network/headers/scoped`, { tabId, urlPattern, headers }); }
  async browserHeadersClear(sandboxId: string, tabId: string): Promise<void> { await this.post(sandboxId, `${BROWSER_PATH}/network/headers/clear`, { tabId }); }
  async browserRequestsList(sandboxId: string, tabId: string, since?: number) { return this.get<{ requests: Array<Record<string, unknown>> }>(sandboxId, `${BROWSER_PATH}/network/requests?tabId=${encodeURIComponent(tabId)}${since ? `&since=${since}` : ''}`); }

  // ─── Browser captcha ──────────────────────────────────────────────────
  async browserCaptchaDetect(sandboxId: string, tabId: string) { return this.post<{ detected: boolean; type?: string; selector?: string }>(sandboxId, `${BROWSER_PATH}/captcha/detect`, { tabId }); }
  async browserCaptchaWait(sandboxId: string, tabId: string, timeoutMs?: number) { return this.post<{ solved: boolean; durationMs: number }>(sandboxId, `${BROWSER_PATH}/captcha/wait`, { tabId, timeoutMs }); }

  // ─── Proxy ────────────────────────────────────────────────────────────
  async proxyMappingAdd(sandboxId: string, matchPattern: string, upstreamUrl: string) { return this.post<{ mappingId: string }>(sandboxId, `/v1/proxy/mappings/add`, { matchPattern, upstreamUrl }); }
  async proxyMappingRemove(sandboxId: string, mappingId: string): Promise<void> { await this.post(sandboxId, `/v1/proxy/mappings/remove`, { mappingId }); }
  async proxyMappingList(sandboxId: string) { return this.get<{ mappings: Array<{ id: string; pattern: string; upstream: string }> }>(sandboxId, `/v1/proxy/mappings`); }
  async proxyExcludeAdd(sandboxId: string, pattern: string) { return this.post<{ excludeId: string }>(sandboxId, `/v1/proxy/excludes/add`, { pattern }); }
  async proxyExcludeRemove(sandboxId: string, excludeId: string): Promise<void> { await this.post(sandboxId, `/v1/proxy/excludes/remove`, { excludeId }); }
  async proxyExcludeList(sandboxId: string) { return this.get<{ excludes: Array<{ id: string; pattern: string }> }>(sandboxId, `/v1/proxy/excludes`); }
  async proxyUpstreamSet(sandboxId: string, upstreamUrl: string): Promise<void> { await this.post(sandboxId, `/v1/proxy/upstream/set`, { upstreamUrl }); }
  async proxyUpstreamRemove(sandboxId: string): Promise<void> { await this.post(sandboxId, `/v1/proxy/upstream/remove`, {}); }
  async proxyUpstreamGet(sandboxId: string) { return this.get<{ upstreamUrl: string | null }>(sandboxId, `/v1/proxy/upstream`); }
  async proxyHealth(sandboxId: string) { return this.get<{ healthy: boolean; requestsServed: number; errors: number }>(sandboxId, `/v1/proxy/health`); }
  async proxyDiagnose(sandboxId: string, url: string) { return this.post<{ reachable: boolean; latencyMs: number; statusCode?: number; error?: string }>(sandboxId, `/v1/proxy/diagnose`, { url }); }

  // ─── Sandbox-meta ─────────────────────────────────────────────────────
  async getSandboxContext(sandboxId: string) { return this.get<Record<string, unknown>>(sandboxId, `/v1/sandbox/context`); }
  async listPythonPackages(sandboxId: string) { return this.get<{ packages: Array<{ name: string; version: string }> }>(sandboxId, `/v1/sandbox/packages/python`); }
  async listNodejsPackages(sandboxId: string) { return this.get<{ packages: Array<{ name: string; version: string }> }>(sandboxId, `/v1/sandbox/packages/nodejs`); }
  async restartSandbox(sandboxId: string) { return this.post<{ success: boolean; restarted_programs: string[] }>(sandboxId, `/v1/sandbox/restart`, {}); }

  /**
   * Update the sandbox's event routing context — threadId + invocationId. The
   * sandbox's event-emitter uses these to label outbound events so the runtime
   * can fan them out to the right SSE subscribers.
   */
  async setRoutingContext(sandboxId: string, ctx: { threadId?: string; invocationId?: string }): Promise<void> {
    await this.post(sandboxId, `/v1/sandbox/routing-context`, ctx);
  }

  // ─── MCP discoverability ──────────────────────────────────────────────
  async mcpListTools(sandboxId: string) { return this.get<{ tools: Array<Record<string, unknown>> }>(sandboxId, `/v1/mcp/tools`); }
  async mcpDispatch(sandboxId: string, toolName: string, args: Record<string, unknown>, idempotencyKey?: string) { return this.post<Record<string, unknown>>(sandboxId, `/v1/mcp/dispatch`, { tool_name: toolName, args, idempotency_key: idempotencyKey }); }
  async mcpAwaitApproval(sandboxId: string, idempotencyKey: string, timeoutMs: number) { return this.post<Record<string, unknown>>(sandboxId, `/v1/mcp/await-approval`, { idempotencyKey, timeout_ms: timeoutMs }); }

  // ─── Info ─────────────────────────────────────────────────────────────
  async getSandboxInfo(sandboxId: string): Promise<{ cdpUrl: string; vscodeUrl: string; vncUrl: string }> {
    const base = this.getServiceUrl(sandboxId);
    const ticket = await this.issueTicket(sandboxId, 'vscode', 300);
    return {
      cdpUrl: `${base}/cdp/devtools/browser`,
      vscodeUrl: `${base}/vscode/?ticket=${ticket.ticket}&folder=/workspace`,
      vncUrl: `${base}/vnc/?ticket=${ticket.ticket}&autoconnect=true`,
    };
  }
  async issueTicket(sandboxId: string, purpose: 'vscode' | 'vnc' | 'cdp', ttlSec: number): Promise<{ ticket: string; url: string }> {
    const result = await this.post<{ ticket: string; expires_at: string }>(sandboxId, AUTH_TICKETS_PATH, { purpose, ttl_seconds: ttlSec });
    const base = this.getServiceUrl(sandboxId);
    const url = purpose === 'vscode'
      ? `${base}/vscode/?ticket=${result.ticket}&folder=/workspace`
      : purpose === 'vnc'
      ? `${base}/vnc/?ticket=${result.ticket}&autoconnect=true`
      : `${base}/cdp/?ticket=${result.ticket}`;
    return { ticket: result.ticket, url };
  }

  private async waitForServiceReady(sandboxId: string, token: string, maxWaitMs = 360_000): Promise<string> {
    const name = `projects/${this.config.projectId}/locations/${this.config.region}/services/${sandboxId}`;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const response = await fetch(`https://run.googleapis.com/v2/${name}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (response.ok) {
        const service = await response.json() as { uri?: string; conditions?: Array<{ type: string; state: string }> };
        if (service.uri) return service.uri;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`Sandbox service ${sandboxId} did not become ready within ${maxWaitMs}ms`);
  }

  private getServiceUrl(sandboxId: string): string {
    const cached = this.serviceUrls.get(sandboxId);
    if (cached) return cached;

    if (this.config.serviceUrlTemplate) {
      return this.config.serviceUrlTemplate.replace('{sandboxId}', sandboxId);
    }

    return `https://${sandboxId}-${this.config.projectId}.${this.config.region}.run.app`;
  }
}
