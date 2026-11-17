// capability_search / run_capability tools for the CAIO chat.
//
// The same absorbed-vendor capabilities the Liftoff assistant and distilled
// agents reach, exposed to the CAIO CAPABILITY-first — never vendor names.
// search returns platform-backend's vendor-hidden, handle-bearing rendering;
// run executes one capability by its opaque handle. The vendor never crosses
// this boundary, so when the CAIO absorbs a conversation into a standing agent
// it cannot leak which vendor did the work. Reached through platform-backend
// (the capability logic and the stateless handles live there), service-authed
// with WORKFORCE_SERVICE_TOKEN.

// The call itself lives in infrastructure now: the parking seam inside the
// platform-agent loop is a second caller of the same service, and it is not a
// tool, so the request is shared rather than copied.
import { pbPost } from '../../infrastructure/platform-backend.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

export const capabilitySearchTool: WorkforcePlanTool = {
  definition: {
    name: 'capability_search',
    description:
      'Find the best available building blocks for a data or automation need — connector tools, '
      + 'platform web tools, and proven external automations — ranked by fit, health, cost, and real '
      + 'usage evidence. Use when the task needs data or an automation and you are not sure which tool '
      + "serves it best. mode: 'public_data' for third-party or competitor info from the public web, "
      + "'own_account' for the workspace's own systems. Results are capabilities, not vendors — run one "
      + 'with run_capability using the capabilityId it returns.',
    input_schema: {
      type: 'object',
      properties: {
        targetSystem: { type: 'string', description: 'Platform the data lives on, lowercase, e.g. instagram, zillow. Omit when unknown.' },
        operation: { type: 'string', description: 'Verb phrase, e.g. "search posts", "enrich person".' },
        entity: { type: 'string', description: 'What comes back, e.g. posts, profiles, listings.' },
        mode: { type: 'string', enum: ['public_data', 'own_account'] },
        availableInputs: { type: 'array', items: { type: 'string' }, description: 'What you can supply, e.g. search_terms, profile_urls.' },
        requiredOutputFields: { type: 'array', items: { type: 'string' }, description: 'Fields the answer must carry.' },
      },
      required: ['operation', 'entity', 'mode'],
    },
  },
  async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<Record<string, unknown>> {
    const mode = input.mode === 'own_account' ? 'own_account' : 'public_data';
    // The invoking user's account rides along, as it does on run below, so
    // the search judges each vendor on the credential the run would use — a
    // workspace connector of the vendor's type when connected, else the
    // platform key. From the turn's own context, never from the model.
    return pbPost('/api/internal/capability-discovery', {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      operation: typeof input.operation === 'string' ? input.operation : 'search',
      entity: typeof input.entity === 'string' ? input.entity : 'records',
      mode,
      ...(typeof input.targetSystem === 'string' ? { targetSystem: input.targetSystem.toLowerCase() } : {}),
      ...(Array.isArray(input.availableInputs) ? { availableInputs: input.availableInputs.filter((s): s is string => typeof s === 'string') } : {}),
      ...(Array.isArray(input.requiredOutputFields) ? { requiredOutputFields: input.requiredOutputFields.filter((s): s is string => typeof s === 'string') } : {}),
    });
  },
};

/** The capability's call arguments, in whatever shape the model proposed them.
 *
 *  The schema declares `args` as an object, but a model carries the same
 *  content in three observed shapes: under `args` (an object), under
 *  `arguments` (an object, or a JSON-encoded string), or flattened — the
 *  fields placed at the top level beside `capabilityId`. A call must run with
 *  the arguments it was proposed with, not with an empty set that every
 *  vendor then refuses as "required field missing". A string that is not a
 *  JSON object reads as no arguments rather than a guess. */
export function readCapabilityArgs(input: Record<string, unknown>): Record<string, unknown> {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (isPlainObject(input.args) && Object.keys(input.args).length > 0) return input.args;
  const alt = input.arguments;
  if (isPlainObject(alt)) return alt;
  if (typeof alt === 'string' && alt.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(alt);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Not JSON: there are no arguments to read.
    }
    return {};
  }
  // Flattened: everything that is not the handle is an argument.
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'capabilityId' || key === 'args' || key === 'arguments') continue;
    flattened[key] = value;
  }
  return flattened;
}

/** The job a large result is parked for: this thread. A turn without one
 *  parks results unscoped — readable by id, listed by nobody. */
