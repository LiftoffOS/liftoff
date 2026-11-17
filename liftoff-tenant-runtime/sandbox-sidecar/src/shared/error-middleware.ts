import type { Request, Response, NextFunction } from 'express';
import { SandboxApiError } from './errors';
import { logger } from './logger';

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof SandboxApiError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ msg: 'unhandled error', err: message });
  res.status(500).json({ error: 'internal_error', message });
}

/**
 * Wrap an async express route handler so rejected promises bubble to next().
 * The wrapped function receives the standard (req, res, next) triple.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
