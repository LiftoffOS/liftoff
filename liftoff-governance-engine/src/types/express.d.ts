// Express Request Extension
// Extends Express Request interface to include ctx (context) properties used
// by the ported hitl-enforcement / audit routers. Copied verbatim from
// tenant-runtime/src/types/express.d.ts so req.ctx types resolve identically.

declare global {
  namespace Express {
    interface Request {
      ctx?: {
        userId?: string;
        tenantId?: string;
        role?: string;
        agentId?: string;
        traceId?: string;
      };
      traceContext?: {
        tenantId?: string;
        traceId?: string;
        agentId?: string;
        workflowId?: string;
      };
    }
  }
}

export {};
