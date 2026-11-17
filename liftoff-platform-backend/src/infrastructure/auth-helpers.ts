// Auth Helpers
// Per Phase 0.3: SE-003, SE-004, SE-008, SE-009, TE-003, BE-P2-003
// Create reusable helper to extract authenticated user ID from request context

import { Request } from 'express';

/**
 * Custom error class for authentication failures
 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Get the authenticated user ID from the request context.
 * This should be used instead of reading x-user-id headers directly.
 *
 * Per Phase 0.3: Replace all req.headers['x-user-id'] usages with this helper
 * to prevent header spoofing vulnerabilities.
 *
 * @param req - Express request object
 * @returns The authenticated user's Firebase UID
 * @throws UnauthorizedError if no authenticated user
 */
export function getAuthenticatedUserId(req: Request): string {
  if (!req.ctx?.userId) {
    throw new UnauthorizedError('No authenticated user');
  }
  return req.ctx.userId;
}

/**
 * Get the authenticated user ID from the request context, returning null if not authenticated.
 * Use this variant when authentication is optional.
 *
 * @param req - Express request object
 * @returns The authenticated user's Firebase UID or null
 */
export function getOptionalAuthenticatedUserId(req: Request): string | null {
  return req.ctx?.userId || null;
}

/**
 * Type guard to check if a value is an UnauthorizedError
 */
export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}
