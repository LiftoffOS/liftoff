// The browser, as Insights tools.
//
// Thin adapters onto browser-sessions/assistant-tools, which Liftoff also uses.
// The definitions and the behaviour live there so the two platform assistants
// offer the SAME browser: a person who asks the Insights Manager to open a page
// should get what Liftoff would have given them, and two copies of these tool
// descriptions would drift the moment either was edited.
//
// What is local to Insights is the plumbing it already has: the registry, the
// role matrix, and a context that names the thread.

import {
  BROWSER_ASSISTANT_TOOLS,
  executeBrowserAssistantTool,
} from '../../browser-sessions/assistant-tools';
import type { InsightsTool, InsightsToolContext } from './types';

/** One InsightsTool per shared browser tool.
 *
 *  The executor returns prose rather than a data object, which is unlike the
 *  analytics tools around it. That is deliberate: a browser answers in what
 *  happened ("the browser is now on X, and the person can see it"), and
 *  wrapping that in a result envelope only to have the model unwrap it adds a
 *  shape without adding meaning. */
export const browserInsightsTools: InsightsTool[] = BROWSER_ASSISTANT_TOOLS.map(
  (definition): InsightsTool => ({
    definition,
    async execute(input: Record<string, unknown>, ctx: InsightsToolContext) {
      if (!ctx.threadId) {
        // Every chat turn has a thread. A tool call arriving without one means
        // the context was assembled somewhere that does not know about the
        // browser, and opening an unattached session would put a browser on
        // screen for nobody.
        return { message: 'A browser can only be opened inside a conversation.' };
      }
      const message = await executeBrowserAssistantTool(definition.name, input, {
        tenantId: ctx.tenantId,
        threadId: ctx.threadId,
        surface: 'insights',
        senderAccountId: ctx.accountId,
      });
      return { message };
    },
  }),
);
