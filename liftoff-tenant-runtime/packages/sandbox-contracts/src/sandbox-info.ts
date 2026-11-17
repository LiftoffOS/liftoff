// Sandbox info contract types

export type SandboxCapability = 'shell' | 'file' | 'browser' | 'vscode';

export interface SandboxInfo {
  sandbox_id: string;
  version: string;
  capabilities: SandboxCapability[];
  cdp_url: string;
  vscode_url: string;
  vnc_url: string;
  uptime_ms: number;
}

export interface SandboxContextResponse {
  sandbox_id: string;
  capabilities: SandboxCapability[];
  workspace_size_bytes: number;
  workspace_free_bytes: number;
  uptime_ms: number;
  env_summary: {
    NODE_VERSION: string;
    PYTHON_VERSION: string;
    PLAYWRIGHT_VERSION: string;
    OPENVSCODE_VERSION: string;
  };
}

export interface SandboxPackagesResponse {
  packages: Array<{ name: string; version: string }>;
}

export interface SandboxRestartResponse {
  success: boolean;
  restarted_programs: string[];
}
