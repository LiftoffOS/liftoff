// A request with no body is not a JSON request, whatever its Content-Type says.
//
// The web app's apiFetch sends `Content-Type: application/json` on every call,
// a body-less DELETE included, and Fastify refuses that pairing before any
// route runs (400 FST_ERR_CTP_EMPTY_JSON_BODY). So "Disable" on auto-reload
// failed without ever reaching its handler. Dropping the header when nothing
// follows it lets the request through as the body-less request it is; a
// request that does carry a body is parsed exactly as before.

import type { FastifyInstance } from 'fastify';

export function ignoreContentTypeWithoutBody(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const length = req.headers['content-length'];
    const chunked = req.headers['transfer-encoding'] !== undefined;
    if (!chunked && (length === undefined || length === '0')) {
      delete req.headers['content-type'];
    }
  });
}
