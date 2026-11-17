import { SANDBOX_ERROR_CODES, SandboxErrorCode } from '@liftoffos/sandbox-contracts';

export class SandboxApiError extends Error {
  public readonly code: SandboxErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: SandboxErrorCode, status: number, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class UnauthorizedError extends SandboxApiError {
  constructor(message = 'unauthorized') {
    super(SANDBOX_ERROR_CODES.UNAUTHORIZED, 401, message);
  }
}

export class TicketExpiredError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.TICKET_EXPIRED, 401);
  }
}

export class SessionExitedError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.SESSION_EXITED, 410);
  }
}

export class SessionNotFoundError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.SESSION_NOT_FOUND, 404);
  }
}

export class TabNotFoundError extends SandboxApiError {
  constructor(tabId: string) {
    super(SANDBOX_ERROR_CODES.TAB_NOT_FOUND, 404, `tab not found: ${tabId}`);
  }
}

export class TabBusyError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.TAB_BUSY, 429);
  }
}

export class WatcherNotFoundError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.WATCHER_NOT_FOUND, 404);
  }
}

export class RouteNotFoundError extends SandboxApiError {
  constructor() {
    super(SANDBOX_ERROR_CODES.ROUTE_NOT_FOUND, 404);
  }
}

export class FileTooLargeError extends SandboxApiError {
  constructor(maxBytes: number) {
    super(SANDBOX_ERROR_CODES.FILE_TOO_LARGE, 413, undefined, { max_bytes: maxBytes });
  }
}

export class WorkspaceFullError extends SandboxApiError {
  constructor(freeBytes: number) {
    super(SANDBOX_ERROR_CODES.WORKSPACE_FULL, 507, undefined, { freeBytes });
  }
}
