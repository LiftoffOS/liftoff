// Finish imports whose conversion ran out of rate-limit allowance.
//
// Conversion costs one distillation per team member, and a person gets a fixed
// number of those per hour. An item that cannot reserve a slot is left
// `pending` with the reason rather than failed — the design was always that it
// would be picked up later.
//
// Nothing picked it up. Conversion ran only while somebody had the wizard open
// and pressed Continue, so a workspace importing more members than its hourly
// allowance converted part of its team and then stopped, looking finished. The
// number that hid this was a cap: imports were refused above 25 members
// precisely so nobody hit the wall. That is the wrong end of the problem — this
// job is the right end, and the cap is gone.
//
// Idempotent by construction. `convertItem` returns immediately for an item
// that already has a team member, and replays a stored distillation rather than
// paying for it again, so a re-run costs nothing for work already done.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { sourceMigrationRepository as repo } from '../source-migrations/repository';
import { sourceMigrationService } from '../source-migrations/service';

export const sourceMigrationResumeSweepRouter = Router();

/** Migrations touched per run. The sweep is frequent, so this bounds one run's
 *  work rather than the total: what it does not reach, the next run does. */
const MAX_MIGRATIONS_PER_RUN = 25;

sourceMigrationResumeSweepRouter.post(
  '/source-migration-resume-sweep',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;

    const started = Date.now();
    let resumed = 0;
    let failed = 0;

    let candidates: Array<{ id: string; tenantId: string; accountId: string | null }> = [];
    try {
      candidates = await repo.listMigrationsWithPendingItems(MAX_MIGRATIONS_PER_RUN);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'source-migration-resume-sweep: could not read pending migrations',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    for (const candidate of candidates) {
      // An import made before the importer was recorded has no account. It
      // cannot be resumed on that person's behalf, and guessing one would run
      // somebody's conversion under another member's identity.
      if (!candidate.accountId) {
        log.warn(
          { migrationId: candidate.id, tenantId: candidate.tenantId },
          'source-migration-resume-sweep: skipped a migration with no importer recorded',
        );
        continue;
      }

      try {
        // No identity selection: resuming means finishing what was already
        // selected, and re-selecting here would convert members the person
        // deselected.
        await sourceMigrationService.resumePendingItems(
          candidate.tenantId,
          candidate.accountId,
          candidate.id,
        );
        resumed += 1;
      } catch (error) {
        failed += 1;
        log.error(
          {
            migrationId: candidate.id,
            tenantId: candidate.tenantId,
            error: (error as Error).message,
          },
          'source-migration-resume-sweep: could not resume a migration',
        );
      }
    }

    // Reported on every run, including the empty one. A sweep that only speaks
    // when it acts is indistinguishable from a sweep that has stopped running.
    log.info(
      { candidates: candidates.length, resumed, failed, durationMs: Date.now() - started },
      'source-migration-resume-sweep: complete',
    );

    res.json({ candidates: candidates.length, resumed, failed });
  },
);
