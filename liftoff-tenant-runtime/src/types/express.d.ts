// Express Request Extension
// Extends Express Request interface to include ctx (context) properties

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
