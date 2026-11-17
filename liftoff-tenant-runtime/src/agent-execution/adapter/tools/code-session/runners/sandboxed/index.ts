// The sandboxed runner family.
//
// One runner per vendor, same `CodeSessionRunner` interface as the in-process
// family, selected by the same provider resolution. Which family the handler
// picks follows the WORKSPACE, not a second flag: a sandboxed runner drives a
// CLI through the workspace, and an in-process runner links a vendor SDK that
// spawns in this container. Running an in-process runner against a sandbox
// workspace would put the coding agent and its checkout in different
// containers, and the session would end with an empty diff and no error.

import { SandboxedAnthropicCodeSessionRunner } from './claude';
import { SandboxedOpenAICodeSessionRunner, SandboxedOpenRouterCodeSessionRunner } from './codex';
import { SandboxedGeminiCodeSessionRunner } from './gemini';
import type { CodeSessionProvider, CodeSessionRunner } from '../../types';

export const SANDBOXED_RUNNERS: Record<CodeSessionProvider, CodeSessionRunner> = {
  anthropic: new SandboxedAnthropicCodeSessionRunner(),
  openai: new SandboxedOpenAICodeSessionRunner(),
  google: new SandboxedGeminiCodeSessionRunner(),
  openrouter: new SandboxedOpenRouterCodeSessionRunner(),
};

export {
  SandboxedAnthropicCodeSessionRunner,
  SandboxedOpenAICodeSessionRunner,
  SandboxedOpenRouterCodeSessionRunner,
  SandboxedGeminiCodeSessionRunner,
};
