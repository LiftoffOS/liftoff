// Declarative Composio poll specs.
//
// One data structure describes how to reactively poll a composio_managed
// connector: which Composio action (or HTTP proxy) lists an entity, how to
// paginate, how to filter to the scheduler's `since` watermark, where the
// records live in the response, and how to map raw vendor fields to the
// normalized entity shape. A single generic client
// (clients/composio-generic-poll-client.ts) interprets the spec at poll time,
// and a single generic normalizer (normalizers/composio-generic.normalizer.ts)
// interprets it at normalize time — replacing ~300 LOC of bespoke client +
// normalizer per connector with a ~10-line entry here.
//
// Every field below is derived from documentation (Composio action docs/source,
// the vendor's API reference, or the vendor's official client library), never
// guessed — see the plan's verification method.

export type SinceFormat = 'iso' | 'dateOnly' | 'unixSec' | 'unixMs' | 'pipedriveDateTime' | 'spaceDateTime';

export interface SinceSpec {
  /** server = push a since filter arg; sortDesc = sort newest-first and stop
   *  paginating once a page predates `since`; durableCursor = no server filter
   *  and no sort, but a durable incremental token is persisted ACROSS cycles and
   *  resumed forward (never re-scans from the oldest record); none = full list
   *  each cycle. */
  mode: 'server' | 'sortDesc' | 'durableCursor' | 'none';
  /** mode=durableCursor: how the durable resume token is carried.
   *  - tokenArg/tokenPath set (e.g. Ashby `syncToken`): a SEPARATE incremental
   *    token — sent via tokenArg on the first page of a cycle, read back from
   *    tokenPath; within-cycle paging still uses the normal cursor. On the rare
   *    truncated first backfill (no token yet) the pagination cursor is carried
   *    as the resume instead, so huge accounts backfill across cycles.
   *  - omitted (e.g. Instantly): the pagination cursor ITSELF is the durable
   *    resume — persisted and replayed as the first-page cursor next cycle. */
  durable?: { tokenArg?: string; tokenPath?: string[] };
  /** Record path to the entity's updated/created timestamp — used to refine the
   *  server filter to ms precision (client-side) and to version records. */
  field?: string;
  /** mode=server: the lower-bound filter arg + how to format `since`.
   *  `template` (optional) wraps the formatted value for filter-EXPRESSION APIs
   *  that don't take a bare timestamp — the literal `{value}` is replaced by the
   *  formatted since (e.g. Google Meet `start_time>="{value}"`, Jotform
   *  `{"created_at:gt":"{value}"}`). Omitted → the arg is the bare value. */
  serverArg?: { name: string; format: SinceFormat; offsetDays?: number; template?: string };
  /** mode=server with a bounded window (e.g. Datadog start+end): upper bound. */
  windowEndArg?: { name: string; format: SinceFormat };
  /** mode=sortDesc: how to request newest-first — the sort-by arg + its value
   *  (the vendor's sort field name), and optionally a direction arg. */
  sortArg?: { byArg: string; byValue: string; dirArg?: string; descValue?: unknown };
}

export interface PagSpec {
  mode: 'page' | 'offset' | 'cursor' | 'afterId' | 'none';
  limitArg?: string;
  limit?: number;
  /** mode=page (1-indexed page number). */
  pageArg?: string;
  /** mode=offset (numeric record offset). */
  skipArg?: string;
  /** mode=cursor: request arg name + response path to the next-page cursor. */
  cursorArg?: string;
  cursorPath?: string[];
  /** mode=afterId: request arg name; value = last row's id. */
  afterArg?: string;
  /** Optional explicit stop signals. */
  hasMorePath?: string[];
  totalPagesPath?: string[];
}

export interface FieldSpec {
  /** Dot path (or path segments) into the raw record. */
  path: string | string[];
  /** Alternative dot-paths tried in order when `path` is undefined — for
   *  fields a vendor exposes flat OR nested (e.g. Apollo
   *  organization_name | organization.name | account.name). First defined wins. */
  paths?: string[];
  kind: 'string' | 'number' | 'string[]';
  /** For arrays of objects: pick the first element's `from` field. */
  pick?: 'first';
  from?: string;
  /** Extract a scalar from a `key:value` string array (e.g. Datadog tags,
   *  labels): `path` points at the string[], `fromTag: 'env'` returns the
   *  suffix of the first element starting with `env:`. */
  fromTag?: string;
  describe?: string;
}

export interface PollEntity {
  entityType: string;
  eventTopics: string[];
  /** transport 'action' (default): Composio action slug. */
  action?: string;
  /** transport 'proxy': raw vendor HTTP request routed via Composio's proxy. */
  proxy?: { method: 'GET'; endpoint: string; queryParams?: Record<string, string | number> };
  /** Fixed args merged into every call (e.g. { sources: 'alert' }). */
  staticArgs?: Record<string, unknown>;
  /** Response path to the record array; omitted → auto-detect. */
  recordsPath?: string[];
  /** Record path to the id; default 'id'. */
  idField?: string;
  /** When the id path is empty/null, derive a stable id from a content hash of
   *  the record instead of dropping it (e.g. Datadog events with null ids). */
  idFallbackHash?: boolean;
  since?: SinceSpec;
  /** Record path to the field that versions a record for downstream dedup —
   *  distinct from `since.field` when the vendor's list filter and its
   *  change-timestamp differ (e.g. PagerDuty filters by `created_at` but a
   *  status change bumps `updated_at`). Defaults to `since.field`. */
  versionField?: string;
  pagination?: PagSpec;
  /** Minimum interval between polls of this entity, in ms. Omitted → the
   *  scheduler's base cycle (60s). Raise it for low-velocity entities (invoices,
   *  candidates, incidents) to cut Composio call volume/cost — the scheduler
   *  gates on the sync-state `next_sync_at` when this exceeds the base cycle.
   *  A value ≤ the base cycle has no effect (polled every cycle). */
  pollIntervalMs?: number;
  /** Rich field map derived from the vendor's documented schema — drives both
   *  normalization and the published entity schema (distill predicates). */
  fields: Record<string, FieldSpec>;
}

export interface ComposioPollSpec {
  connectorType: string;
  transport?: 'action' | 'proxy';
  entities: PollEntity[];
}

