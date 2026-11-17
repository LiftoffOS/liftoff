import type { Dispatcher } from './types';
import { shellDispatcher } from './shell-dispatcher';
import { fileDispatcher } from './file-dispatcher';
import { bashDispatcher } from './bash-dispatcher';
import { nodejsDispatcher } from './nodejs-dispatcher';
import { codeDispatcher } from './code-dispatcher';
import { utilDispatcher } from './util-dispatcher';
import { browserActionDispatcher } from './browser-action-dispatcher';
import { browserStateDispatcher } from './browser-state-dispatcher';
import { browserNetworkDispatcher } from './browser-network-dispatcher';
import { browserCaptchaDispatcher } from './browser-captcha-dispatcher';
import { proxyDispatcher } from './proxy-dispatcher';
import { sandboxMetaDispatcher } from './sandbox-meta-dispatcher';
import { mcpDispatcher } from './mcp-dispatcher';

export const ALL_DISPATCHERS: Dispatcher[] = [
  shellDispatcher,
  fileDispatcher,
  bashDispatcher,
  nodejsDispatcher,
  codeDispatcher,
  utilDispatcher,
  browserActionDispatcher,
  browserStateDispatcher,
  browserNetworkDispatcher,
  browserCaptchaDispatcher,
  proxyDispatcher,
  sandboxMetaDispatcher,
  mcpDispatcher,
];

export function findDispatcher(toolName: string): Dispatcher | undefined {
  return ALL_DISPATCHERS.find(d => d.supports(toolName));
}

export type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';
