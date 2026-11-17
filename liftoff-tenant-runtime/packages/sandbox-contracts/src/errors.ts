// Standardized error envelope returned by all sandbox HTTP endpoints.
// Wire-level contract — runtime parses these via post()/get() helpers.

export interface ErrorEnvelope {
  error: string;
  message?: string;
  details?: Record<string, unknown>;
}

export const SANDBOX_ERROR_CODES = {
  // Auth
  UNAUTHORIZED: 'unauthorized',
  JWT_REJECTED: 'jwt_rejected',
  TICKET_EXPIRED: 'ticket_expired',
  TICKET_NOT_FOUND: 'ticket_not_found',
  // Sessions
  SESSION_EXITED: 'session_exited',
  SESSION_NOT_FOUND: 'session_not_found',
  TAB_NOT_FOUND: 'tab_not_found',
  TAB_BUSY: 'tab_busy',
  WATCHER_NOT_FOUND: 'watcher_not_found',
  ROUTE_NOT_FOUND: 'route_not_found',
  // File ops
  FILE_NOT_FOUND: 'file_not_found',
  FILE_TOO_LARGE: 'file_too_large',
  WORKSPACE_FULL: 'workspace_full',
  PATH_TRAVERSAL: 'path_traversal',
  OLD_STR_NOT_FOUND: 'old_str_not_found',
  OLD_STR_NOT_UNIQUE: 'old_str_not_unique',
  NO_HISTORY: 'no_history',
  FILE_EXISTS: 'file_exists',
  // util
  CONVERSION_FAILED: 'conversion_failed',
  PASSWORD_PROTECTED: 'password_protected',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  UNSUPPORTED_LANGUAGE: 'unsupported_language',
  // Browser
  BROWSER_RESTARTED_STATE_LOST: 'browser_restarted_state_lost',
  // System
  SANDBOX_SHUTTING_DOWN: 'sandbox_shutting_down',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type SandboxErrorCode = typeof SANDBOX_ERROR_CODES[keyof typeof SANDBOX_ERROR_CODES];
