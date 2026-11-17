// Close a proxied stream once its usage record is written, or once
// RECORD_BEFORE_CLOSE_MAX_MS has passed, whichever comes first. The record's
// outcome never reaches the client: a failed write and a slow one both end
// in the same close (INV-DP-005).

export const RECORD_BEFORE_CLOSE_MAX_MS = 5_000;

export async function closeAfter(
  recorded: Promise<unknown>,
  close: () => void,
  maxWaitMs: number = RECORD_BEFORE_CLOSE_MAX_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      recorded.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    close();
  }
}
