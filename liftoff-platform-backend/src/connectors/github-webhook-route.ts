// The one GitHub App route that must NOT require a Liftoff bearer token.
//
// GitHub's servers post here. They carry `X-Hub-Signature-256` and no Firebase
// credential, so the ordinary auth middleware rejects every delivery with
// "Missing or invalid authorization header" — a response byte-identical to the
// one a completely unproxied path returns, which is how this would have gone
// unnoticed.
//
// WHY THAT MATTERS MORE HERE THAN FOR MOST WEBHOOKS. When the person connecting
// is not an owner of the organization, GitHub records a REQUEST rather than an
// installation. An owner approves it later, in a different browser, as a
// different person. `installation.created` is the ONLY signal that it ever
// happened. A silently-rejected webhook therefore does not degrade the feature,
// it strands it: the card stays pending forever and nothing anywhere says why.
//
// Authenticity is proven downstream, by connector-service recomputing the HMAC
// over the raw body — the same division the OAuth callback router uses, where
// the state parameter it issued is the proof rather than a bearer token.
//
// THE BYTES MUST SURVIVE. This is mounted before `express.json()` with
// `express.raw()`, alongside the Stripe, Standard-Webhooks and Knowledge
// webhook mounts, for the same reason they are: a parsed-and-re-serialized body
// produces a different digest and every signature check fails.

import { Router } from 'express';
import { createConnectorsProxyRouter } from './proxy';

const proxy = createConnectorsProxyRouter();
const githubWebhookRoute = Router();

githubWebhookRoute.post('/github/webhook', (req, res, next) => proxy(req, res, next));

export { githubWebhookRoute as connectorGithubWebhookRouter };
