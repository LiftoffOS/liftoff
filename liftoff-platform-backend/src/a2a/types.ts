// A2A Protocol Types — Google/Linux Foundation standard wire format
// Scope: tenant-scoped only, never public discovery.

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  securitySchemes: {
    serviceToken: {
      type: string;
      in: string;
      name: string;
    };
  };
  skills: AgentCardSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export type A2ATaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed';

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  contextId?: string;
  agentId?: string;
  createdAt?: string;
  updatedAt?: string;
  output?: unknown;
}

export interface A2AMessagePart {
  text: string;
}

export interface A2AMessage {
  role: 'user' | 'agent';
  messageId: string;
  contextId: string;
  parts: A2AMessagePart[];
}

export interface SendMessageRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: 'SendMessage';
  params: {
    message: A2AMessage;
  };
}

export interface GetTaskRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: 'GetTask';
  params: {
    id: string;
  };
}

export interface CancelTaskRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: 'CancelTask';
  params: {
    id: string;
  };
}

// Workflow state → A2A state mapping
export const WORKFLOW_TO_A2A_STATUS: Record<string, A2ATaskStatus> = {
  pending: 'submitted',
  running: 'working',
  awaiting_input: 'input-required',
  awaiting_approval: 'input-required',
  completed: 'completed',
  failed: 'failed',
};
