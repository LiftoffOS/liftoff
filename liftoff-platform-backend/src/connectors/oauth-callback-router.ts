import { Router } from 'express';
import { createConnectorsProxyRouter } from './proxy';

// OAuth callbacks arrive as browser redirects from the provider — no Firebase
// Bearer token is present. Forward to connector-service which validates the
// request via the state parameter it issued during the OAuth start flow.
const proxy = createConnectorsProxyRouter();
const oauthCallbackRouter = Router();
oauthCallbackRouter.get('/oauth/callback', (req, res, next) => proxy(req, res, next));

export { oauthCallbackRouter as connectorOAuthCallbackRouter };
