// Live-resource repository — tracks PTY / browser / watcher / bash sessions
// currently held open inside each sandbox. Used for OBSERVABILITY only
// (audit / debug surfaces: "how many tabs is tenant X's agent holding open
// right now?"). Billing is NOT driven from here — instance-alive cost is the
// single per-second meter and lives in the InstanceAliveTicker, which walks
// sandbox_state directly. Holding 10 PTYs and 0 PTYs in the same sandbox
// costs the same: one Cloud Run instance-second.
//
// Tables come from migrations 268–271:
//   sandbox_pty_sessions  (sandbox_id, session_id, status, last_activity, ...)
//   sandbox_browser_tabs  (sandbox_id, tab_id, closed_at, ...)
//   sandbox_watchers      (sandbox_id, watcher_id, stopped_at, ...)
//   sandbox_bash_sessions (sandbox_id, session_id, closed_at, ...)

import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const pool = getPoolForService('default');

export interface ResourceOwner {
  sandboxId: string;
  tenantId: string;
  agentId: string;
  invocationId: string;
}

export interface LiveResourceSummary {
  sandboxId: string;
  ptySessions: string[];
  browserTabs: string[];
  watchers: string[];
  bashSessions: string[];
}

export class LiveResourcesRepository {
  // ── Writes — called from dispatchers on create / delete ────────────────
  async trackPtyCreated(owner: ResourceOwner, sessionId: string): Promise<void> {
    await pool.query(
      `INSERT INTO sandbox_pty_sessions
        (sandbox_id, session_id, tenant_id, agent_id, invocation_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sandbox_id, session_id) DO NOTHING`,
      [owner.sandboxId, sessionId, owner.tenantId, owner.agentId, owner.invocationId],
    ).catch(err => log.warn({ msg: 'trackPtyCreated failed', err: (err as Error).message }));
  }

  async trackPtyClosed(sandboxId: string, sessionId: string, exitCode: number | null): Promise<void> {
    await pool.query(
      `UPDATE sandbox_pty_sessions
          SET status = 'exited', exited_at = NOW(), exit_code = $3
        WHERE sandbox_id = $1 AND session_id = $2 AND status = 'active'`,
      [sandboxId, sessionId, exitCode],
    ).catch(err => log.warn({ msg: 'trackPtyClosed failed', err: (err as Error).message }));
  }

