// Connect-RPC Router
// Registers ByokService RPC handlers via fastifyConnectPlugin.
// ByokService is dynamically imported with a null-guard — if @liftoffos/proto-gen
// doesn't yet export it, the handler registration is silently skipped.

import type { FastifyInstance } from 'fastify';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import type { ConnectRouter } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import * as credService from '../credentials/service.js';

export function registerRpcRoutes(app: FastifyInstance): void {
  void app.register(fastifyConnectPlugin, {
    routes: async (router: ConnectRouter) => {
      let ByokService: unknown;
      try {
        // @ts-expect-error — ByokService not yet in proto-gen types
        ({ ByokService } = await import('@liftoffos/proto-gen'));
      } catch {
        // proto-gen not published yet — skip RPC registration
        return;
      }
      if (!ByokService) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.service(ByokService as any, ({
        async createCredential(req: {
          tenantId?: string;
          userId?: string;
          vendor?: number;
          rawApiKey?: string;
          label?: string;
        }) {
          if (!req.tenantId || !req.userId) {
            throw new ConnectError('tenantId and userId required', Code.InvalidArgument);
          }
          // Proto enum: 0/unspecified + 1 = anthropic, 2 = openai. Unknown values are
          // REJECTED — never silently coerced to a vendor.
          let vendor: 'anthropic' | 'openai';
          if (req.vendor === undefined || req.vendor === 0 || req.vendor === 1) {
            vendor = 'anthropic';
          } else if (req.vendor === 2) {
            vendor = 'openai';
          } else {
            throw new ConnectError(`unknown vendor enum value: ${req.vendor}`, Code.InvalidArgument);
          }
          const result = await credService.createCredential({
            tenantId: req.tenantId,
            userId: req.userId,
            vendor,
            apiKey: req.rawApiKey ?? '',
            label: req.label ?? '',
          });
          return {
            credential: result.credential,
            fullKey: result.fullKey,
            setupToken: result.setupToken,
          } as never;
        },

        async listCredentials(req: { tenantId?: string; userId?: string }) {
          if (!req.tenantId) {
            throw new ConnectError('tenantId required', Code.InvalidArgument);
          }
          const credentials = await credService.listCredentials(req.tenantId, req.userId);
          return { credentials } as never;
        },

        async revokeCredential(req: { tenantId?: string; credentialId?: string }) {
          if (!req.tenantId || !req.credentialId) {
            throw new ConnectError('tenantId and credentialId required', Code.InvalidArgument);
          }
          const { revoked } = await credService.revokeCredential(req.credentialId, req.tenantId);
          if (!revoked) throw new ConnectError('credential not found', Code.NotFound);
          return {} as never;
        },

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
    },
  });
}
