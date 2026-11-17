// Claude Code Proxy Origin Guard
// Blocks browser-originated CSRF requests to the /proxy/* path.

import type { Request, Response, NextFunction } from 'express';

function anthropicError(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({
    type: 'error',
    error: { type, message },
  });
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.origin) {
    anthropicError(res, 403, 'authentication_error', 'Browser requests are not allowed');
    return;
  }
  next();
}
