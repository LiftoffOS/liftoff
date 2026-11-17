// A pending tool call, written the way the review page writes it.
//
// Ported line by line from Liftoff-React src/utils/toolCallDetails.ts
// (`describeToolCall`, `toDetailFields`, `redactSecrets`), with the page's own
// fixtures as the test, so an approval in the archive reads exactly as the
// person saw it on /review: the connector's display name, the action in
// sentence case, the argument names in words, values as text capped at 280
// characters, nested two levels, secrets hidden. Tool-call ids never appear.
//
// The port is STRICTER than the page in two ways, because a file leaves the
// building and a screen does not:
//   - the page's `redactSecrets` stops at depth 8 and returns whatever lies
//     below UNCHANGED (toolCallDetails.ts:247-248), and `toDetailFields`
//     serializes a subtree at its own depth limit as compact JSON (:224-226),
//     so a token nested nine levels down would be printed verbatim. Here any
//     over-depth subtree becomes "Hidden" instead.
//   - tool arguments routinely carry Liftoff's own identifiers. `scrubKnownIds`
//     walks every string leaf and replaces an EXACT match of a known internal
//     id with the resolved name where one exists and "Hidden" otherwise. Only
//     exact matches of known ids are touched; a person's text is never
//     pattern-scrubbed.

import { HIDDEN } from './labels';

// toolCallDetails.ts:19-20. Arg keys whose value must never be shown.
const SECRET_KEY =
  /(pass(word)?|secret|token|api[_-]?key|access[_-]?key|authorization|bearer|credential|private[_-]?key|client[_-]?secret)/i;

// toolCallDetails.ts:23-27. Words that stay uppercase in a label.
const ACRONYMS = new Set([
  'id', 'ids', 'url', 'urls', 'uri', 'api', 'sms', 'cc', 'bcc', 'ip', 'sql',
  'csv', 'json', 'html', 'pdf', 'utc', 'crm', 'sla', 'kpi', 'ssn', 'ein',
  'vat', 'iso', 'ttl', 'mcp', 'ai', 'hr', 'pr', 'qa', 'ui',
]);

// toolCallDetails.ts:30-49. Connectors whose own spelling is not what
// title-casing produces.
const BRAND_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
  openai: 'OpenAI',
  sendgrid: 'SendGrid',
  pagerduty: 'PagerDuty',
  servicenow: 'ServiceNow',
  clickup: 'ClickUp',
  bigquery: 'BigQuery',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  dynamodb: 'DynamoDB',
  aws: 'AWS',
  gcp: 'GCP',
  liftofftools: 'Liftoff',
};

// toolCallDetails.ts:52-58.
function toWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

// toolCallDetails.ts:62-72.
function sentenceCase(raw: string): string {
  const words = toWords(raw);
  if (words.length === 0) return raw;
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(' ');
}

