// What a platform assistant's turn says when it finished and said nothing.
//
// LAST RESORT ONLY. Not the intended way a finished turn is reported: the right
// answer is for the assistant to reply itself, saying what it did. This exists
// to keep one durability promise, and the promise is the whole reason it is
// worth a shared module rather than a string in each service.
//
// A thread is the only place a person looks. "No reply" and "never ran" are
// indistinguishable there, so a turn that persists an EMPTY assistant row is
// not meaningfully better than one that persists no row: both render as a
// conversation that stops. An assistant that writes `content: finalText`
// straight through leaves an empty bubble in the transcript, with nothing to
// say why, whenever a turn ends without prose.
//
// The tenant runtime already made this promise for team agents, in
// interactive-chat/chat-turn-handler.ts, and the text is deliberately identical:
// a person moving between a team's chat and a platform assistant must not be
// shown two different accounts of the same ending.
//
// A turn the PERSON stopped is not this case and must not use it (ADR-041).
// Nothing is invented there: the assistant never spoke, and writing a marker
// into the content would put words in its mouth. Those paths yield a terminal
// frame carrying no message and persist nothing, which is correct.
//
// Product voice: no em dashes, no contractions, does not say "agent".
export const COMPLETED_WITHOUT_REPLY = 'Done.';
