const SENSITIVE_PARAMS = new Set([
  'email', 'mail', 'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'key', 'password', 'pwd', 'pass', 'secret',
  'auth', 'authorization', 'session', 'sid', 'jwt',
  'code', 'signature', 'sig', 'hmac', 'ssn', 'phone', 'tel',
]);

export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) u.searchParams.set(key, '[REDACTED]');
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    return u.toString();
  } catch {
    return '[INVALID_URL]';
  }
}
