import { registerOAuthRefreshHandler, registerOAuthRevocationHandler } from '../service.js';
import { OAUTH_PROVIDER_CONFIGS } from '../../types.js';

registerOAuthRefreshHandler('meta_ads', async ({ refreshToken }) => {
  // refreshToken is the long-lived access_token stored during the initial OAuth exchange.
  // fb_exchange_token requires the current long-lived token and issues a fresh 60-day one.
  const config = OAUTH_PROVIDER_CONFIGS['meta'];
  const clientId = process.env[config.clientIdEnvVar];
  const clientSecret = process.env[config.clientSecretEnvVar];
  if (!clientId || !clientSecret) throw new Error('meta: META_CLIENT_ID or META_CLIENT_SECRET not configured');

  const resp = await fetch(
    `https://graph.facebook.com/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: refreshToken,
      }),
  );
  const data = (await resp.json()) as { access_token?: string; expires_in?: number; error?: unknown };
  if (!data.access_token) throw new Error(`meta: token renewal failed: ${JSON.stringify(data.error)}`);

  return {
    accessToken: data.access_token,
    refreshToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 5184000) * 1000).toISOString(),
  };
});

// Called by revokeCredentials() before the DB row is deleted — token is still in SM at this point.
registerOAuthRevocationHandler('meta_ads', async ({ accessToken }) => {
  await fetch(
    `https://graph.facebook.com/v21.0/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
    { method: 'DELETE' },
  );
  // Non-fatal: if token is already expired/invalid, Meta returns an error but our cleanup proceeds.
});
