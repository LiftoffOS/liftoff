// The cost pass's scope: which feeds one pass reads (ingest-runner.ts).
//
// Its own module, importing nothing, so the route that parses a scope from a
// request body does not pull in every ingester to know the source names.

export type IngestSource =
  | 'platformLlm' | 'runtime' | 'governance' | 'developer_proxy' | 'sandbox' | 'usageLedger';

export const INGEST_SOURCES: readonly IngestSource[] = [
  'platformLlm', 'runtime', 'governance', 'developer_proxy', 'sandbox', 'usageLedger',
];

/**
 * Which feeds one pass reads. Omitted fields mean "all".
 *
 * The scope exists because the runtime feeds are served by the tenant
 * runtime's agent-service, which bills by the instance: a pass that polled
 * every workspace's runtime because this service made a model call woke it
 * for nothing. `tenantId` narrows the four per-workspace ingesters (runtime,
 * sandbox, usage ledger, governance) to the workspace whose run finished.
 */
export interface IngestScope {
  sources?: readonly IngestSource[];
  tenantId?: string;
}