/** connectorType → spec. Migrations (datadog/apollo/folk) + Phase-2 connectors. */
export const COMPOSIO_POLL_SPECS: Record<string, ComposioPollSpec> = {
  // ── Migrated from bespoke clients (behavior preserved via fields) ──────────
  datadog: {
    connectorType: 'datadog',
    entities: [{
      entityType: 'Alert',
      eventTopics: ['alert.fired'],
      action: 'DATADOG_LIST_EVENTS',
      staticArgs: { sources: 'alert' },
      recordsPath: ['events'],
      idField: 'id',
      idFallbackHash: true, // Datadog events can have null ids — hash instead of dropping.
      since: {
        mode: 'server', field: 'timestamp',
        serverArg: { name: 'start', format: 'unixSec' },
        windowEndArg: { name: 'end', format: 'unixSec' },
      },
      fields: {
        // Raw Datadog events use text/date_happened; Composio's action may remap
        // to message/timestamp — read either (paths, first-defined wins).
        // alertType/env/service are derived from the tags array (key:value) —
        // preserves the bespoke normalizer's tag-parsing exactly (fromTag).
        title: { path: 'title', kind: 'string', describe: 'Alert title (typically the monitor name + transition).' },
        message: { path: 'message', paths: ['message', 'text'], kind: 'string', describe: 'Alert body/message.' },
        timestamp: { path: 'timestamp', paths: ['timestamp', 'date_happened'], kind: 'string', describe: 'Event timestamp — anchor for "alert fired N minutes ago" patterns.' },
        tags: { path: 'tags', kind: 'string[]', describe: 'Datadog tags on the event (e.g. env:prod, service:api, source:alert).' },
        alertType: { path: 'tags', kind: 'string', fromTag: 'alert_type', describe: 'Severity parsed from tags when present (error, warning, success, info).' },
        env: { path: 'tags', kind: 'string', fromTag: 'env', describe: 'Environment from an env: tag, when present.' },
        service: { path: 'tags', kind: 'string', fromTag: 'service', describe: 'Service from a service: tag, when present.' },
      },
    }],
  },
  apollo: {
    connectorType: 'apollo',
    entities: [{
      entityType: 'Contact',
      eventTopics: ['contact.created', 'contact.updated'],
      action: 'APOLLO_SEARCH_CONTACTS',
      recordsPath: ['contacts'],
      idField: 'id',
      since: {
        mode: 'sortDesc', field: 'updated_at',
        sortArg: { byArg: 'sort_by_field', byValue: 'contact_updated_at', dirArg: 'sort_ascending', descValue: false },
      },
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 100, totalPagesPath: ['pagination', 'total_pages'] },
      fields: {
        name: { path: 'name', kind: 'string' },
        firstName: { path: 'first_name', kind: 'string' },
        lastName: { path: 'last_name', kind: 'string' },
        email: { path: 'email', kind: 'string' },
        title: { path: 'title', kind: 'string', describe: 'Job title.' },
        organizationName: { path: 'organization_name', paths: ['organization_name', 'organization.name', 'account.name'], kind: 'string' },
        phone: { path: 'phone_numbers', kind: 'string', pick: 'first', from: 'raw_number' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  folk: {
    connectorType: 'folk',
    entities: [{
      entityType: 'Contact',
      eventTopics: ['contact.created'],
      action: 'FOLK_LIST_PEOPLE',
      recordsPath: ['data', 'items'],
      idField: 'id',
      since: {
        mode: 'server', field: 'createdAt',
        serverArg: { name: 'filter.createdAt.gt', format: 'dateOnly', offsetDays: 1 },
      },
      pagination: { mode: 'cursor', limitArg: 'limit', limit: 100, cursorArg: 'cursor', cursorPath: ['data', 'pagination', 'nextLink'] },
      fields: {
        name: { path: 'fullName', kind: 'string', describe: 'fullName.' },
        firstName: { path: 'firstName', kind: 'string' },
        lastName: { path: 'lastName', kind: 'string' },
        primaryEmail: { path: 'emails', kind: 'string', pick: 'first' },
        emails: { path: 'emails', kind: 'string[]' },
        phone: { path: 'phones', kind: 'string', pick: 'first' },
        jobTitle: { path: 'jobTitle', kind: 'string' },
        companyName: { path: 'companies', kind: 'string', pick: 'first', from: 'name', describe: 'Primary associated company name.' },
        createdAt: { path: 'createdAt', kind: 'string' },
      },
    }],
  },

  // ── Phase 2 — doc-verified new connectors ─────────────────────────────────
  // greenhouse: response is a root JSON array (verified via developers.greenhouse.io);
  // Composio's cursor is the Link-header rel=next which the proxy strips → single
  // page of up to 500 candidates per cycle (documented cap). updated_at_gt server filter.
  greenhouse: {
    connectorType: 'greenhouse',
    entities: [{
      entityType: 'Candidate',
      eventTopics: ['candidate.created', 'candidate.updated'],
      action: 'GREENHOUSE_LIST_CANDIDATES',
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_at_gt', format: 'iso' } },
      pagination: { mode: 'none', limitArg: 'per_page', limit: 500 },
      pollIntervalMs: 300_000, // candidates are low-velocity — poll every 5 min, not 60s
      fields: {
        firstName: { path: 'first_name', kind: 'string' },
        lastName: { path: 'last_name', kind: 'string' },
        email: { path: 'email_addresses', kind: 'string', pick: 'first', from: 'value' },
        company: { path: 'company', kind: 'string' },
        title: { path: 'title', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // pagerduty: GET /incidents → { incidents:[...], more, limit, offset }. Fields
  // verified against the official PagerDuty/go-pagerduty client (incident.go):
  // id/title/description/status/urgency/created_at/updated_at/last_status_change_at
  // + service (APIReference → summary). NOTE: the list `since` param filters by
  // CREATED time (no updated-since filter on this endpoint), so polling is
  // create-oriented; a resolution is only re-delivered while the incident is
  // still within the created-since window (its updated_at bumps the version).
  // eventTopics keep incident.resolved so agents can filter on status; old-
  // incident resolutions are not guaranteed.
  pagerduty: {
    connectorType: 'pagerduty',
    entities: [{
      entityType: 'Incident',
      eventTopics: ['incident.triggered', 'incident.resolved'],
      action: 'PAGERDUTY_FETCH_INCIDENT_LIST',
      recordsPath: ['incidents'],
      idField: 'id',
      since: { mode: 'server', field: 'created_at', serverArg: { name: 'since', format: 'iso' } },
      versionField: 'updated_at', // status changes bump updated_at → re-emitted (recent incidents)
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 100, hasMorePath: ['more'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        description: { path: 'description', kind: 'string' },
        status: { path: 'status', kind: 'string', describe: 'triggered | acknowledged | resolved.' },
        urgency: { path: 'urgency', kind: 'string' },
        serviceName: { path: 'service', kind: 'string', from: 'summary' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // incident_io: LIST_INCIDENTS_V2 → { incidents:[...], pagination_meta:{ after } }.
  // Verified against docs.incident.io/api-reference/incidents-v2/list:
  //  - CURSOR pagination: pass the response's `pagination_meta.after` as the
  //    `after` query arg; it is ABSENT once there are no more pages (the stop
  //    signal). NOT last-row-id/afterId — the cursor is authoritative.
  //  - `updated_at`/`created_at` support gte/lte; Composio flattens the raw
  //    `updated_at[gte]` bracket param to `updated_at_gte` (probed input schema).
  //  - fields id/reference/name/summary/incident_status.name/severity.name/
  //    created_at/updated_at all confirmed.
  incident_io: {
    connectorType: 'incident_io',
    entities: [{
      entityType: 'Incident',
      eventTopics: ['incident.triggered', 'incident.resolved'],
      action: 'INCIDENT_IO_LIST_INCIDENTS_V2',
      recordsPath: ['incidents'],
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_at_gte', format: 'iso' } },
      pagination: { mode: 'cursor', cursorArg: 'after', cursorPath: ['pagination_meta', 'after'], limitArg: 'page_size', limit: 50 },
      fields: {
        name: { path: 'name', kind: 'string' },
        summary: { path: 'summary', kind: 'string' },
        status: { path: 'incident_status', kind: 'string', from: 'name' },
        severity: { path: 'severity', kind: 'string', from: 'name' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },

  // ── Phase 2 batch — remaining composio_managed connectors ─────────────────
  // lever: LEVER_LIST_OPPORTUNITIES → { data:[...], next, hasNext }
  // (hire.lever.co/developer/documentation). Candidates are "opportunities".
  // `offset` is a cursor token (response.next, absent when done); updated_at_start
  // filters by updatedAt (Unix ms). Composio action + params from docs.composio.dev.
  lever: {
    connectorType: 'lever',
    entities: [{
      entityType: 'Candidate',
      eventTopics: ['candidate.created', 'candidate.updated'],
      action: 'LEVER_LIST_OPPORTUNITIES',
      recordsPath: ['data'],
      idField: 'id',
      since: { mode: 'server', field: 'updatedAt', serverArg: { name: 'updated_at_start', format: 'unixMs' } },
      pagination: { mode: 'cursor', cursorArg: 'offset', cursorPath: ['next'], limitArg: 'limit', limit: 100 },
      fields: {
        name: { path: 'name', kind: 'string' },
        headline: { path: 'headline', kind: 'string', describe: 'Company/title headline for the candidate.' },
        stage: { path: 'stage', kind: 'string', describe: 'Current pipeline stage id.' },
        primaryEmail: { path: 'emails', kind: 'string', pick: 'first' },
        emails: { path: 'emails', kind: 'string[]' },
        origin: { path: 'origin', kind: 'string', describe: 'How the candidate entered (sourced, applied, referred, ...).' },
        createdAt: { path: 'createdAt', kind: 'number', describe: 'Unix ms.' },
        updatedAt: { path: 'updatedAt', kind: 'number', describe: 'Unix ms.' },
      },
    }],
  },
  // workable: WORKABLE_GET_CANDIDATES → { candidates:[...], paging:{next} }
  // (workable.readme.io). Composio exposes only `limit` (no cursor input), and the
  // body `paging.next` URL can't be echoed back → single page of ≤100/cycle
  // (documented cap, like greenhouse). updated_after filters by updated_at (ISO).
  workable: {
    connectorType: 'workable',
    entities: [{
      entityType: 'Candidate',
      eventTopics: ['candidate.created', 'candidate.updated'],
      action: 'WORKABLE_GET_CANDIDATES',
      recordsPath: ['candidates'],
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_after', format: 'iso' } },
      pagination: { mode: 'none', limitArg: 'limit', limit: 100 },
      pollIntervalMs: 300_000, // candidates are low-velocity — poll every 5 min
      fields: {
        name: { path: 'name', kind: 'string' },
        firstName: { path: 'firstname', kind: 'string' },
        lastName: { path: 'lastname', kind: 'string' },
        headline: { path: 'headline', kind: 'string' },
        email: { path: 'email', kind: 'string' },
        stage: { path: 'stage', kind: 'string', describe: 'Current pipeline stage.' },
        jobTitle: { path: 'job', kind: 'string', from: 'title', describe: 'Job posting title.' },
        disqualified: { path: 'disqualified', kind: 'string', describe: 'true when the candidate was disqualified.' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // square: SQUARE_LIST_PAYMENTS → { payments:[...], cursor } (docs.composio.dev +
  // developer.squareup.com). cursor pagination (body `cursor`, absent when done);
  // updated_at_begin_time (RFC3339) filters by updated_at. amount_money is
  // { amount (smallest currency unit), currency }.
  square: {
    connectorType: 'square',
    entities: [{
      entityType: 'Payment',
      eventTopics: ['payment.received'],
      action: 'SQUARE_LIST_PAYMENTS',
      recordsPath: ['payments'],
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_at_begin_time', format: 'iso' } },
      pagination: { mode: 'cursor', cursorArg: 'cursor', cursorPath: ['cursor'], limitArg: 'limit', limit: 100 },
      fields: {
        amount: { path: 'amount_money', kind: 'number', from: 'amount', describe: 'Amount in the smallest currency unit (e.g. cents).' },
        currency: { path: 'amount_money', kind: 'string', from: 'currency' },
        status: { path: 'status', kind: 'string', describe: 'APPROVED | COMPLETED | CANCELED | FAILED.' },
        locationId: { path: 'location_id', kind: 'string' },
        orderId: { path: 'order_id', kind: 'string' },
        receiptNumber: { path: 'receipt_number', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // cal_com: CAL_FETCH_ALL_BOOKINGS → { status, data:[...], pagination:{ hasMore } }
  // (cal.com/docs/api-reference/v2/bookings). Composio input is offset (skip/take);
  // there is no updated-since filter, so sort newest-created (sortCreated=desc) and
  // gate client-side on createdAt. versionField=updatedAt so a reschedule of a
  // recently-created booking re-emits.
  cal_com: {
    connectorType: 'cal_com',
    entities: [{
      entityType: 'Event',
      eventTopics: ['meeting.scheduled', 'calendar.event'],
      action: 'CAL_FETCH_ALL_BOOKINGS',
      recordsPath: ['data'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'createdAt', sortArg: { byArg: 'sortCreated', byValue: 'desc' } },
      versionField: 'updatedAt',
      pagination: { mode: 'offset', skipArg: 'skip', limitArg: 'take', limit: 100, hasMorePath: ['pagination', 'hasMore'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        status: { path: 'status', kind: 'string', describe: 'accepted | pending | cancelled | rejected.' },
        startTime: { path: 'start', kind: 'string' },
        endTime: { path: 'end', kind: 'string' },
        attendeeName: { path: 'attendees', kind: 'string', pick: 'first', from: 'name' },
        attendeeEmail: { path: 'attendees', kind: 'string', pick: 'first', from: 'email' },
        eventTypeId: { path: 'eventTypeId', kind: 'number' },
        createdAt: { path: 'createdAt', kind: 'string' },
        updatedAt: { path: 'updatedAt', kind: 'string' },
      },
    }],
  },
  // mailchimp: MAILCHIMP_LIST_CAMPAIGNS → { campaigns:[...], total_items }
  // (mailchimp.com/developer/marketing/api/campaigns). offset pagination
  // (count/offset); since_create_time filters by create_time (ISO). settings.*
  // carries the subject/title/from. (Subscriber events use the separate
  // catalog eventTrigger entry.)
  mailchimp: {
    connectorType: 'mailchimp',
    entities: [{
      entityType: 'Campaign',
      eventTopics: ['campaign.sent'],
      action: 'MAILCHIMP_LIST_CAMPAIGNS',
      recordsPath: ['campaigns'],
      idField: 'id',
      since: { mode: 'server', field: 'create_time', serverArg: { name: 'since_create_time', format: 'iso' } },
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'count', limit: 100 },
      fields: {
        title: { path: 'settings', kind: 'string', from: 'title' },
        subject: { path: 'settings', kind: 'string', from: 'subject_line' },
        fromName: { path: 'settings', kind: 'string', from: 'from_name' },
        type: { path: 'type', kind: 'string', describe: 'regular | plaintext | rss | variate | ...' },
        status: { path: 'status', kind: 'string', describe: 'save | paused | schedule | sending | sent.' },
        emailsSent: { path: 'emails_sent', kind: 'number' },
        createTime: { path: 'create_time', kind: 'string' },
        sendTime: { path: 'send_time', kind: 'string' },
      },
    }],
  },
  // microsoft_dynamics: DYNAMICS365_DYNAMICSCRM_GET_ALL_LEADS → OData { value:[...] }
  // (learn.microsoft.com Dataverse Web API). Only a list-LEADS action exists (no
  // list-contacts — Contact stays listImplemented:false). Offset (top/skip); no
  // $filter template in the framework, so orderby modifiedon desc + client gate.
  // Fields are standard Dataverse lead attributes; id = leadid.
  microsoft_dynamics: {
    connectorType: 'microsoft_dynamics',
    entities: [{
      entityType: 'Lead',
      eventTopics: ['lead.created'],
      action: 'DYNAMICS365_DYNAMICSCRM_GET_ALL_LEADS',
      recordsPath: ['value'],
      idField: 'leadid',
      since: { mode: 'sortDesc', field: 'modifiedon', sortArg: { byArg: 'orderby', byValue: 'modifiedon desc' } },
      pagination: { mode: 'offset', skipArg: 'skip', limitArg: 'top', limit: 100 },
      fields: {
        subject: { path: 'subject', kind: 'string', describe: 'Lead topic/subject.' },
        fullName: { path: 'fullname', kind: 'string' },
        firstName: { path: 'firstname', kind: 'string' },
        lastName: { path: 'lastname', kind: 'string' },
        email: { path: 'emailaddress1', kind: 'string' },
        companyName: { path: 'companyname', kind: 'string' },
        jobTitle: { path: 'jobtitle', kind: 'string' },
        createdon: { path: 'createdon', kind: 'string' },
        modifiedon: { path: 'modifiedon', kind: 'string' },
      },
    }],
  },
  // canva: CANVA_LIST_USER_DESIGNS → { items:[...], continuation } (canva.dev/docs
  // connect API). Global (no parent folder). No updated-since filter, so
  // sort_by=modified_descending + client gate on updated_at. continuation cursor
  // (no limit param). created_at/updated_at are Unix seconds.
  canva: {
    connectorType: 'canva',
    entities: [{
      entityType: 'Design',
      eventTopics: ['design.created', 'design.updated'],
      action: 'CANVA_LIST_USER_DESIGNS',
      recordsPath: ['items'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'updated_at', sortArg: { byArg: 'sort_by', byValue: 'modified_descending' } },
      pagination: { mode: 'cursor', cursorArg: 'continuation', cursorPath: ['continuation'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        viewUrl: { path: 'urls', kind: 'string', from: 'view_url' },
        editUrl: { path: 'urls', kind: 'string', from: 'edit_url' },
        pageCount: { path: 'page_count', kind: 'number' },
        createdAt: { path: 'created_at', kind: 'number', describe: 'Unix seconds.' },
        updatedAt: { path: 'updated_at', kind: 'number', describe: 'Unix seconds.' },
      },
    }],
  },
  // instagram: INSTAGRAM_GET_IG_USER_MEDIA with ig_user_id='me' → { data:[...],
  // paging:{ cursors:{ after } } } (Instagram Graph API). Global via the "me"
  // alias for the connected account. `since` (Unix sec) filters by media
  // timestamp; after-cursor pagination.
  instagram: {
    connectorType: 'instagram',
    entities: [{
      entityType: 'Media',
      eventTopics: ['post.created'],
      action: 'INSTAGRAM_GET_IG_USER_MEDIA',
      staticArgs: { ig_user_id: 'me' },
      recordsPath: ['data'],
      idField: 'id',
      since: { mode: 'server', field: 'timestamp', serverArg: { name: 'since', format: 'unixSec' } },
      pagination: { mode: 'cursor', cursorArg: 'after', cursorPath: ['paging', 'cursors', 'after'], limitArg: 'limit', limit: 100 },
      fields: {
        caption: { path: 'caption', kind: 'string' },
        mediaType: { path: 'media_type', kind: 'string', describe: 'IMAGE | VIDEO | CAROUSEL_ALBUM.' },
        permalink: { path: 'permalink', kind: 'string' },
        mediaUrl: { path: 'media_url', kind: 'string' },
        username: { path: 'username', kind: 'string' },
        likeCount: { path: 'like_count', kind: 'number' },
        commentsCount: { path: 'comments_count', kind: 'number' },
        timestamp: { path: 'timestamp', kind: 'string', describe: 'Media creation time (ISO 8601).' },
      },
    }],
  },

  // ── Phase 3 batch — scale-safe poll connectors ────────────────────────────
  // Every entry below is doc-verified (live Composio input schema for the action
  // + arg names; vendor API reference / official client SDK for the response
  // shape) AND scale-safe: each uses either a server-side `since` filter or a
  // newest-first `sortDesc` early-stop, so the stateless scheduler (wall-clock
  // `since` watermark, no durable cursor) never full-scans from the oldest
  // record. Connectors that would need a durable forward-cursor / CDC action /
  // syncToken to be scale-safe (quickbooks, lemon_squeezy, ashby, instantly,
  // mailerlite, mailersend, lemlist, clicksend) are deliberately NOT flipped —
  // see the catalog notes; a naive full-scan would silently drop new records for
  // large accounts.

  // shopify: SHOPIFY_LIST_ORDERS → { orders:[...] } (shopify.dev admin-rest/order).
  // updated_at_min (ISO) server filter + since_id afterId paging (limit ≤ 250).
  shopify: {
    connectorType: 'shopify',
    entities: [{
      entityType: 'Order',
      eventTopics: ['order.created', 'order.updated'],
      action: 'SHOPIFY_LIST_ORDERS',
      recordsPath: ['orders'],
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_at_min', format: 'iso' } },
      pagination: { mode: 'afterId', afterArg: 'since_id', limitArg: 'limit', limit: 250 },
      fields: {
        name: { path: 'name', kind: 'string', describe: 'Order name, e.g. #1001.' },
        email: { path: 'email', kind: 'string' },
        totalPrice: { path: 'total_price', kind: 'string', describe: 'Order total (decimal string).' },
        currency: { path: 'currency', kind: 'string' },
        financialStatus: { path: 'financial_status', kind: 'string', describe: 'pending | paid | refunded | ...' },
        fulfillmentStatus: { path: 'fulfillment_status', kind: 'string', describe: 'fulfilled | partial | null.' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // gumroad: GUMROAD_GET_SALES → { sales:[...], next_page_url } (verified vs the
  // antiwork/gumroad OSS Purchase#as_json v2). `after` filters by sale DAY
  // (YYYY-MM-DD, day granularity); page paging via next_page_url presence.
  gumroad: {
    connectorType: 'gumroad',
    entities: [{
      entityType: 'Sale',
      eventTopics: ['sale.created'],
      action: 'GUMROAD_GET_SALES',
      recordsPath: ['sales'],
      idField: 'id',
      since: { mode: 'server', field: 'created_at', serverArg: { name: 'after', format: 'dateOnly' } },
      pagination: { mode: 'page', pageArg: 'page', hasMorePath: ['next_page_url'] },
      fields: {
        email: { path: 'email', kind: 'string', describe: 'Buyer email.' },
        fullName: { path: 'full_name', kind: 'string' },
        productName: { path: 'product_name', kind: 'string' },
        productId: { path: 'product_id', kind: 'string' },
        price: { path: 'price', kind: 'number', describe: 'Sale amount in cents.' },
        gumroadFee: { path: 'gumroad_fee', kind: 'number', describe: 'Gumroad fee in cents.' },
        currencySymbol: { path: 'currency_symbol', kind: 'string' },
        quantity: { path: 'quantity', kind: 'number' },
        refunded: { path: 'refunded', kind: 'string', describe: 'Refund flag.' },
        createdAt: { path: 'created_at', kind: 'string' },
      },
    }],
  },
  // freshdesk: FRESHDESK_GET_TICKETS → BARE ARRAY (developers.freshdesk.com).
  // created_since (ISO) server filter (this action exposes created_since, not
  // updated_since) → create-oriented; versionField=updated_at re-emits recent
  // tickets on status/field change.
  freshdesk: {
    connectorType: 'freshdesk',
    entities: [{
      entityType: 'Ticket',
      eventTopics: ['ticket.created', 'ticket.updated'],
      action: 'FRESHDESK_GET_TICKETS',
      idField: 'id',
      // Watermarked on UPDATE, not creation. `created_since` (the only time
      // filter Composio's action exposes) answers "created after X", so a ticket
      // created last week and replied to a minute ago was never returned, and
      // `ticket.updated` could not fire. Freshdesk documents order_by over
      // created_at | due_by | updated_at | status — Composio surfaces it as the
      // free-form `sort_by` / `sort_order` pair — so sortDesc on updated_at
      // returns most-recently-touched first and the generic client stops paging
      // once a page predates `since`.
      //
      // Bounded by Freshdesk's own rule that the list returns tickets created in
      // the last 30 days unless `updated_since` is passed, which this action does
      // not expose. Fine for a per-minute poll; a ticket older than 30 days that
      // is updated will still be missed.
      since: {
        mode: 'sortDesc', field: 'updated_at',
        sortArg: { byArg: 'sort_by', byValue: 'updated_at', dirArg: 'sort_order', descValue: 'desc' },
      },
      versionField: 'updated_at',
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 100 },
      fields: {
        subject: { path: 'subject', kind: 'string' },
        status: { path: 'status', kind: 'number', describe: '2=open 3=pending 4=resolved 5=closed.' },
        priority: { path: 'priority', kind: 'number', describe: '1=low .. 4=urgent.' },
        requesterId: { path: 'requester_id', kind: 'number' },
        responderId: { path: 'responder_id', kind: 'number', describe: 'Assigned agent.' },
        groupId: { path: 'group_id', kind: 'number' },
        type: { path: 'type', kind: 'string' },
        source: { path: 'source', kind: 'number', describe: 'Channel source code.' },
        tags: { path: 'tags', kind: 'string[]' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // brevo: BREVO_GET_ALL_CONTACTS → { contacts:[...], count } (developers.brevo.com).
  // modifiedSince (ISO) = clean server-side updated-incrementality; offset paging.
  brevo: {
    connectorType: 'brevo',
    entities: [{
      entityType: 'Contact',
      eventTopics: ['contact.created', 'contact.updated'],
      action: 'BREVO_GET_ALL_CONTACTS',
      recordsPath: ['contacts'],
      idField: 'id',
      since: { mode: 'server', field: 'modifiedAt', serverArg: { name: 'modifiedSince', format: 'iso' } },
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 1000 },
      fields: {
        email: { path: 'email', kind: 'string' },
        listIds: { path: 'listIds', kind: 'string[]', describe: 'Ids of lists the contact belongs to.' },
        createdAt: { path: 'createdAt', kind: 'string' },
        modifiedAt: { path: 'modifiedAt', kind: 'string' },
      },
    }],
  },
  // harvest: HARVEST_LIST_TIME_ENTRIES → { time_entries:[...], next_page }
  // (help.getharvest.com api-v2). updated_since (ISO) server filter; page paging
  // via next_page presence; nested project/client/user/task {name}.
  harvest: {
    connectorType: 'harvest',
    entities: [{
      entityType: 'TimeEntry',
      eventTopics: ['timeentry.created', 'timeentry.updated'],
      action: 'HARVEST_LIST_TIME_ENTRIES',
      recordsPath: ['time_entries'],
      idField: 'id',
      since: { mode: 'server', field: 'updated_at', serverArg: { name: 'updated_since', format: 'iso' } },
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 100, hasMorePath: ['next_page'] },
      fields: {
        spentDate: { path: 'spent_date', kind: 'string', describe: 'Date logged (YYYY-MM-DD).' },
        hours: { path: 'hours', kind: 'number' },
        notes: { path: 'notes', kind: 'string' },
        projectName: { path: 'project.name', kind: 'string' },
        clientName: { path: 'client.name', kind: 'string' },
        userName: { path: 'user.name', kind: 'string' },
        taskName: { path: 'task.name', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // toggl: TOGGL_GET_TIME_ENTRIES (/me/time_entries) → BARE ARRAY
  // (engineering.toggl.com v9). since (unix seconds) filters by `at` (last-update)
  // and also returns deleted entries (server_deleted_at set). No pagination args.
  toggl: {
    connectorType: 'toggl',
    entities: [{
      entityType: 'TimeEntry',
      eventTopics: ['timeentry.created', 'timeentry.updated'],
      action: 'TOGGL_GET_TIME_ENTRIES',
      idField: 'id',
      since: { mode: 'server', field: 'at', serverArg: { name: 'since', format: 'unixSec' } },
      pagination: { mode: 'none' },
      fields: {
        workspaceId: { path: 'workspace_id', kind: 'number' },
        projectId: { path: 'project_id', kind: 'number' },
        description: { path: 'description', kind: 'string' },
        start: { path: 'start', kind: 'string', describe: 'Start (RFC3339).' },
        stop: { path: 'stop', kind: 'string', describe: 'Stop (RFC3339, null while running).' },
        duration: { path: 'duration', kind: 'number', describe: 'Seconds; negative while running.' },
        at: { path: 'at', kind: 'string', describe: 'Last-updated (RFC3339).' },
        tags: { path: 'tags', kind: 'string[]' },
      },
    }],
  },
  // fathom: FATHOM_LIST_MEETINGS → { items:[...], next_cursor }
  // (developers.fathom.ai). created_after (ISO) server filter; recordings are
  // immutable → meeting.created only. No request-side limit on this action.
  fathom: {
    connectorType: 'fathom',
    entities: [{
      entityType: 'Meeting',
      eventTopics: ['meeting.created'],
      action: 'FATHOM_LIST_MEETINGS',
      recordsPath: ['items'],
      idField: 'recording_id',
      since: { mode: 'server', field: 'created_at', serverArg: { name: 'created_after', format: 'iso' } },
      pagination: { mode: 'cursor', cursorArg: 'cursor', cursorPath: ['next_cursor'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        url: { path: 'url', kind: 'string', describe: 'Recording URL.' },
        shareUrl: { path: 'share_url', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'string' },
        recordingStartTime: { path: 'recording_start_time', kind: 'string' },
        recordingEndTime: { path: 'recording_end_time', kind: 'string' },
        hostEmail: { path: 'recorded_by.email', kind: 'string' },
      },
    }],
  },
  // google_meet: GOOGLEMEET_LIST_CONFERENCE_RECORDS → { conferenceRecords:[...],
  // nextPageToken } (developers.google.com/workspace/meet v2). `filter` is an
  // EXPRESSION, not a bare timestamp → serverArg.template embeds it as
  // start_time>="<iso>". idField is the resource `name` (conferenceRecords/{id}).
  google_meet: {
    connectorType: 'google_meet',
    entities: [{
      entityType: 'ConferenceRecord',
      eventTopics: ['meeting.ended'],
      action: 'GOOGLEMEET_LIST_CONFERENCE_RECORDS',
      recordsPath: ['conferenceRecords'],
      idField: 'name',
      since: { mode: 'server', field: 'startTime', serverArg: { name: 'filter', format: 'iso', template: 'start_time>="{value}"' } },
      pagination: { mode: 'cursor', cursorArg: 'page_token', cursorPath: ['nextPageToken'], limitArg: 'page_size', limit: 100 },
      fields: {
        startTime: { path: 'startTime', kind: 'string', describe: 'Conference start (RFC3339).' },
        endTime: { path: 'endTime', kind: 'string', describe: 'End (RFC3339; absent while in progress).' },
        expireTime: { path: 'expireTime', kind: 'string', describe: 'Auto-delete time (RFC3339).' },
        space: { path: 'space', kind: 'string', describe: 'spaces/{id} meeting-space ref.' },
      },
    }],
  },
  // dialpad: DIALPAD_RETRIEVE_CALL_INFORMATION → { items:[...], cursor }
  // (developers.dialpad.com/reference/calllist). target_id/target_type optional →
  // account-wide. started_after = UTC ms-since-epoch; concluded calls only.
  dialpad: {
    connectorType: 'dialpad',
    entities: [{
      entityType: 'Call',
      eventTopics: ['call.completed'],
      action: 'DIALPAD_RETRIEVE_CALL_INFORMATION',
      recordsPath: ['items'],
      idField: 'call_id',
      since: { mode: 'server', field: 'date_started', serverArg: { name: 'started_after', format: 'unixMs' } },
      pagination: { mode: 'cursor', cursorArg: 'cursor', cursorPath: ['cursor'] },
      fields: {
        dateStarted: { path: 'date_started', kind: 'number', describe: 'Call start (unix ms).' },
        dateEnded: { path: 'date_ended', kind: 'number', describe: 'Call end (unix ms).' },
        duration: { path: 'duration', kind: 'number', describe: 'Duration (ms).' },
        direction: { path: 'direction', kind: 'string', describe: 'inbound | outbound.' },
        externalNumber: { path: 'external_number', kind: 'string', describe: 'External party (E.164).' },
        internalNumber: { path: 'internal_number', kind: 'string', describe: 'Dialpad-side number.' },
      },
    }],
  },
  // jotform: JOTFORM_GET_USER_SUBMISSIONS → { content:[...] } (account-level, all
  // forms; api.jotform.com/docs). `filter` is a JSON expression; created_at:gt
  // uses 'YYYY-MM-DD HH:MM:SS' in the account's LOCAL tz — widen by a day
  // (offsetDays) to avoid missing boundary submissions, and DON'T client-gate
  // (no `field`) so the tz-skewed filter isn't double-applied; dedup absorbs the
  // overlap. `answers` (nested object) omitted.
  jotform: {
    connectorType: 'jotform',
    entities: [{
      entityType: 'Submission',
      eventTopics: ['submission.created'],
      action: 'JOTFORM_GET_USER_SUBMISSIONS',
      recordsPath: ['content'],
      idField: 'id',
      since: { mode: 'server', serverArg: { name: 'filter', format: 'spaceDateTime', offsetDays: 1, template: '{"created_at:gt":"{value}"}' } },
      versionField: 'updated_at',
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 1000 },
      fields: {
        formId: { path: 'form_id', kind: 'string', describe: 'Parent form id.' },
        status: { path: 'status', kind: 'string', describe: 'e.g. ACTIVE.' },
        createdAt: { path: 'created_at', kind: 'string', describe: "'YYYY-MM-DD HH:MM:SS' (account tz)." },
        updatedAt: { path: 'updated_at', kind: 'string', describe: 'null if never edited.' },
      },
    }],
  },
  // follow_up_boss: FOLLOW_UP_BOSS_LIST_DEALS → { _metadata, deals:[...] }
  // (docs.followupboss.com). No people-list action is exposed → Deals is the
  // account-level stream. No server since; sort=-updated (desc) + sortDesc
  // early-stop on `updated`. offset/limit paging.
  follow_up_boss: {
    connectorType: 'follow_up_boss',
    entities: [{
      entityType: 'Deal',
      eventTopics: ['deal.created', 'deal.updated'],
      action: 'FOLLOW_UP_BOSS_LIST_DEALS',
      recordsPath: ['deals'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'updated', sortArg: { byArg: 'sort', byValue: '-updated' } },
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 100 },
      fields: {
        name: { path: 'name', kind: 'string' },
        stageId: { path: 'stageId', kind: 'number' },
        pipelineId: { path: 'pipelineId', kind: 'number' },
        price: { path: 'price', kind: 'number' },
        status: { path: 'status', kind: 'string', describe: 'Active | Won | Lost | ...' },
        description: { path: 'description', kind: 'string' },
        commissionValue: { path: 'commissionValue', kind: 'number' },
        projectedCloseDate: { path: 'projectedCloseDate', kind: 'string' },
        created: { path: 'created', kind: 'string' },
        updated: { path: 'updated', kind: 'string' },
      },
    }],
  },
  // dovetail: DOVETAIL_LIST_NOTES → { data:[...], page:{ next_cursor, has_more } }
  // (developers.dovetail.com). The list exposes only created_at (no updated_at) →
  // sort=created_at:desc + sortDesc early-stop (catches NEW notes; edits not in
  // list metadata). Cursor paging via page.next_cursor.
  dovetail: {
    connectorType: 'dovetail',
    entities: [{
      entityType: 'Note',
      eventTopics: ['note.created'],
      action: 'DOVETAIL_LIST_NOTES',
      recordsPath: ['data'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'created_at', sortArg: { byArg: 'sort', byValue: 'created_at:desc' } },
      pagination: { mode: 'cursor', cursorArg: 'start_cursor', cursorPath: ['page', 'next_cursor'], limitArg: 'limit', limit: 100, hasMorePath: ['page', 'has_more'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'string' },
        projectId: { path: 'project_id', kind: 'string' },
        folderId: { path: 'folder_id', kind: 'string' },
      },
    }],
  },
  // bitbucket: BITBUCKET_LIST_REPOSITORIES → { values:[...], next } (Atlassian
  // Cloud REST). role=member lists repos across ALL the account's workspaces (no
  // workspace param on this action). sort=-updated_on (desc) + sortDesc early-stop.
  bitbucket: {
    connectorType: 'bitbucket',
    entities: [{
      entityType: 'Repository',
      eventTopics: ['repository.created', 'repository.updated'],
      action: 'BITBUCKET_LIST_REPOSITORIES',
      staticArgs: { role: 'member' },
      recordsPath: ['values'],
      idField: 'uuid',
      since: { mode: 'sortDesc', field: 'updated_on', sortArg: { byArg: 'sort', byValue: '-updated_on' } },
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'pagelen', limit: 100, hasMorePath: ['next'] },
      pollIntervalMs: 300_000, // repositories are low-velocity — poll every 5 min
      fields: {
        fullName: { path: 'full_name', kind: 'string', describe: 'workspace/repo-slug.' },
        name: { path: 'name', kind: 'string' },
        createdOn: { path: 'created_on', kind: 'string' },
        updatedOn: { path: 'updated_on', kind: 'string' },
      },
    }],
  },
  // mem: MEM_LIST_NOTES → { results:[...], next_page } (docs.mem.ai v2). order_by
  // defaults to updated_at (newest-updated-first) → sortDesc early-stop on
  // updated_at; cursor paging (pass next_page back as `page`). `content` only
  // present with include_note_content=true (not requested).
  mem: {
    connectorType: 'mem',
    entities: [{
      entityType: 'Note',
      eventTopics: ['note.created', 'note.updated'],
      action: 'MEM_LIST_NOTES',
      staticArgs: { order_by: 'updated_at' },
      recordsPath: ['results'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'updated_at' },
      pagination: { mode: 'cursor', cursorArg: 'page', cursorPath: ['next_page'], limitArg: 'limit', limit: 100, hasMorePath: ['next_page'] },
      fields: {
        title: { path: 'title', kind: 'string' },
        snippet: { path: 'snippet', kind: 'string' },
        collectionIds: { path: 'collection_ids', kind: 'string[]' },
        createdAt: { path: 'created_at', kind: 'string' },
        updatedAt: { path: 'updated_at', kind: 'string' },
      },
    }],
  },
  // missive: MISSIVE_LIST_CONVERSATIONS → { conversations:[...] } (missiveapp.com).
  // A mailbox filter is REQUIRED → poll the shared inbox. Ordered newest-first by
  // last_activity_at, no server since and no body cursor usable generically →
  // single page of the newest `limit` per cycle, gated on last_activity_at
  // (a burst > limit between polls can lag a cycle). authors/assignees (object
  // arrays) omitted.
  missive: {
    connectorType: 'missive',
    entities: [{
      entityType: 'Conversation',
      eventTopics: ['conversation.created', 'conversation.updated'],
      action: 'MISSIVE_LIST_CONVERSATIONS',
      staticArgs: { inbox: true },
      recordsPath: ['conversations'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'last_activity_at' },
      pagination: { mode: 'none', limitArg: 'limit', limit: 50 },
      fields: {
        subject: { path: 'subject', kind: 'string' },
        createdAt: { path: 'created_at', kind: 'number', describe: 'Unix epoch seconds.' },
        lastActivityAt: { path: 'last_activity_at', kind: 'number', describe: 'Unix epoch seconds.' },
        messagesCount: { path: 'messages_count', kind: 'number' },
      },
    }],
  },
  // elevenlabs: ELEVENLABS_GET_GENERATED_ITEMS (/v1/history) → { history:[...],
  // has_more } (elevenlabs.io/docs). Inherently newest-first → sortDesc early-stop
  // on date_unix; page back via start_after_history_item_id until has_more=false.
  elevenlabs: {
    connectorType: 'elevenlabs',
    entities: [{
      entityType: 'HistoryItem',
      eventTopics: ['historyItem.created'],
      action: 'ELEVENLABS_GET_GENERATED_ITEMS',
      recordsPath: ['history'],
      idField: 'history_item_id',
      since: { mode: 'sortDesc', field: 'date_unix' },
      pagination: { mode: 'afterId', afterArg: 'start_after_history_item_id', limitArg: 'page_size', limit: 100, hasMorePath: ['has_more'] },
      fields: {
        text: { path: 'text', kind: 'string', describe: 'Input text.' },
        voiceId: { path: 'voice_id', kind: 'string' },
        voiceName: { path: 'voice_name', kind: 'string' },
        dateUnix: { path: 'date_unix', kind: 'number', describe: 'Creation (unix seconds).' },
        contentType: { path: 'content_type', kind: 'string' },
        state: { path: 'state', kind: 'string' },
        source: { path: 'source', kind: 'string', describe: 'TTS | STS | Projects | Dubbing | ConvAI | ...' },
      },
    }],
  },

  // ── Phase 4 batch — proper mechanisms for the previously-deferred connectors ──
  // Each of these lacked a server `since` + newest-first sort, so the first batch
  // deferred them. The proper fix per connector: a CDC action (quickbooks), a
  // confirmed newest-first default (lemon_squeezy), a sortable sibling entity
  // (lemlist Companies), or the durableCursor mechanism (instantly/ashby) that
  // persists a resume token across cycles. (mailerlite/mailersend/clicksend have
  // NO incremental mechanism in the exposed Composio surface — see catalog notes.)

  // quickbooks: QUICKBOOKS_GET_CHANGED_ENTITIES (Change Data Capture) →
  // { CDCResponse: [ { QueryResponse: [ { Invoice: [...] } ] } ] } (developer.intuit.com
  // CDC + intuit/QuickBooks-V3-PHP-SDK). `changedSince` (ISO 8601) IS the server since;
  // requesting only entities:['Invoice'] puts invoices at QueryResponse[0] (empty {} when
  // no changes). CDC returns full payloads + deleted markers (status="Deleted"); realm is
  // auto-injected. 30-day window + ≤1000/response → no pagination (the window is one poll).
  quickbooks: {
    connectorType: 'quickbooks',
    entities: [{
      entityType: 'Invoice',
      eventTopics: ['invoice.created', 'invoice.updated'],
      action: 'QUICKBOOKS_GET_CHANGED_ENTITIES',
      staticArgs: { entities: ['Invoice'] },
      recordsPath: ['CDCResponse', '0', 'QueryResponse', '0', 'Invoice'],
      idField: 'Id',
      since: { mode: 'server', field: 'MetaData.LastUpdatedTime', serverArg: { name: 'changedSince', format: 'iso' } },
      pagination: { mode: 'none' },
      fields: {
        docNumber: { path: 'DocNumber', kind: 'string', describe: 'Invoice reference number.' },
        txnDate: { path: 'TxnDate', kind: 'string', describe: 'Transaction date (YYYY-MM-DD).' },
        dueDate: { path: 'DueDate', kind: 'string' },
        totalAmt: { path: 'TotalAmt', kind: 'number', describe: 'Invoice total.' },
        balance: { path: 'Balance', kind: 'number', describe: 'Outstanding balance.' },
        customerId: { path: 'CustomerRef.value', kind: 'string' },
        customerName: { path: 'CustomerRef.name', kind: 'string' },
        currency: { path: 'CurrencyRef.value', kind: 'string' },
        status: { path: 'status', kind: 'string', describe: 'CDC marker: "Deleted" for removed invoices (else absent).' },
        createTime: { path: 'MetaData.CreateTime', kind: 'string' },
        lastUpdatedTime: { path: 'MetaData.LastUpdatedTime', kind: 'string' },
      },
    }],
  },
  // lemon_squeezy: LEMON_SQUEEZY_LIST_ALL_ORDERS → { data:[...], links:{next} } (JSON:API).
  // Default order is newest-first (sort=-createdAt per docs.lemonsqueezy.com) → no server
  // since needed: sortDesc early-stop on attributes.created_at. Record id is top-level
  // data[].id; business fields nest under attributes.
  lemon_squeezy: {
    connectorType: 'lemon_squeezy',
    entities: [{
      entityType: 'Order',
      eventTopics: ['order.created'],
      action: 'LEMON_SQUEEZY_LIST_ALL_ORDERS',
      recordsPath: ['data'],
      idField: 'id',
      since: { mode: 'sortDesc', field: 'attributes.created_at' },
      pagination: { mode: 'page', pageArg: 'page_number', limitArg: 'page_size', limit: 100, hasMorePath: ['links', 'next'] },
      fields: {
        identifier: { path: 'attributes.identifier', kind: 'string', describe: 'Unique order UUID.' },
        orderNumber: { path: 'attributes.order_number', kind: 'number' },
        userEmail: { path: 'attributes.user_email', kind: 'string' },
        userName: { path: 'attributes.user_name', kind: 'string' },
        currency: { path: 'attributes.currency', kind: 'string' },
        total: { path: 'attributes.total', kind: 'number', describe: 'Total in cents.' },
        status: { path: 'attributes.status', kind: 'string', describe: 'pending | failed | paid | refunded.' },
        createdAt: { path: 'attributes.created_at', kind: 'string' },
        updatedAt: { path: 'attributes.updated_at', kind: 'string' },
      },
    }],
  },
  // lemlist: LEMLIST_LIST_COMPANIES → { data:[...], total, limit, offset } (developer.lemlist.com).
  // The activities feed exposes no sort; Companies does (sortBy=createdAt + sortOrder=desc)
  // → sortDesc early-stop on createdAt. id is _id; list has no updatedAt (create-oriented).
  lemlist: {
    connectorType: 'lemlist',
    entities: [{
      entityType: 'Company',
      eventTopics: ['company.created'],
      action: 'LEMLIST_LIST_COMPANIES',
      recordsPath: ['data'],
      idField: '_id',
      since: { mode: 'sortDesc', field: 'createdAt', sortArg: { byArg: 'sortBy', byValue: 'createdAt', dirArg: 'sortOrder', descValue: 'desc' } },
      pagination: { mode: 'offset', skipArg: 'offset', limitArg: 'limit', limit: 100 },
      fields: {
        name: { path: 'name', kind: 'string' },
        createdAt: { path: 'createdAt', kind: 'string' },
      },
    }],
  },
  // instantly: INSTANTLY_LIST_LEADS → { items:[...], next_starting_after }
  // (developer.instantly.ai). Leads are ordered by id ASC (oldest-first), no server since,
  // no sort → durableCursor: persist starting_after and walk FORWARD (first cycles backfill
  // via MAX_PAGES resume, then steady-state new leads). Captures lead.created — a forward
  // id-cursor does not revisit updates to already-passed leads.
  instantly: {
    connectorType: 'instantly',
    entities: [{
      entityType: 'Lead',
      eventTopics: ['lead.created'],
      action: 'INSTANTLY_LIST_LEADS',
      recordsPath: ['items'],
      idField: 'id',
      since: { mode: 'durableCursor' }, // no separate token → starting_after cursor IS the durable resume
      pagination: { mode: 'cursor', cursorArg: 'starting_after', cursorPath: ['next_starting_after'], limitArg: 'limit', limit: 100 },
      fields: {
        email: { path: 'email', kind: 'string' },
        firstName: { path: 'first_name', kind: 'string' },
        lastName: { path: 'last_name', kind: 'string' },
        companyName: { path: 'company_name', kind: 'string' },
        status: { path: 'status', kind: 'number', describe: 'Numeric lead status (1,2,3,-1,-2,-3).' },
        campaign: { path: 'campaign', kind: 'string', describe: 'Campaign UUID.' },
        createdAt: { path: 'timestamp_created', kind: 'string' },
        updatedAt: { path: 'timestamp_updated', kind: 'string' },
      },
    }],
  },
  // ashby: ASHBY_LIST_CANDIDATES (POST) → { success, results:[...], moreDataAvailable,
  // nextCursor, syncToken } (developers.ashbyhq.com pagination-and-incremental-sync).
  // durableCursor via syncToken (creates AND updates): first sync pages the full list via
  // cursor and gets a syncToken on the final page; later cycles pass syncToken for the
  // delta (+ a new syncToken). Huge first syncs backfill across cycles via cursor-resume.
  ashby: {
    connectorType: 'ashby',
    entities: [{
      entityType: 'Candidate',
      eventTopics: ['candidate.created', 'candidate.updated'],
      action: 'ASHBY_LIST_CANDIDATES',
      recordsPath: ['results'],
      idField: 'id',
      since: { mode: 'durableCursor', durable: { tokenArg: 'syncToken', tokenPath: ['syncToken'] } },
      pagination: { mode: 'cursor', cursorArg: 'cursor', cursorPath: ['nextCursor'], limitArg: 'perPage', limit: 100 },
      fields: {
        name: { path: 'name', kind: 'string' },
        primaryEmail: { path: 'primaryEmailAddress.value', kind: 'string' },
        position: { path: 'position', kind: 'string' },
        company: { path: 'company', kind: 'string' },
        school: { path: 'school', kind: 'string' },
        applicationIds: { path: 'applicationIds', kind: 'string[]' },
        profileUrl: { path: 'profileUrl', kind: 'string' },
        createdAt: { path: 'createdAt', kind: 'string' },
        updatedAt: { path: 'updatedAt', kind: 'string' },
      },
    }],
  },
  // zoho (Zoho CRM): ZOHO_GET_ZOHO_RECORDS → { data:[...], info:{ page, per_page,
  // count, more_records } } (zoho.com/crm/developer/docs/api/v8/get-records.html).
  //
  // The action is module-parameterized, so module_api_name is pinned via
  // staticArgs. That is safe here in a way it is not for bitbucket (repo) or
  // figma (project_id): 'Leads' is a stock module present in every Zoho CRM org,
  // not a per-customer resource the poller would have to discover.
  //
  // No updated-since filter — v8 offers only an `If-Modified-Since` HEADER and
  // Composio's action exposes no headers — so sort Modified_Time desc and gate
  // client-side. `fields` is mandatory on v8 and Composio's default for it
  // (First_Name,Last_Name,Email,Phone,Company) carries NO timestamp, which would
  // leave the sortDesc gate with nothing to read and make every cycle re-emit the
  // whole first page. It is therefore set explicitly, and to the documented
  // response fields only: a field API name that does not exist fails the whole
  // request, not just that column.
  zoho: {
    connectorType: 'zoho',
    entities: [{
      entityType: 'Lead',
      eventTopics: ['lead.created'],
      action: 'ZOHO_GET_ZOHO_RECORDS',
      staticArgs: {
        module_api_name: 'Leads',
        fields: 'First_Name,Last_Name,Email,Phone,Company,Created_Time,Modified_Time',
      },
      recordsPath: ['data'],
      idField: 'id',
      since: {
        mode: 'sortDesc', field: 'Modified_Time',
        sortArg: { byArg: 'sort_by', byValue: 'Modified_Time', dirArg: 'sort_order', descValue: 'desc' },
      },
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 200, hasMorePath: ['info', 'more_records'] },
      fields: {
        firstName: { path: 'First_Name', kind: 'string' },
        lastName: { path: 'Last_Name', kind: 'string' },
        email: { path: 'Email', kind: 'string' },
        phone: { path: 'Phone', kind: 'string' },
        company: { path: 'Company', kind: 'string', describe: 'Company the lead belongs to.' },
        createdAt: { path: 'Created_Time', kind: 'string' },
        updatedAt: { path: 'Modified_Time', kind: 'string' },
      },
    }],
  },
  // zoho_bigin: ZOHO_BIGIN_GET_RECORDS → { data:[...], info:{ page, per_page,
  // count, more_records } } (bigin.com/developer/docs/apis/v2/get-records.html).
  // Same shape and same sortDesc reasoning as zoho above, with two differences:
  // `fields` is REQUIRED by the action itself (not just by Zoho), and neither
  // sort_by nor sort_order carries a default, so both are supplied explicitly.
  // module_api_name is a closed enum on this action and 'Contacts' is in it.
  // Account_Name is a lookup object, so the display value is read from its
  // nested `.name` rather than the field itself.
  zoho_bigin: {
    connectorType: 'zoho_bigin',
    entities: [{
      entityType: 'Contact',
      eventTopics: ['contact.created', 'contact.updated'],
      action: 'ZOHO_BIGIN_GET_RECORDS',
      staticArgs: {
        module_api_name: 'Contacts',
        fields: 'First_Name,Last_Name,Email,Phone,Mobile,Account_Name,Title,Created_Time,Modified_Time',
      },
      recordsPath: ['data'],
      idField: 'id',
      since: {
        mode: 'sortDesc', field: 'Modified_Time',
        sortArg: { byArg: 'sort_by', byValue: 'Modified_Time', dirArg: 'sort_order', descValue: 'desc' },
      },
      pagination: { mode: 'page', pageArg: 'page', limitArg: 'per_page', limit: 200, hasMorePath: ['info', 'more_records'] },
      fields: {
        firstName: { path: 'First_Name', kind: 'string' },
        lastName: { path: 'Last_Name', kind: 'string' },
        email: { path: 'Email', kind: 'string' },
        phone: { path: 'Phone', kind: 'string' },
        mobile: { path: 'Mobile', kind: 'string' },
        companyName: { path: 'Account_Name.name', kind: 'string', describe: 'Company the contact belongs to (Bigin Account lookup).' },
        title: { path: 'Title', kind: 'string', describe: 'Job title.' },
        createdAt: { path: 'Created_Time', kind: 'string' },
        updatedAt: { path: 'Modified_Time', kind: 'string' },
      },
    }],
  },
};

export function getPollSpec(connectorType: string): ComposioPollSpec | undefined {
  return COMPOSIO_POLL_SPECS[connectorType.toLowerCase()];
}

/** Configured minimum poll interval (ms) for a spec'd connector's entity, or
 *  undefined if the connector has no spec / the entity sets no override. The
 *  scheduler falls back to its base cycle when this is undefined. */
export function getEntityPollIntervalMs(connectorType: string, entityType: string): number | undefined {
  const ent = getPollSpec(connectorType)?.entities.find(e => e.entityType === entityType);
  return ent?.pollIntervalMs;
}
