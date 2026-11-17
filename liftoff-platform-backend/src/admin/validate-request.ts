// validateRequest — Express middleware factory.
//
// Per PR 0 conventions: Zod handles request *shape* (types, required fields,
// UUID/format validation, enums). Handlers retain *business-invariant* checks
// (e.g. "this account has no stripe_customer_id" → 409). Pure shape validation
// in handlers is removed during the PR 0 refactor.
//
// On Zod failure the middleware emits 400 + the standard `adminError`
// envelope, including the Zod issue path so curl users see which field
// is wrong. Successful parses attach the typed result to req.validated.

import { Request, Response, NextFunction } from 'express';
import { z, ZodTypeAny } from 'zod';
import { log } from '../infrastructure/logging';
import { adminError } from './conventions';

export interface AdminValidatedSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

export interface ValidatedRequest<S extends AdminValidatedSchemas> extends Request {
  validated: {
    body: S['body'] extends ZodTypeAny ? z.infer<S['body']> : undefined;
    params: S['params'] extends ZodTypeAny ? z.infer<S['params']> : undefined;
    query: S['query'] extends ZodTypeAny ? z.infer<S['query']> : undefined;
  };
}

function formatPath(path: (string | number)[]): string {
  return path.map((p) => String(p)).join('.');
}

function firstIssue(err: z.ZodError): { field: string; detail: string } {
  const issue = err.issues[0];
  return {
    field: formatPath(issue.path),
    detail: issue.message,
  };
}

export function validateRequest<S extends AdminValidatedSchemas>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const validated: {
      body?: unknown;
      params?: unknown;
      query?: unknown;
    } = {};

    if (schema.body) {
      const result = schema.body.safeParse(req.body);
      if (!result.success) {
        const { field, detail } = firstIssue(result.error);
        log.info(
          { msg: 'admin.api.validation_failed', where: 'body', field, detail, path: req.originalUrl },
          'admin api request validation failed',
        );
        res.status(400).json(adminError('invalid_request', detail, field));
        return;
      }
      validated.body = result.data;
      // Replace req.body with the parsed result so Zod defaults / coercions
      // are visible to handlers that read `req.body` directly (which every
      // current admin handler does). Without this, e.g.
      // `cancelExistingSubscription: z.boolean().default(true)` would never
      // reach the handler — the default would sit silently on
      // req.validated.body and the handler's `body.cancelExistingSubscription`
      // would be undefined → silently skip the step.
      req.body = result.data;
    }
    if (schema.params) {
      const result = schema.params.safeParse(req.params);
      if (!result.success) {
        const { field, detail } = firstIssue(result.error);
        log.info(
          { msg: 'admin.api.validation_failed', where: 'params', field, detail, path: req.originalUrl },
          'admin api request validation failed',
        );
        res.status(400).json(adminError('invalid_request', detail, field));
        return;
      }
      validated.params = result.data;
      // Same reasoning — keep req.params in sync with the parsed result so
      // schema-driven coercions (e.g. z.coerce.number()) reach the handler.
      // Express types req.params as Record<string,string>, so assign per key
      // rather than replacing the object reference.
      for (const [k, v] of Object.entries(result.data as Record<string, unknown>)) {
        (req.params as Record<string, unknown>)[k] = v;
      }
    }
    if (schema.query) {
      const result = schema.query.safeParse(req.query);
      if (!result.success) {
        const { field, detail } = firstIssue(result.error);
        log.info(
          { msg: 'admin.api.validation_failed', where: 'query', field, detail, path: req.originalUrl },
          'admin api request validation failed',
        );
        res.status(400).json(adminError('invalid_request', detail, field));
        return;
      }
      validated.query = result.data;
    }

    (req as Request & { validated: typeof validated }).validated = validated;
    next();
  };
}
