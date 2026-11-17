// What a run actually produced, so a delivery can point at it.
//
// A team that works for ten minutes and writes nine documents used to deliver a
// sentence about how the run ENDED and nothing about what it made. The person
// was told "this has been handed to someone" while their report sat in a Google
// Doc whose URL the platform had recorded and never showed them.
//
// The source is the audit trail, because that is where the answer already is:
// every connector dispatch records the tool, its arguments and its result, and
// a created document's result carries its own link. Nothing new has to be
// collected — it only has to be read back.
//
// Scoped to ONE exchange rather than to a time window: from the person's last
// message on this thread to now. A run continuing across several invocations is
// still one thing they asked for, so its artifacts belong together, and work
// from yesterday's run does not.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export interface RunArtifact {
  /** What the thing is called, as the agent named it when it made it. */
  title: string;
  url: string;
}

/** How many to carry. A sweep that writes a document per competitor can produce
 *  a dozen; a message listing all of them stops being readable, and the run's
 *  own summary is the place for detail. */
const MAX_ARTIFACTS = 8;

/** The first link in a recorded result. Connector results are JSON, and the
 *  field naming a created artifact differs per provider (`display_url`,
 *  `webViewUrl`, `permalink`), so this reads the LINK rather than any one
 *  provider's field name. */
function firstUrl(summary: string | null): string | null {
  if (!summary) return null;
  const m = summary.match(/https?:\/\/[^"'\s\\)]+/);
  return m ? m[0] : null;
}

/** Did this call MAKE something, or did it just look at things?
 *
 *  A read returns links too — `search_documents` answers with a `webViewLink`
 *  for every file it found — so "the result contains a URL" lists documents the
 *  run merely opened under a heading that says it produced them — files a
 *  search had found, or the same document twice under two URL forms.
 *
 *  Read from the action's VERB, which every connector spells the same way, and
 *  a read wins ties: listing something the run did not make is the error worth
 *  avoiding. */
const WRITE_VERB = /(^|_)(create|update|insert|append|upload|write|replace)(_|$)/;
const READ_VERB = /(^|_)(get|search|list|find|read|fetch|lookup|query|export|download)(_|$)/;

function isProducing(action: string): boolean {
  const verb = action.includes('__') ? action.slice(action.indexOf('__') + 2) : action;
  if (READ_VERB.test(verb)) return false;
  return WRITE_VERB.test(verb);
}

/** One document, however its link was spelled. The same file comes back as
 *  `/edit` from a create and `/edit?usp=drivesdk` from a later call, and a
 *  string comparison lists it twice. */
function identity(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  return path.replace(/\/(edit|view|preview)$/, '');
}

/** The file's own name, from whichever end of the call carries it.
 *
 *  A create sends `title` and an update sends only `document_id` — so reading
 *  the request alone named one document in eight and labelled the rest
 *  "Updated document", for files the platform had every right to name.
 *
 *  The RESULT carries the name too: the runtime's audit summary now keeps a
 *  result's identifying fields ahead of its bulk, so a document's title
 *  survives instead of being spent on body structure. Read the request first
 *  (it is what the agent chose to call the thing), then the result. */
function nameFrom(summary: string | null): string | null {
  if (!summary) return null;
  const m = summary.match(/"(?:title|name|filename)"\s*:\s*"((?:[^"\\]|\\.){1,200})"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function labelFor(
  title: string | null,
  action: string,
  summary: string | null,
  known: Map<string, string>,
): string {
  const own = title?.trim() || nameFrom(summary)?.trim();
  if (own) return own;
  // Ask the rest of the exchange. An update returns no title — Google's API
  // simply does not send one — but the run READ the same document first, and
  // that response did. Both rows carry the document's link, so the link is the
  // join.
  const url = firstUrl(summary);
  const fromExchange = url ? known.get(identity(url)) : undefined;
  if (fromExchange) return fromExchange;

  const verb = action.includes('__') ? action.slice(action.indexOf('__') + 2) : action;
  return /(^|_)update(_|$)/.test(verb) ? 'Updated document' : 'New document';
}

/** Every document this exchange saw, by link, with the name it was seen under.
 *
 *  Built from ALL of the run's calls, reads included: a read is not an artifact
 *  and is never listed, but it is where a document's NAME comes from. Without
 *  this a run that updated eight documents listed eight of "Updated document",
 *  for files it had opened by name moments earlier. */
