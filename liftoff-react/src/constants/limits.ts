/**
 * Character limits for agent fields
 * Must match backend validation in router.ts
 */
export const TEAM_LIMITS = {
  ROLE_MAX: 255,
  RESPONSIBILITIES_MAX: 10_000,
  ADDITIONAL_CONTEXT_MAX: 10_000,
  SYSTEM_PROMPT_MAX: 50_000,
  USER_INSTRUCTIONS_MAX: 50_000,
} as const
