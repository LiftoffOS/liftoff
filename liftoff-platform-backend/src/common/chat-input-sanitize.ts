// Chat input sanitization for this service's chat routers.
//
// The implementation lives in @liftoffos/service-runtime so platform-backend
// and workforce-service share one function rather than two same-named copies
// that drifted apart (one escaped HTML, one did not, and no call site showed
// which you had). This file exists so the existing imports across
// src/liftoff/* and src/insights/* keep working unchanged.
//
// See the package module for why nothing here HTML-escapes any more: the short
// version is that encoding at the boundary put "What&#39;s the best beer
// garden" in the database and in the model prompt. Encode for the sink, at the
// sink.

export {
  stripControlChars,
  sanitizeChatMessageContent,
} from '@liftoffos/service-runtime';
