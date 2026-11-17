// @liftoffos/browser-record: the browser record's shapes and its one prose
// renderer, for every host that reads it.
//
// `types.ts` is the wire shapes as they exist (a takeover segment or a point,
// an assistant call, their actions and steps). `prose.ts` phrases them, one
// line each, moved here from workforce-service's work record so the tenant
// runtime, platform-backend and workforce-service render the same row the
// same way. `state-block.ts` is the Browser section every assistant reads at
// the top of a turn, and the two turn texts a hand-back and a point start.

export type {
  RecordedAction,
  RecordedCall,
  RecordedSegment,
  RecordedStep,
  ValueDisposition,
} from './types';
export {
  CALL_STEPS_MAX,
  GAP_PHRASES,
  clock,
  describeAction,
  describeCall,
  describeSegment,
  describeStep,
  gapPhrase,
  quoted,
} from './prose';
export {
  BROWSER_HANDBACK_TURN_TEXT,
  BROWSER_POINT_TURN_TEXT,
  STATE_BLOCK_BOUNDARY,
  STATE_BLOCK_HEADING,
  STATE_BLOCK_MAX_ACTIONS_PER_SEGMENT,
  STATE_BLOCK_MAX_CHARS,
  STATE_BLOCK_MAX_ITEMS,
  STATE_BLOCK_MAX_STEPS_PER_CALL,
  renderBrowserStateBlock,
  type BrowserStateInput,
  type BrowserStateIntervention,
  type BrowserStateItem,
  type BrowserStateSession,
} from './state-block';
