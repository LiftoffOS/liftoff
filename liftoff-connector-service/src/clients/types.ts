// Connector Client Types
// Per Section 7 & 11: Real API clients for compensation and tool gateway

export interface ConnectorCredentials {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
  expiresAt?: Date;
  /** Connector-level config from connectors.config JSONB (e.g. accountIdentifier, workspaceUrl) */
  connectorConfig?: Record<string, unknown>;
  /** Tenant + connector identity forwarded from the executor context so clients
   *  can throw OAuthRefreshError({ tenantId, connectorId }) when a vendor
   *  signals the credential is unusable (e.g. 403 insufficient_scope). The job
   *  runner catches OAuthRefreshError and surfaces 'reconnect_required' through
   *  the existing job-error path. */
  tenantId?: string;
  connectorId?: string;
}

/**
 * Credential provider closure. The connector client calls this on every
 * request. The provider is responsible for returning a usable, non-expired
 * credential — typically by delegating to credentialService.getCredentials,
 * which handles refresh internally.
 *
 * Why a closure rather than a snapshot:
 *   - Access tokens expire (Google: 1h, HubSpot: 30m, Slack: variable).
 *   - Long-running agent executions can cross an expiry boundary mid-flight.
 *   - The closure pattern is the only way the client can ALWAYS get a
 *     non-expired token without the caller having to think about it.
 *
 * MCP clients use a similar pattern via `credentialStore`. This unifies
 * the two so REST and MCP clients have the same lifecycle properties.
 */
export type CredentialProvider = () => Promise<ConnectorCredentials>;

export interface ListFilters {
  since?: Date;       // return records modified/created after this timestamp
  pageToken?: string; // opaque cursor from a prior ListResult.nextPageToken
  limit?: number;     // max records per page; each connector caps at its API maximum
  /** Durable cross-cycle resume token from the last poll (SyncState.lastSyncCursor).
   *  For connectors with no server `since` + no newest-first sort but a durable
   *  incremental token (Ashby syncToken, Instantly cursor tail): the client
   *  resumes from here on the FIRST page of a cycle instead of restarting. */
  syncCursor?: string;
  /** Optional connector-specific search hint. Today only google-mail honors
   *  this (as Gmail's `q` query). Other 54 connector clients ignore it. */
  q?: string;
}

export interface ListResult {
  records: ExternalRecord[];
  nextPageToken?: string; // present when more pages exist
  hasMore: boolean;
  pollCursor?: string;    // terminal cursor for delta polling (Dropbox only)
  /** Durable resume token to persist for the NEXT poll cycle (→
   *  SyncState.lastSyncCursor). Emitted by durableCursor-mode specs; the
   *  scheduler carries the latest non-null value across the drain. */
  syncCursor?: string;
  /** THIS CLIENT CANNOT ENUMERATE THAT ENTITY — as distinct from "there are
   *  none".
   *
   *  Those two were the same answer until now: `records: []`. That ambiguity is
   *  what made every gap in this area silent. A picker asking for Slack
   *  channels got an empty array, showed "no channels found", and told the
   *  customer their workspace was empty when the truth was that nothing had
   *  been implemented. A required destination then blocked the hire with
   *  nothing on screen and nothing in the logs.
   *
   *  Set it when an entityType is outside what the client supports. Leave it
   *  unset for a genuine empty result, which is a real and different answer.
   *  Callers that render a list must distinguish the two: one is about the
   *  customer's data, the other is about us. */
  unsupported?: true;
}

export interface ConnectorClient {
  connector: string;

  // Read operations.
  // `payload` is the full tool-call payload from the LLM. Most connectors only
  // need entityId, but some (e.g. google-sheets read_values) take compound
  // arguments like { spreadsheetId, range } where there is no single id field.
  // Implementations may ignore `payload` and rely solely on entityId.
  read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord>;

  // Polling — list records modified since a cursor / timestamp.
  list(entityType: string, filters?: ListFilters): Promise<ListResult>;

  // Write operations
  create(entityType: string, data: Record<string, any>): Promise<CreateResult>;
  update(entityType: string, entityId: string | undefined, data: Record<string, any>): Promise<UpdateResult>;
  delete(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<DeleteResult>;
}

export interface ExternalRecord {
  id: string;
  data: Record<string, any>;
  versionToken?: string;
  lastModified?: Date;
}

export interface CreateResult {
  success: boolean;
  id: string;
  data?: Record<string, any>;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  versionToken?: string;
  data?: Record<string, any>;
  error?: string;
}

export interface DeleteResult {
  success: boolean;
  error?: string;
}

// Compensation-specific operations
export interface CompensationClient extends ConnectorClient {
  // Restore from snapshot
  restore(entityType: string, entityId: string | undefined, snapshot: Record<string, any>): Promise<UpdateResult>;

  // Semantic inverse (e.g., delete what was created)
  semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult>;
}