function datasetScope(ctx: WorkforcePlanToolContext): { scopeKind: 'caio_thread'; scopeId: string } | Record<string, never> {
  return ctx.threadId ? { scopeKind: 'caio_thread', scopeId: ctx.threadId } : {};
}

export const runCapabilityTool: WorkforcePlanTool = {
  definition: {
    name: 'run_capability',
    description:
      'Run one capability that capability_search returned. Pass its capabilityId (exactly as given) and '
      + 'the arguments the capability needs. Costs are metered to the workspace in Operating Units; a '
      + 'refusal explains itself and is final for this turn — never retry a refusal verbatim. '
      + 'A small result comes back whole. A large one is kept as a dataset and you get its id, its '
      + 'fields and a sample: read it with dataset_query and dataset_extract, which return only what '
      + 'you ask for; the fetch is not charged again (dataset_query and dataset_list use no model; '
      + 'dataset_extract uses the model and is metered like any answer). Never re-run a capability '
      + "to see more of a result it already returned. To add a further run's records to a dataset "
      + 'you already have (the same kind of records for another target), pass its id as appendTo.',
    input_schema: {
      type: 'object',
      properties: {
        capabilityId: { type: 'string', description: 'The capabilityId from a capability_search result (e.g. cap_...). Opaque; do not construct one.' },
        args: { type: 'object', description: 'Arguments for the capability, per the args it listed.' },
        appendTo: { type: 'string', description: "A dataset id from an earlier run: this run's records are added to it (each marked with its _run number) instead of starting a new dataset." },
      },
      required: ['capabilityId', 'args'],
    },
  },
  async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<Record<string, unknown>> {
    const capabilityId = typeof input.capabilityId === 'string' ? input.capabilityId : '';
    if (!capabilityId) {
      return { error: 'run_capability requires a capabilityId from a capability_search result' };
    }
    const args = readCapabilityArgs(input);
    const appendTo = typeof input.appendTo === 'string' && input.appendTo.trim() ? input.appendTo.trim() : undefined;
    // The invoking user's account rides along so the tenant's own connected-
    // vendor key is used when they connected the vendor.
    return pbPost('/api/internal/capability-discovery/run', {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      capabilityId,
      args,
      ...datasetScope(ctx),
      ...(appendTo ? { appendTo } : {}),
    });
  },
};

// A large result of a capability is kept as a dataset for this thread, and
// these read it back: only what is asked for, so the records never pass
// through the context doing the work. The same three tools, in the same
// words, serve the Liftoff assistant and every agent.
const WHERE_SCHEMA = {
  type: 'array',
  description: 'Filters, all of which a record must satisfy.',
  items: {
    type: 'object',
    properties: {
      field: { type: 'string', description: 'A field name from the dataset; a nested field as a.b' },
      op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'in'], description: 'eq ne gt gte lt lte compare with value; contains is a case-insensitive text match; exists needs no value; in matches any of values' },
      value: { type: 'string', description: 'The value to compare with, written as text: a number as 12 or 3.5, true or false, null for an absent value' },
      values: { type: 'array', items: { type: 'string' }, description: 'For in: the values to match, each as text' },
    },
    required: ['field', 'op'],
  },
};

/** The inventory a turn is shown at its start: the conversation's datasets,
 *  newest first, budgeted, in the words platform-backend's own assistants
 *  read — served by dataset_list with `inventory: true`, one call per turn.
 *  Empty when the conversation holds none, and empty (never thrown) when the
 *  read fails: the turn starts without it and still has dataset_list. */
export async function fetchDatasetInventory(ctx: Pick<WorkforcePlanToolContext, 'tenantId' | 'threadId'>): Promise<string> {
  if (!ctx.threadId) return '';
  try {
    const out = await pbPost('/api/internal/capability-discovery/datasets/tool', {
      tenantId: ctx.tenantId,
      tool: 'dataset_list',
      input: { inventory: true },
      scopeKind: 'caio_thread',
      scopeId: ctx.threadId,
    });
    return typeof out.result === 'string' ? out.result.trim() : '';
  } catch {
    return '';
  }
}

function datasetTool(name: 'dataset_query' | 'dataset_extract' | 'dataset_list', definition: WorkforcePlanTool['definition']): WorkforcePlanTool {
  return {
    definition,
    async execute(input: Record<string, unknown>, ctx: WorkforcePlanToolContext): Promise<Record<string, unknown>> {
      return pbPost('/api/internal/capability-discovery/datasets/tool', {
        tenantId: ctx.tenantId,
        tool: name,
        input,
        ...datasetScope(ctx),
      });
    },
  };
}

