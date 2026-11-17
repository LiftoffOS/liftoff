// The frontend's base URL, in one place.
//
// Every link this service sends to a person — an unsubscribe link, a settings
// link, a notification destination, the origin a browser push is scoped to —
// has to agree on where the app lives. They did not: notifications/email.ts and
// notifications/unsubscribe.ts read FRONTEND_URL, while notifications/router.ts
// read DASHBOARD_BASE_URL, which is set in neither Cloud Run service and
// appears nowhere in Terraform. The result was silent: `eventLink` resolved to
// undefined on every escalation, so those emails shipped with no link to the
// thing they were about and nothing ever errored.
//
// FRONTEND_URL is the variable that actually exists, set per deployment by
// terraform and in .env.example for local development.
//
// It has NO default, and that is deliberate. A default is the same silent
// failure in a different coat: every link in every email, notification and
// share would resolve against a host this deployment does not own, each one
// well-formed, none of them reaching the app. Nothing errors, because a URL
// that points elsewhere is still a URL. Unset is therefore a configuration
// error and says so on the first link built.
//
// Lazy, for the reason unsubscribe.ts gives: reading at call time lets tests
// override per-call and cannot capture an empty string at module load.

/** Base URL of the frontend, no trailing slash. Throws when FRONTEND_URL is unset. */
export function frontendUrl(): string {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) {
    throw new Error(
      'FRONTEND_URL is unset, so no link to the app can be built. Set it to the base URL ' +
      'this deployment serves the frontend from (e.g. https://liftoff.example.com, or ' +
      'http://localhost:5173 for local development) — see .env.example.',
    );
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * The origin browser push tokens are scoped to.
 *
 * Two deployments that share one Firebase project mint push tokens the sender
 * cannot tell apart, so the origin is recorded alongside each token and matched
 * on send. That is what stops a staging or local run from reaching somebody's
 * real device.
 *
 * Returns null when FRONTEND_URL is unset or holds something that is not a URL,
 * which disables push rather than guessing.
 */
export function frontendOrigin(): string | null {
  try {
    return new URL(frontendUrl()).origin;
  } catch {
    return null;
  }
}