function namesSeen(rows: Array<{ title: string | null; output_summary: string | null }>): Map<string, string> {
  const known = new Map<string, string>();
  for (const row of rows) {
    const url = firstUrl(row.output_summary);
    if (!url) continue;
    const name = row.title?.trim() || nameFrom(row.output_summary)?.trim();
    // First sighting wins: the earliest name is the one the person's own
    // document had before this run started renaming anything.
    if (name && !known.has(identity(url))) known.set(identity(url), name);
  }
  return known;
}

/**
 * Artifacts this thread's current exchange produced, newest last.
 *
 * Best-effort by construction: a delivery that cannot list what it made is
 * still worth sending, so every failure answers with an empty list rather than
 * throwing into the delivery path.
 */
export async function collectRunArtifacts(
  tenantId: string,
  threadId: string,
): Promise<RunArtifact[]> {
  try {
    const rows = await withTenantScope(tenantId, (client) => client.query<{
      title: string | null;
      action: string;
      output_summary: string | null;
    }>(
      // The window is the current exchange: everything since the person last
      // spoke. `created_at DESC LIMIT` on the message keeps that a lookup
      // rather than a scan.
      `WITH asked AS (
         SELECT created_at FROM agent_chat_messages
          WHERE tenant_id = $1 AND thread_id = $2 AND role = 'user'
          ORDER BY created_at DESC LIMIT 1
       )
       SELECT a.input_args->>'title' AS title, a.action, a.output_summary
         FROM agent_audit_logs a, asked
        WHERE a.tenant_id = $1
          AND a.thread_id = $2
          AND a.created_at >= asked.created_at
          AND a.outcome = 'success'
          AND a.output_summary IS NOT NULL
        ORDER BY a.created_at`,
      [tenantId, threadId],
    ));

    const known = namesSeen(rows.rows);
    const seen = new Set<string>();
    const artifacts: RunArtifact[] = [];
    for (const row of rows.rows) {
      // A read returns links too, and listing what a run OPENED under "what
      // this run produced" is a claim about the run that is not true.
      if (!isProducing(row.action)) continue;
      const url = firstUrl(row.output_summary);
      if (!url) continue;
      const key = identity(url);
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({ title: labelFor(row.title, row.action, row.output_summary, known), url });
      if (artifacts.length >= MAX_ARTIFACTS) break;
    }
    return artifacts;
  } catch (err) {
    log.warn(
      { tenantId, threadId, error: (err as Error).message },
      'run-artifacts: could not read what this run produced (delivery continues)',
    );
    return [];
  }
}

/** Append the artifact list to a message going somewhere that cannot render a
 *  card — Slack and Teams — or leave it exactly as it was when there is nothing
 *  to add. The web transcript gets `fileOutputAttachments` instead. */
export function withArtifacts(replyText: string, artifacts: RunArtifact[]): string {
  if (artifacts.length === 0) return replyText;
  const lines = artifacts.map((a) => `- ${a.title}: ${a.url}`);
  return `${replyText}\n\nWhat this run produced:\n${lines.join('\n')}`;
}

/** The artifacts as the transcript's own file cards.
 *
 *  A list of raw links pasted into a sentence is what a surface produces when
 *  it has no component for the thing it is showing. This one does: the card
 *  names the file, knows which cloud it lives in, and opens it. Shaped as
 *  `FileAttachment`, which is what a `file_output` row carries.
 *
 *  `downloadUrl` is null because the bytes are not ours — the file lives in the
 *  customer's own Drive, and the card hides its download control rather than
 *  offering one that cannot work. The id is the document's, which is stable and
 *  is only ever read back as a render key here. */
export function fileOutputAttachments(artifacts: RunArtifact[]): Array<{
  generatedFileId: string;
  filename: string;
  outputType: string;
  version: number;
  downloadUrl: string | null;
  webViewUrl: string;
}> {
  return artifacts.map((a) => ({
    generatedFileId: identity(a.url),
    filename: a.title,
    outputType: 'document',
    version: 1,
    downloadUrl: null,
    webViewUrl: a.url,
  }));
}