export const datasetQueryTool: WorkforcePlanTool = datasetTool('dataset_query', {
  name: 'dataset_query',
  description:
    'Read rows from a dataset a fetch kept: name the fields you want, filter, sort and limit, and get exactly those fields for the matching '
    + 'records — small rows, any page, no model used and the fetch not charged again. Use this to pick the top records, to check a value, or to list a column; select only '
    + 'the fields you need (a long text field is shortened unless it is the only one selected). With aggregate, no rows are returned: '
    + '{ distinct: "field" } gives the field\'s distinct values with how many records carry each, and { count: true } with where gives the matching '
    + 'count alone — the cheap answer to "how many posts have over 100 comments" or "which authors appear most". For a question that needs the CONTENT of many '
    + 'records read — themes, a summary, what was said — use dataset_extract instead of paging.',
  input_schema: {
    type: 'object',
    properties: {
      datasetId: { type: 'string', description: 'The dataset id a fetch or dataset_list gave' },
      datasetIds: { type: 'array', items: { type: 'string' }, description: 'Several datasets to read together (each row then carries _dataset)' },
      select: { type: 'array', items: { type: 'string' }, description: 'Fields to return, e.g. ["title","score","url"]; every field when omitted' },
      where: WHERE_SCHEMA,
      sort: {
        type: 'object',
        properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
        required: ['field'],
        description: 'Order of the rows; numbers sort as numbers, desc by default',
      },
      limit: { type: 'integer', description: 'Rows to return, 1–200 (default 50)' },
      offset: { type: 'integer', description: 'Rows to skip, for the next page (the result names the next offset)' },
      aggregate: {
        type: 'object',
        description: 'Compute over the matching records instead of returning rows: distinct lists a field\'s values with counts (the 200 most frequent); count gives the matching count',
        properties: {
          distinct: { type: 'string', description: 'A field name whose distinct values to count; a nested field as a.b' },
          count: { type: 'boolean', description: 'true for the number of matching records' },
        },
      },
    },
  },
});

export const datasetExtractTool: WorkforcePlanTool = datasetTool('dataset_extract', {
  name: 'dataset_extract',
  description:
    'Answer an instruction over the records of a dataset without reading them yourself: the platform reads the selected records and returns '
    + 'one digest (themes, a summary, the answer to a question, counts by kind, quotes). Use it whenever the answer depends on the content of '
    + 'many records. Narrow with where/select/limit so it reads only what matters (for example the comments of the top twenty posts, not of '
    + 'every post); at most 2000 records per call. With saveAs, the instruction is applied to EACH record and the answers are '
    + 'kept as a new dataset you can query (for example "the main complaint in this comment" for every comment). With groupBy, the records are '
    + 'grouped by that field and the instruction is answered once PER GROUP in one call (for example "summarise the discussion" grouped by postId '
    + 'gives one summary per post); at most 50 groups per call, every group\'s answer kept as a dataset {group, records, answer}, '
    + 'and saveAs then only names that dataset.',
  input_schema: {
    type: 'object',
    properties: {
      datasetId: { type: 'string', description: 'The dataset id a fetch or dataset_list gave' },
      instruction: { type: 'string', description: 'What to answer or extract from the records, in one or two sentences' },
      select: { type: 'array', items: { type: 'string' }, description: 'Fields to read; every field when omitted. Fewer fields read faster and cost less.' },
      where: WHERE_SCHEMA,
      limit: { type: 'integer', description: 'Read at most this many records (in fetch order), up to 2000' },
      saveAs: { type: 'string', description: 'Name for a dataset of per-record answers, when you need one answer per record rather than one digest; with groupBy, the name of the dataset of per-group answers' },
      groupBy: { type: 'string', description: 'A field name to group the records by (a nested field as a.b): one answer per group, at most 50 groups' },
    },
    required: ['datasetId', 'instruction'],
  },
});

export const datasetListTool: WorkforcePlanTool = datasetTool('dataset_list', {
  name: 'dataset_list',
  description:
    'List the datasets already kept for this work — each fetch whose result was larger than one message — with their ids, record counts and '
    + 'fields. Check here before fetching again: the fetch is not charged again; dataset_query and dataset_list use no model; dataset_extract '
    + 'uses the model and is metered like any answer.',
  input_schema: { type: 'object', properties: {} },
});
