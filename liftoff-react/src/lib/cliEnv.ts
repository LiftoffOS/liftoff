// Build the `npx @liftoffos/cli …` setup command for the CURRENT environment.
//
// The CLI defaults to production (example.com / api.example.com), so on prod
// the command is clean. On dev (or any non-prod host) the CLI must be pointed at
// THIS environment, or it authenticates against prod and never finds the setup
// token that was just created here. So we prefix the env vars the CLI reads
// (LIFTOFF_APP_URL for the browser/login host, LIFTOFF_API_URL for the API).
export function cliSetupCommand(subcommand: string): string {
  const base = `npx @liftoffos/cli ${subcommand}`
  const apiUrl = import.meta.env.VITE_API_URL || 'https://api.example.com'
  // Prod: the CLI's built-in defaults already match — keep it clean.
  if (apiUrl.startsWith('https://api.example.com')) return base
  const appUrl = typeof window !== 'undefined' ? window.location.origin : ''
  return `LIFTOFF_API_URL=${apiUrl} LIFTOFF_APP_URL=${appUrl} ${base}`
}

// The one-line prompt a visitor pastes into their own coding agent. The agent
// fetches the Liftoff skill, registers the MCP server, installs the skill
// into its own skill directories and triggers the browser sign-in; the
// sign-in is the only step the person does. The verb is "Set up", not
// "Fetch": a fetch is complete once the file is in context and acting on it
// then rests on the document's own first lines, while a setup is not
// complete until Liftoff is set up, so the tool does not stop at a summary;
// the `.md` address makes retrieving the file the tool's first step either
// way. The address is the SITE's, not
// the API's: nginx on each site host proxies /SKILL.md to that environment's
// API (dev.example.com to api-dev, example.com to api), so the origin the
// page is served from already names the right environment, the URL the tool
// saves and later re-fetches is the site's, and no API host appears on the
// page. The fallback covers rendering without a window (tests).
// Localhost is the one origin with no nginx in front; the vite dev
// server proxies /SKILL.md to VITE_API_URL for it.
export function agentSetupCommand(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://example.com'
  return `Set up ${origin}/SKILL.md`
}
