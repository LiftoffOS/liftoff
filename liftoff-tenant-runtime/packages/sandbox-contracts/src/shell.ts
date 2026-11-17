// Shell API contract types
// Mirrors agent-infra/sandbox sdk/js/src/api/resources/shell/types

export interface ShellExecRequest {
  args: string[];
  workDir?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ShellExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellSessionCreateRequest {
  command?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface ShellSessionHandle {
  sessionId: string;
}

export interface ShellSessionDescriptor {
  sessionId: string;
  command: string[];
  cwd: string;
  createdAt: string;
  status: 'active' | 'exited';
  exitCode: number | null;
}

export interface ShellSessionWriteRequest {
  data: string;
}

export interface ShellSessionViewResponse {
  content: string;
  cursor: number;
}

export interface ShellSessionWaitRequest {
  timeout_ms: number;
}

export interface ShellSessionWaitResponse {
  exitCode: number | null;
}

export interface ShellSessionResizeRequest {
  cols?: number;
  rows?: number;
}

export interface ShellSessionStats {
  bytesIn: number;
  bytesOut: number;
  exitCode: number | null;
  ageMs: number;
  status: 'active' | 'exited';
}

export interface TerminalUrlResponse {
  url: string;
}