// toolCallDetails.ts:75-83.
function connectorDisplayName(alias: string): string {
  const compact = alias.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (BRAND_NAMES[compact]) return BRAND_NAMES[compact];
  return toWords(alias)
    .map((word) =>
      ACRONYMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export interface ToolCallHeading {
  /** The connector the call goes through, or null for a platform operation. */
  connector: string | null;
  /** What the call does, in words. */
  action: string;
}

// toolCallDetails.ts:100-107. Everything from the first id-shaped segment on
// is dropped, which keeps the vendor words.
function stripInstanceId(alias: string): string {
  const kept: string[] = [];
  for (const segment of alias.split('-')) {
    if (/^[0-9a-f]{4,}$/i.test(segment) && /\d/.test(segment)) break;
    kept.push(segment);
  }
  return kept.length > 0 ? kept.join('-') : alias;
}

// toolCallDetails.ts:115-123.
export function describeToolCall(name: string): ToolCallHeading {
  const parts = name.split('__').filter(Boolean);
  const action = sentenceCase(parts[parts.length - 1] ?? name);
  if (parts.length < 2) return { connector: null, action };

  const segments = parts[0] === 'mcp' ? parts.slice(1) : parts;
  const alias = stripInstanceId(segments[0] ?? '');
  return { connector: alias ? connectorDisplayName(alias) : null, action };
}

/** One row of the argument list (toolCallDetails.ts:126-135). */
export interface DetailField {
  path: string;
  label: string;
  depth: number;
  value: string | null;
}

// toolCallDetails.ts:140-142.
const MAX_DEPTH = 2;
const VALUE_MAX = 280;
const MAX_FIELDS = 40;

type Primitive = string | number | boolean | bigint;

function isPrimitive(value: unknown): value is Primitive {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint';
}

function primitiveText(value: Primitive): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX)}…` : flat;
}

// toolCallDetails.ts:175-238, with one difference: a subtree at the depth
// limit is "Hidden" rather than compact JSON (see the header).
export function toDetailFields(input: Record<string, unknown> | null | undefined): DetailField[] {
  const fields: DetailField[] = [];
  if (!input) return fields;

  const push = (path: string, label: string, depth: number, value: string | null) => {
    if (fields.length >= MAX_FIELDS) return;
    fields.push({ path, label, depth, value });
  };

  const walk = (value: unknown, key: string, path: string, depth: number) => {
    if (fields.length >= MAX_FIELDS) return;
    const label = /^\d+$/.test(key) ? `Item ${key}` : sentenceCase(key);

    if (SECRET_KEY.test(key)) {
      push(path, label, depth, HIDDEN);
      return;
    }
    if (value === null || value === undefined || value === '') {
      push(path, label, depth, 'None');
      return;
    }
    if (isPrimitive(value)) {
      push(path, label, depth, clamp(primitiveText(value)));
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        push(path, label, depth, 'None');
        return;
      }
      if (value.every(isPrimitive)) {
        push(path, label, depth, clamp(value.map(primitiveText).join(', ')));
        return;
      }
      if (depth >= MAX_DEPTH) {
        push(path, label, depth, HIDDEN);
        return;
      }
      push(path, label, depth, null);
      value.forEach((item, index) => walk(item, String(index + 1), `${path}.${index}`, depth + 1));
      return;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      push(path, label, depth, 'None');
      return;
    }
    if (depth >= MAX_DEPTH) {
      push(path, label, depth, HIDDEN);
      return;
    }
    push(path, label, depth, null);
    for (const [childKey, childValue] of entries) {
      walk(childValue, childKey, `${path}.${childKey}`, depth + 1);
    }
  };

  for (const [key, value] of Object.entries(input)) {
    walk(value, key, key, 0);
  }
  return fields;
}

// toolCallDetails.ts:247-256, with one difference: past depth 8 an object or
// array is "Hidden" rather than returned unchanged (see the header).
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return HIDDEN;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? HIDDEN : redactSecrets(child, depth + 1);
  }
  return out;
}

/** The argument rows as the nested object the archive carries: a heading
 *  row's children sit under its label, a value row is its label and text. Two
 *  arguments that share a label keep both, the second numbered. */
export function detailFieldsToObject(fields: DetailField[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const byPath = new Map<string, Record<string, unknown>>();
  byPath.set('', root);

  const assign = (target: Record<string, unknown>, label: string, value: unknown) => {
    let key = label;
    let n = 2;
    while (Object.prototype.hasOwnProperty.call(target, key)) {
      key = `${label} (${n})`;
      n += 1;
    }
    target[key] = value;
    return key;
  };

  for (const field of fields) {
    const parentPath = field.path.includes('.') ? field.path.slice(0, field.path.lastIndexOf('.')) : '';
    const parent = byPath.get(parentPath) ?? root;
    if (field.value === null) {
      const child: Record<string, unknown> = {};
      assign(parent, field.label, child);
      byPath.set(field.path, child);
    } else {
      assign(parent, field.label, field.value);
    }
  }
  return root;
}

// toolCallDetails.ts:261-269. The head of the runtime's flattened line for one
// call, exactly as hitl-card-content.ts writes it (alias cut at the first
// hyphen, action raw). Mirrored rather than reused because it is the thing
// being recognised.
function flattenedHead(name: string): string {
  const parts = name.split('__').filter(Boolean);
  const action = parts[parts.length - 1] ?? name;
  if (parts.length < 2) return action;
  const segments = parts[0] === 'mcp' ? parts.slice(1) : parts;
  const alias = (segments[0] ?? '').split('-')[0];
  return alias ? `${alias.toLowerCase()} · ${action}` : action;
}

// toolCallDetails.ts:273. The separator the runtime puts between a call's
// head and its arguments, and again before anything it measured.
const FLATTENED_SEPARATOR = ' — ';

/**
 * What the stored `detail` line says that the argument rows do not
 * (toolCallDetails.ts:287-300, and what ReviewQueuePage.tsx:352 renders).
 *
 * Two shapes reach this field. Most rows carry the mechanical
 * `connector · action — key value` line, which the rendered arguments already
 * say in full and better, except for the measurement the blast-radius gate
 * appends to it ("This run would have affected 120 items in total."). Older
 * rows carry free prose, which is worth showing whole.
 */
export function detailNote(
  detail: string | null | undefined,
  calls: Array<{ name: string }>,
): string | null {
  const text = (detail ?? '').trim();
  if (!text) return null;

  const head = calls[0] ? flattenedHead(calls[0].name) : null;
  if (!head || !text.startsWith(head)) return text;

  const cut = text.lastIndexOf(FLATTENED_SEPARATOR);
  if (cut === -1) return null;
  const tail = text.slice(cut + FLATTENED_SEPARATOR.length).trim();
  return /^[A-Z][\s\S]*[.…]$/.test(tail) ? tail : null;
}

/** Every internal identifier this export has resolved, to what the person
 *  recognises it as. A null name means the id is known and has no name to
 *  stand in for it, so it renders as "Hidden". */
export type KnownIds = ReadonlyMap<string, string | null>;

/** Replace an exact known-id string leaf with its resolved name or "Hidden".
 *  Only whole-string exact matches: a sentence that happens to contain an id
 *  is a person's text and is never altered. */
export function scrubKnownIds(value: unknown, known: KnownIds): unknown {
  if (typeof value === 'string') {
    if (!known.has(value)) return value;
    return known.get(value) ?? HIDDEN;
  }
  if (Array.isArray(value)) return value.map((item) => scrubKnownIds(item, known));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubKnownIds(child, known);
    }
    return out;
  }
  return value;
}
