// The sender contract on the two assistant-surface repositories, as TypeScript
// sees it. Compiled by append-message-sender.test.ts through the compiler API:
// a `@ts-expect-error` line that stops erroring is itself an error (TS2578),
// so a loosening of either union fails that test. Never imported at runtime.

import type { AppendMessageInput as LiftoffInput } from '../../chat-repository';
import type { AppendMessageInput as InsightsInput } from '../../../insights/chat-repository';

const THREAD = '00000000-0000-0000-0000-000000000100';
const CALLER = '00000000-0000-0000-0000-000000000042';

export const liftoffUser: LiftoffInput = { threadId: THREAD, role: 'user', senderAccountId: CALLER, content: 'x' };
export const liftoffAssistant: LiftoffInput = { threadId: THREAD, role: 'assistant', content: 'y' };
// @ts-expect-error a user message needs its sender
export const liftoffMissing: LiftoffInput = { threadId: THREAD, role: 'user', content: 'z' };
// @ts-expect-error a null sender is not a sender
export const liftoffNull: LiftoffInput = { threadId: THREAD, role: 'user', senderAccountId: null, content: 'z' };
// @ts-expect-error the assistant arm carries no sender
export const liftoffAssistantSender: LiftoffInput = { threadId: THREAD, role: 'assistant', senderAccountId: CALLER, content: 'z' };

export const insightsUser: InsightsInput = { threadId: THREAD, role: 'user', senderAccountId: CALLER, content: 'x' };
export const insightsAssistant: InsightsInput = { threadId: THREAD, role: 'assistant', content: 'y' };
// @ts-expect-error a user message needs its sender
export const insightsMissing: InsightsInput = { threadId: THREAD, role: 'user', content: 'z' };
// @ts-expect-error a null sender is not a sender
export const insightsNull: InsightsInput = { threadId: THREAD, role: 'user', senderAccountId: null, content: 'z' };
// @ts-expect-error the assistant arm carries no sender
export const insightsAssistantSender: InsightsInput = { threadId: THREAD, role: 'assistant', senderAccountId: CALLER, content: 'z' };
