import crypto from 'node:crypto';
import { getPool } from '../../infrastructure/database';
import * as repo from '../../browser-sessions/repository';
import { emitBrowserSessionEvent } from '../../browser-sessions/events';
import { insertClarificationRow } from '../../agent-execution/clarification-storage';
import { logger } from '../../infrastructure/logging';

export function verifyAnchorSignature(
  rawBody: Buffer,
  signatureHeader: string,
  timestampHeader: string,
  secret: string,
): boolean {
  const signed = `v0:${timestampHeader}:${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  // Header format: "v1=<hex>"
  const match = /v1=([a-f0-9]+)/i.exec(signatureHeader);
  if (!match) return false;
  const given = Buffer.from(match[1], 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (given.length !== expectedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(given, expectedBuf);
  } catch {
    return false;
  }
}

interface AnchorEnvelope {
  id: string;
  type: string;
  created: string;
  project_id: string;
  data: Record<string, unknown>;
}

function extractVendorSessionId(envelope: AnchorEnvelope): string | null {
  const data = envelope.data as { session_id?: string };
  return data?.session_id ?? null;
}

export async function handleAnchorEvent(envelope: AnchorEnvelope): Promise<void> {
  const vendorSessionId = extractVendorSessionId(envelope);
  const { inserted } = await repo.recordWebhookEvent(
    envelope.id, envelope.type, vendorSessionId, envelope,
  );
  if (!inserted) {
    logger.debug({ envelopeId: envelope.id }, 'anchor webhook duplicate');
    return;
  }

  switch (envelope.type) {
    case 'intervention.requested': {
      // Verified by capturing a real signed delivery: webhook envelope.data
      // is snake_case, not camelCase (unlike the
      // GET /v1/sessions/{id}/agent/requested-human-intervention shape,
      // which Anchor inconsistently returns in camelCase). Real fields:
      //   session_id, request_id, message, input_type, fields, live_view_url
      const data = envelope.data as {
        session_id: string;
        request_id: string;
        message: string;
        input_type?: string;
        fields?: unknown;
        live_view_url?: string;
      };
      const session = await repo.getByVendorSessionId(data.session_id);
      if (!session || !session.threadId) {
        logger.warn(
          { vendorSessionId: data.session_id, hasSession: !!session, hasThread: !!session?.threadId },
          'intervention.requested for unknown or unbound session — recorded but not surfaced',
        );
        return;
      }
      // Defense in depth: poll Anchor for the live intervention state.
      // The webhook payload is the source of truth most of the time,
      // but the documented response schema has drifted before (see the
      // snake_case/camelCase note above) — if Anchor adds /
      // renames a field at the webhook layer in the future, the poll
      // path gives us the same data structured under a stable contract.
      // request_id from the poll wins if the webhook somehow lost it.
      let requestId = data.request_id;
      let message = data.message;
      try {
        const { AnchorClient } = await import('./anchor-client');
        const client = new AnchorClient();
        const live = await client.getRequestedHumanIntervention(data.session_id, session.tenantId);
        if (live) {
          if (!requestId || requestId !== live.requestId) requestId = live.requestId;
          if (!message && live.question) message = live.question;
        }
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, vendorSessionId: data.session_id },
          'intervention.requested: backstop poll failed — falling back to webhook payload',
        );
      }
      // Find the active invocation blocked on the web_task tool call.
      const pool = getPool();
      const invocationResult = await pool.query(
        `SELECT id FROM invocations
         WHERE tenant_id = $1 AND thread_id = $2 AND agent_id = $3 AND completed_at IS NULL
         ORDER BY started_at DESC LIMIT 1`,
        [session.tenantId, session.threadId, session.agentId],
      );
      if (invocationResult.rows.length === 0) {
        logger.warn(
          { vendorSessionId: data.session_id, threadId: session.threadId },
          'intervention.requested but no active invocation — session orphaned, recording webhook only',
        );
        return;
      }
      const invocationId = invocationResult.rows[0].id as string;

      // Surface in BOTH the chat thread AND the /review queue via the
      // PR0-extracted storage primitive. NO 24h Cloud Task — our agent loop
      // is blocked on the web_task HTTP call, not paused; it resumes on its
      // own when Anchor's agent gets the response and finishes the task.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await insertClarificationRow({
          client,
          tenantId: session.tenantId,
          agentId: session.agentId,
          invocationId,
          threadId: session.threadId,
          pausedAtStepId: null,
          question: message,
          source: { kind: 'anchor_intervention', vendorRequestId: requestId },
          pauseState: null,
          // Immaterial here: the A1 notification is scoped to recovery_llm, and
          // this hand-off already has a person at the browser. Stated rather
          // than defaulted so the field never becomes an accident.
          interactive: true,
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return;
    }
    case 'intervention.resolved': {
      // We typically drove resolution ourselves (operator replied via chat or queue,
      // we forwarded to Anchor's respond-to-human-intervention). Webhook is the
      // confirmation. Safety net: if a clarification row is still pending for this
      // vendor_request_id (race with our own resolution path), mark it fired.
      const data = envelope.data as { session_id: string; request_id: string };
      const pool = getPool();
      await pool.query(
        `UPDATE agent_scheduled_invocations
         SET status = 'fired', fired_at = NOW(), updated_at = NOW()
         WHERE vendor_request_id = $1 AND status IN ('pending', 'resume_inflight')`,
        [data.request_id],
      );
      return;
    }
    case 'session.completed':
    case 'session.failed': {
      const data = envelope.data as { session_id: string; end_reason?: string };
      const reason: 'completed' | 'failed' | 'idle_timeout' =
        data.end_reason === 'idle_timeout' ? 'idle_timeout'
        : envelope.type === 'session.failed' ? 'failed' : 'completed';

      // Idle-timeout path: this is the most common reason a session ends from
      // the user's perspective (they walked away). The frontend wants to render
      // the freeze-frame UX, which needs a last_screenshot_object_path stashed
      // on the row. If the agent never called read_active_browser_session
      // during the session, nothing populated it. Try once more here, BEFORE
      // closeSession — Anchor's session is still technically reachable until we
      // tear it down. Failures are swallowed: a missing frame just degrades
      // the paused-frame UX to "no frame", which the frontend already handles.
      // Only do this when there's no existing frame; otherwise we'd waste a
      // GCS write replacing a perfectly fresh screenshot from the agent's
      // last turn.
      // One lookup serves both the final-frame capture and the close: Anchor
      // names its own session id, and the close below is keyed on our row.
      const existing = await repo.getByVendorSessionId(data.session_id);
      if (reason === 'idle_timeout') {
        try {
          if (existing && !existing.lastScreenshotObjectPath) {
            const { AnchorClient } = await import('./anchor-client');
            const { uploadScreenshot } = await import('../../browser-sessions/screenshot-storage');
            const client = new AnchorClient();
            const png = await client.fetchScreenshotPng(data.session_id, existing.tenantId);
            const { objectPath } = await uploadScreenshot({
              tenantId: existing.tenantId,
              vendorSessionId: data.session_id,
              png,
            });
            await repo.setLastScreenshot(data.session_id, objectPath, new Date());
          }
        } catch (e) {
          logger.warn(
            { vendorSessionId: data.session_id, err: (e as Error).message },
            'idle_timeout: final-frame capture failed; closing session without cached frame',
          );
        }
      }

      // Closed through the repository's closeSession, the one writer of
      // closed_at, so an open takeover hold ends with the session in one
      // transaction. A row already closed returns null and emits nothing.
      const session = existing && !existing.closedAt
        ? await repo.closeSession(existing.id, reason)
        : null;
      if (session) emitBrowserSessionEvent({
        type: 'SESSION_CLOSED', session, emittedAt: new Date(),
      });
      return;
    }
    // identity.* and task.* not consumed by this surface; recorded for audit.
    default:
      return;
  }
}