  async trackBrowserTabOpened(owner: ResourceOwner, tabId: string, url: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO sandbox_browser_tabs
        (sandbox_id, tab_id, tenant_id, agent_id, invocation_id, current_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sandbox_id, tab_id) DO NOTHING`,
      [owner.sandboxId, tabId, owner.tenantId, owner.agentId, owner.invocationId, url],
    ).catch(err => log.warn({ msg: 'trackBrowserTabOpened failed', err: (err as Error).message }));
  }

  async trackBrowserTabClosed(sandboxId: string, tabId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_browser_tabs
          SET closed_at = NOW()
        WHERE sandbox_id = $1 AND tab_id = $2 AND closed_at IS NULL`,
      [sandboxId, tabId],
    ).catch(err => log.warn({ msg: 'trackBrowserTabClosed failed', err: (err as Error).message }));
  }

  async trackWatcherCreated(owner: ResourceOwner, watcherId: string, paths: string[]): Promise<void> {
    await pool.query(
      `INSERT INTO sandbox_watchers
        (sandbox_id, watcher_id, tenant_id, agent_id, invocation_id, paths)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sandbox_id, watcher_id) DO NOTHING`,
      [owner.sandboxId, watcherId, owner.tenantId, owner.agentId, owner.invocationId, paths],
    ).catch(err => log.warn({ msg: 'trackWatcherCreated failed', err: (err as Error).message }));
  }

  async trackWatcherStopped(sandboxId: string, watcherId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_watchers
          SET stopped_at = NOW()
        WHERE sandbox_id = $1 AND watcher_id = $2 AND stopped_at IS NULL`,
      [sandboxId, watcherId],
    ).catch(err => log.warn({ msg: 'trackWatcherStopped failed', err: (err as Error).message }));
  }

  async trackBashCreated(owner: ResourceOwner, sessionId: string, cwd: string): Promise<void> {
    await pool.query(
      `INSERT INTO sandbox_bash_sessions
        (sandbox_id, session_id, tenant_id, agent_id, invocation_id, cwd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sandbox_id, session_id) DO NOTHING`,
      [owner.sandboxId, sessionId, owner.tenantId, owner.agentId, owner.invocationId, cwd],
    ).catch(err => log.warn({ msg: 'trackBashCreated failed', err: (err as Error).message }));
  }

  async trackBashClosed(sandboxId: string, sessionId: string): Promise<void> {
    await pool.query(
      `UPDATE sandbox_bash_sessions
          SET closed_at = NOW()
        WHERE sandbox_id = $1 AND session_id = $2 AND closed_at IS NULL`,
      [sandboxId, sessionId],
    ).catch(err => log.warn({ msg: 'trackBashClosed failed', err: (err as Error).message }));
  }

  // ── Reads — observability surface (not billed from) ───────────────────
  async snapshot(): Promise<LiveResourceSummary[]> {
    // One query per resource type, then merge by sandboxId. Each query scopes
    // to "still alive" rows joined through sandbox_state.
    const [pty, tabs, watchers, bash] = await Promise.all([
      pool.query<{ sandbox_id: string; session_id: string }>(
        `SELECT p.sandbox_id, p.session_id
           FROM sandbox_pty_sessions p
           JOIN sandbox_state s ON s.sandbox_id = p.sandbox_id
          WHERE p.status = 'active'
            AND s.status NOT IN ('destroyed','error')`,
      ),
      pool.query<{ sandbox_id: string; tab_id: string }>(
        `SELECT t.sandbox_id, t.tab_id
           FROM sandbox_browser_tabs t
           JOIN sandbox_state s ON s.sandbox_id = t.sandbox_id
          WHERE t.closed_at IS NULL
            AND s.status NOT IN ('destroyed','error')`,
      ),
      pool.query<{ sandbox_id: string; watcher_id: string }>(
        `SELECT w.sandbox_id, w.watcher_id
           FROM sandbox_watchers w
           JOIN sandbox_state s ON s.sandbox_id = w.sandbox_id
          WHERE w.stopped_at IS NULL
            AND s.status NOT IN ('destroyed','error')`,
      ),
      pool.query<{ sandbox_id: string; session_id: string }>(
        `SELECT b.sandbox_id, b.session_id
           FROM sandbox_bash_sessions b
           JOIN sandbox_state s ON s.sandbox_id = b.sandbox_id
          WHERE b.closed_at IS NULL
            AND s.status NOT IN ('destroyed','error')`,
      ),
    ]);

    const bySandbox = new Map<string, LiveResourceSummary>();
    const ensure = (sandboxId: string): LiveResourceSummary => {
      let summary = bySandbox.get(sandboxId);
      if (!summary) {
        summary = {
          sandboxId,
          ptySessions: [],
          browserTabs: [],
          watchers: [],
          bashSessions: [],
        };
        bySandbox.set(sandboxId, summary);
      }
      return summary;
    };

    for (const r of pty.rows) ensure(r.sandbox_id).ptySessions.push(r.session_id);
    for (const r of tabs.rows) ensure(r.sandbox_id).browserTabs.push(r.tab_id);
    for (const r of watchers.rows) ensure(r.sandbox_id).watchers.push(r.watcher_id);
    for (const r of bash.rows) ensure(r.sandbox_id).bashSessions.push(r.session_id);

    return Array.from(bySandbox.values());
  }
}

export const liveResourcesRepository = new LiveResourcesRepository();
