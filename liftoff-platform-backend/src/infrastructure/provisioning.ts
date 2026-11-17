// Infrastructure Provisioning Service
// Per Section 2: Triggers Terraform to create tenant-<id>-runtime project

import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from './logging';

const cloudbuild = new CloudBuildClient();
const secretManager = new SecretManagerServiceClient();
// Read env at call-time, not at module-import time. The tests inject
// GCP_PROJECT / GCP_REGION inside beforeEach via process.env reassignment;
// module-level constants would have been frozen at the parent jest
// process's env values and the test mock would no-op.
const projectId = () => process.env.GCP_PROJECT || 'control';
const region = () => process.env.GCP_REGION || 'us-central1';

export interface ProvisioningRequest {
  tenantId: string;
  accountId: string;
  tenantName: string;
  environment: string;
  tier: 'standard' | 'enterprise';
}

export interface ProvisioningResult {
  success: boolean;
  buildId?: string;
  gcpProjectId?: string;
  error?: string;
}

export interface DeprovisioningRequest {
  tenantId: string;
  gcpProjectId: string;
}

export class InfrastructureProvisioningService {
  private triggerName: string;

  constructor() {
    this.triggerName = `tenant-provisioning-${process.env.ENVIRONMENT || 'dev'}`;
  }

  // Per Section 2: Trigger Terraform to provision tenant runtime project
  async provisionTenantInfrastructure(
    request: ProvisioningRequest
  ): Promise<ProvisioningResult> {
    log.info({ tenantId: request.tenantId }, 'Starting tenant infrastructure provisioning');

    try {
      // Generate the GCP project ID for the tenant
      const gcpProjectId = this.generateProjectId(request.tenantId, request.environment);

      // Per Section 2: Trigger Cloud Build to run Terraform
      const [operation] = await cloudbuild.runBuildTrigger({
        projectId: projectId(),
        triggerId: this.triggerName,
        source: {
          substitutions: {
            _TENANT_ID: request.tenantId,
            _ACCOUNT_ID: request.accountId,
            _TENANT_NAME: request.tenantName,
            _ENVIRONMENT: request.environment,
            _TIER: request.tier,
            _GCP_PROJECT_ID: gcpProjectId,
            _REGION: region(),
          },
        },
      });

      // Wait for the build to start
      const [build] = await operation.promise();

      log.info({
        tenantId: request.tenantId,
        buildId: build.id,
        gcpProjectId,
      }, 'Infrastructure provisioning build started');

      return {
        success: true,
        buildId: build.id ?? undefined,
        gcpProjectId,
      };
    } catch (error) {
      log.error({
        tenantId: request.tenantId,
        error,
      }, 'Failed to start infrastructure provisioning');

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // Check provisioning build status
  async checkProvisioningStatus(buildId: string): Promise<{
    status: 'pending' | 'running' | 'success' | 'failure' | 'canceled';
    message?: string;
  }> {
    try {
      const [build] = await cloudbuild.getBuild({
        projectId: projectId(),
        id: buildId,
      });

      switch (build.status) {
        case 'QUEUED':
        case 'PENDING':
          return { status: 'pending' };
        case 'WORKING':
          return { status: 'running' };
        case 'SUCCESS':
          return { status: 'success' };
        case 'FAILURE':
        case 'INTERNAL_ERROR':
        case 'TIMEOUT':
          return {
            status: 'failure',
            message: build.statusDetail || 'Build failed',
          };
        case 'CANCELLED':
          return { status: 'canceled' };
        default:
          return { status: 'pending' };
      }
    } catch (error) {
      log.error({ buildId, error }, 'Failed to check provisioning status');
      return {
        status: 'failure',
        message: (error as Error).message,
      };
    }
  }

  // Per Section 2: Deprovision tenant infrastructure (for cleanup)
  async deprovisionTenantInfrastructure(
    request: DeprovisioningRequest
  ): Promise<ProvisioningResult> {
    log.info({ tenantId: request.tenantId }, 'Starting tenant infrastructure deprovisioning');

    try {
      const [operation] = await cloudbuild.runBuildTrigger({
        projectId: projectId(),
        triggerId: `tenant-deprovisioning-${process.env.ENVIRONMENT || 'dev'}`,
        source: {
          substitutions: {
            _TENANT_ID: request.tenantId,
            _GCP_PROJECT_ID: request.gcpProjectId,
            _ACTION: 'destroy',
          },
        },
      });

      const [build] = await operation.promise();

      log.info({
        tenantId: request.tenantId,
        buildId: build.id,
      }, 'Infrastructure deprovisioning build started');

      return {
        success: true,
        buildId: build.id ?? undefined,
      };
    } catch (error) {
      log.error({
        tenantId: request.tenantId,
        error,
      }, 'Failed to start infrastructure deprovisioning');

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // Copy shared secrets from platform control project to tenant project.
  // Called after Terraform provisioning creates the secret shells.
  // The platform backend SA has secretmanager.admin on tenant projects.
  async populateTenantSecrets(
    tenantGcpProjectId: string,
    environment: string
  ): Promise<void> {
    const controlProjectId = `YOUR_GCP_PROJECT`;

    // Secrets to copy: { source secret ID in control project → target secret ID in tenant project }
    const secretsToCopy: Array<{ source: string; target: string }> = [
      { source: `google-oauth-client-id-${environment}`, target: `google-oauth-client-id-${environment}` },
      { source: `google-oauth-client-secret-${environment}`, target: `google-oauth-client-secret-${environment}` },
      { source: `openai-api-key`, target: `openai-api-key-${environment}` },
      { source: `slack-oauth-client-id-${environment}`, target: `slack-oauth-client-id-${environment}` },
      { source: `slack-oauth-client-secret-${environment}`, target: `slack-oauth-client-secret-${environment}` },
      { source: `github-oauth-client-id-${environment}`, target: `github-oauth-client-id-${environment}` },
      { source: `github-oauth-client-secret-${environment}`, target: `github-oauth-client-secret-${environment}` },
      { source: `microsoft-oauth-client-id-${environment}`, target: `microsoft-oauth-client-id-${environment}` },
      { source: `microsoft-oauth-client-secret-${environment}`, target: `microsoft-oauth-client-secret-${environment}` },
      { source: `dropbox-oauth-client-id-${environment}`, target: `dropbox-oauth-client-id-${environment}` },
      { source: `dropbox-oauth-client-secret-${environment}`, target: `dropbox-oauth-client-secret-${environment}` },
      { source: `box-oauth-client-id-${environment}`, target: `box-oauth-client-id-${environment}` },
      { source: `box-oauth-client-secret-${environment}`, target: `box-oauth-client-secret-${environment}` },
      { source: `salesforce-oauth-client-id-${environment}`, target: `salesforce-oauth-client-id-${environment}` },
      { source: `salesforce-oauth-client-secret-${environment}`, target: `salesforce-oauth-client-secret-${environment}` },
      // Web-tool vendor API keys (webclaw / firecrawl / anchor / browserbase /
      // browserbase-project-id) are deliberately NOT copied per tenant. They
      // are Liftoff-owned keys — billed to one Liftoff account regardless of
      // which tenant agent invokes them — so duplicating them N× yields zero
      // isolation gain and N× drift surface. The tenant runtime reads them
      // cross-project via getWebToolSecret() in
      // src/integrations/web-fetch/web-tool-secrets.ts, scoped by the
      // platform-control SA grant in tenant-runtime-template/main.tf.
    ];

    log.info({ tenantProject: tenantGcpProjectId, secretCount: secretsToCopy.length },
      'Populating tenant secrets from platform control project');

    for (const { source, target } of secretsToCopy) {
      try {
        // Read from platform control project
        const [version] = await secretManager.accessSecretVersion({
          name: `projects/${controlProjectId}/secrets/${source}/versions/latest`,
        });

        const secretValue = version.payload?.data;
        if (!secretValue) {
          log.warn({ source, target }, 'Source secret has no data, skipping');
          continue;
        }

        // Check if target already has a version (don't overwrite existing)
        try {
          await secretManager.accessSecretVersion({
            name: `projects/${tenantGcpProjectId}/secrets/${target}/versions/latest`,
          });
          log.info({ target }, 'Target secret already has data, skipping');
          continue;
        } catch {
          // No version exists — proceed to create one
        }

        // Write to tenant project
        await secretManager.addSecretVersion({
          parent: `projects/${tenantGcpProjectId}/secrets/${target}`,
          payload: {
            data: secretValue,
          },
        });

        log.info({ source, target }, 'Copied secret to tenant project');
      } catch (error) {
        log.error({ source, target, error: (error as Error).message },
          'Failed to copy secret to tenant project');
        // Continue with other secrets — don't fail the whole provisioning
      }
    }
  }

  // Generate GCP project ID following naming convention
  private generateProjectId(tenantId: string, environment: string): string {
    // Per Section 2: tenant-<id>-runtime project naming
    // GCP project IDs must be 6-30 characters, lowercase letters, digits, hyphens
    const shortTenantId = tenantId.replace(/-/g, '').substring(0, 12);
    const envSuffix = environment === 'prod' ? '' : `-${environment}`;
    return `tenant-${shortTenantId}-runtime${envSuffix}`;
  }
}

// Singleton instance
export const infrastructureProvisioningService = new InfrastructureProvisioningService();
