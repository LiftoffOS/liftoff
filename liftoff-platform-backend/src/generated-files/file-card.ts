// What a file card is, on every surface that can show one.
//
// The shape was already fixed by the two registration routes and by the React
// component that draws it; this gives it a name so a fourth surface cannot
// invent a fifth spelling. It is deliberately small: a card is a handle and the
// words a person reads, never bytes and never a credential.

/** One file, as a person sees it in a conversation. */
export interface FileCard {
  generatedFileId: string;
  filename: string;
  outputType: string;
  version: number;
  /**
   * A download link, or null when there is nothing of ours to download.
   *
   * Load-bearing and explicitly null rather than omitted: the card hides its
   * download button on `=== null`, which is how a file that lives in someone
   * else's cloud storage offers "open it there" instead of a broken save. A
   * URL here is short-lived by construction and the card re-mints its own when
   * a person clicks, so this is a convenience and never the durable reference.
   */
  downloadUrl: string | null;
  /** Where the file lives when it lives in a connected service rather than here. */
  webViewUrl?: string;
}

/**
 * The message type that makes a row a card rather than speech.
 *
 * A row carrying this is not words: it is dropped from the history a model
 * reads, and drawn by the file card instead of the message body.
 */
export const FILE_OUTPUT_MESSAGE_TYPE = 'file_output';
