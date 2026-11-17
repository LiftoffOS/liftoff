// Tenant API Service
// Per Section 5: Highest-priority DB client

import { Router } from 'express';
import { TenantApiService } from './service';

export const tenantApiRouter = Router();
const service = new TenantApiService();

// Per Section 4: Tenant runtime may pull entitlement snapshot
tenantApiRouter.get('/entitlement', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const entitlement = await service.getEntitlement(tenantId);
  res.json(entitlement);
});

// Per Section 4: Tenant runtime may pull tenant operational status
tenantApiRouter.get('/status', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const status = await service.getOperationalStatus(tenantId);
  res.json(status);
});

// Per Section 4: Tenant runtime may pull approved deployment revision
tenantApiRouter.get('/deployment', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const deployment = await service.getApprovedDeployment(tenantId);
  res.json(deployment);
});

// Per Section 4: Tenant runtime may pull approved model config
tenantApiRouter.get('/model-config', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const config = await service.getModelConfig(tenantId);
  res.json(config);
});

// Per Section 4: Tenant runtime may pull approved prompt bundle
tenantApiRouter.get('/prompt-bundle', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const bundle = await service.getPromptBundle(tenantId);
  res.json(bundle);
});

// Per Section 4: Tenant runtime may pull feature flags
tenantApiRouter.get('/feature-flags', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const flags = await service.getFeatureFlags(tenantId);
  res.json(flags);
});

// Per Section 4: Tenant runtime may pull tenant migration status
tenantApiRouter.get('/migration-status', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const migrationStatus = await service.getMigrationStatus(tenantId);
  res.json(migrationStatus);
});
