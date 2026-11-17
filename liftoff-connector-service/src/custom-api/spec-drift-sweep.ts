// Noticing that a provider's API has moved.
//
// A custom API connection is generated from a document fetched once. A
// provider announces nothing, so without this nobody finds out: an API that
// adds an endpoint never offers it here, and one that renames or drops an
// endpoint leaves a connection whose tools call a place that is not there.
//
// The reason it stays hidden is the part worth keeping. The key is untouched
// while an API moves, so the declared verification call keeps succeeding and
// the Connections page keeps saying Connected, verified a moment ago, while
// the tools fail. Health and freshness are different questions and only one of
// them was ever asked.
//
// Same shape as the warehouse reachability probe, for the same reason it
// exists: a warehouse pushes no revocation event, a provider pushes no
// specification-change event, and a scheduled cheap read is the only thing
// that turns either into something a person can see.
//
// It DETECTS and never decides. Applying a re-read replaces the operations,
// and one the provider has dropped goes with them — an AI team bound to it
// loses it — so that stays a person's call in the modal. This records what is
// there now; `spec_drift_hash` differing from `spec_hash` is the whole of the
// signal, which is why applying clears it by making the two equal rather than
// by unsetting a flag somebody has to remember to unset.

import { fetchOpenApiDocument, SpecFetchError } from './spec-fetch.js';
import {
  listCustomApiConnectionsToCheck,
  recordCustomApiSpecCheck,
  type CustomApiDriftCandidate,
} from './repository.js';
import { mergeConnectorConfig } from '../oauth/connector-ops.js';
import { logger } from '../infra/logging.js';

/** How often a cycle runs. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How stale a connection's last read must be before it is read again.
 *  Specifications change on the scale of releases, not minutes, and every
 *  read is somebody else's bandwidth. */
const RECHECK_AFTER = '24 hours';
/** Connections per cycle. Bounds a cycle's outbound fetches, and with an
 *  hourly cycle clears a large estate inside a day. */
const PER_CYCLE = 50;

export class CustomApiSpecDriftSweep {
  private running = false;
  /** Set by `stop()`. A cycle abandons what it has not started yet, so a
   *  shutdown does not wait out a list of providers. Separate from `running`
   *  so one cycle can be run on its own — which is what a test does, and what
   *  a "sweep now" would do. */
  private stopping = false;
  private current: Promise<unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalMs: number = SWEEP_INTERVAL_MS,
    private readonly recheckAfter: string = RECHECK_AFTER,
    private readonly perCycle: number = PER_CYCLE,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.current = this.sweepOnce().catch(() => 0);
      await this.current;
      if (!this.running) break;
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, this.intervalMs);
      });
    }
  }

  /** @returns how many connections were read this cycle. */
  async sweepOnce(): Promise<number> {
    let candidates: CustomApiDriftCandidate[];
    try {
      candidates = await listCustomApiConnectionsToCheck({
        notCheckedFor: this.recheckAfter,
        limit: this.perCycle,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'custom_api_spec_drift_list_failed');
      return 0;
    }

    let read = 0;
    let drifted = 0;
    for (const candidate of candidates) {
      if (this.stopping) break;
      const moved = await this.checkOne(candidate);
      if (moved === null) continue;
      read++;
      if (moved) drifted++;
    }
    if (read > 0) {
      logger.info({ read, drifted, candidates: candidates.length }, 'custom_api_spec_drift_cycle');
    }
    return read;
  }

  /** @returns whether the document moved, or null when it could not be read. */
  private async checkOne(candidate: CustomApiDriftCandidate): Promise<boolean | null> {
    let hash: string;
    try {
      hash = (await fetchOpenApiDocument(candidate.specSourceUrl)).hash;
    } catch (err) {
      // A specification that cannot be fetched is not a specification that
      // changed, and a provider having a bad afternoon must not be reported to
      // a person as their connection being out of date. `checked_at` is NOT
      // moved either: the read did not happen, so the next cycle tries again
      // rather than waiting out the full window on a failure.
      const reason = err instanceof SpecFetchError ? err.reason : 'error';
      logger.warn(
        { connectorId: candidate.connectorId, reason, err: (err as Error).message },
        'custom_api_spec_drift_fetch_failed',
      );
      return null;
    }

    try {
      await recordCustomApiSpecCheck({
        tenantId: candidate.tenantId,
        connectorId: candidate.connectorId,
        driftHash: hash,
      });
    } catch (err) {
      logger.warn(
        { connectorId: candidate.connectorId, err: (err as Error).message },
        'custom_api_spec_drift_record_failed',
      );
      return null;
    }

    const moved = hash !== candidate.specHash;
    // Onto the connector row as well, because the Connections CARD is where a
    // person finds out. The card renders from the connectors list and never
    // fetches a connection's own record, so a finding that stays in this
    // service's table is one nobody has a reason to go and look at.
    try {
      await mergeConnectorConfig(candidate.tenantId, candidate.connectorId, { specDrifted: moved });
    } catch (err) {
      logger.warn(
        { connectorId: candidate.connectorId, err: (err as Error).message },
        'custom_api_spec_drift_card_flag_failed',
      );
    }
    if (moved) {
      // Named rather than counted: this is the line somebody reads when a
      // person asks why an AI team's tool started failing.
      logger.info(
        { tenantId: candidate.tenantId, connectorId: candidate.connectorId },
        'custom_api_spec_drift_detected',
      );
    }
    return moved;
  }
}

let sweep: CustomApiSpecDriftSweep | null = null;

export function startCustomApiSpecDriftSweep(): CustomApiSpecDriftSweep {
  if (sweep) return sweep;
  sweep = new CustomApiSpecDriftSweep();
  sweep.start();
  return sweep;
}

export async function stopCustomApiSpecDriftSweep(): Promise<void> {
  if (!sweep) return;
  await sweep.stop();
  sweep = null;
}
