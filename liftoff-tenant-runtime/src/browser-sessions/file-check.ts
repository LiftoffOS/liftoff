// Is the file that came back the file that was asked for?
//
// A fetch that returns bytes is not a fetch that returned the RIGHT bytes. A
// site that wants a sign-in answers a download with its login page; one that
// rate-limits answers with an error page; a link that expired answers with a
// few hundred bytes of JSON. All three are a successful HTTP response, and
// all three used to reach the person as "here is your file".
//
// Two checks, in order, because they answer different questions.
//
//   WHAT IT IS.  The bytes are read for the container they are actually in
//                and compared with the type the server claimed. A PDF that
//                is really HTML is an error page wearing a filename. This is
//                arithmetic and it is certain, but it only covers containers
//                with a signature to read.
//
//   WHETHER IT IS THE ONE ASKED FOR.  A model that answers in milliseconds
//                is shown what the task wanted and what arrived — the name,
//                the type, the size, and for a text-shaped file its opening
//                words — and asked whether this is plausibly that file. It
//                catches what no signature can: the right container holding
//                the wrong thing, which is what a login page served as HTML
//                to a request for a report actually is.
//
// It never blocks on its own uncertainty. A file the check cannot judge is
// delivered with nothing said, because refusing to hand over a file on a
// vendor timeout would be worse than the defect being guarded against.

import { sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import { asEntry, FILE_CHECK_SET, FILE_CHECK_SAMPLE_MAX_CHARS } from '../typesafe/questions';

/** How long the judgement may take. Past this the file is handed over: a
 *  check that could not run knows nothing. */
export const FILE_CHECK_TIMEOUT_MS = 5_000;

/** Bytes read to identify the container. */
const SNIFF_BYTES = 16;

/** Characters of a text-shaped file put to the model. Enough to tell a
 *  report from a sign-in page. */
const SAMPLE_CHARS = FILE_CHECK_SAMPLE_MAX_CHARS;

export interface FileCheckInput {
  /** What the task was trying to get. */
  objective: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  tenantId: string;
  runtimeAgentId?: string;
  invocationId?: string;
}

export interface FileCheckVerdict {
  /** False only when something is positively wrong. Unknown reads as true. */
  looksRight: boolean;
  /** What is wrong, model-facing, when it is not. */
  concern: string;
}

const OK: FileCheckVerdict = { looksRight: true, concern: '' };

/** Container signatures, for the types a browser actually hands back. A
 *  container with no signature here is not judged on its bytes. */
const SIGNATURES: Array<{ magic: number[]; offset: number; family: string }> = [
  { magic: [0x25, 0x50, 0x44, 0x46], offset: 0, family: 'pdf' },                          // %PDF
  { magic: [0x89, 0x50, 0x4e, 0x47], offset: 0, family: 'png' },
  { magic: [0xff, 0xd8, 0xff], offset: 0, family: 'jpeg' },
  { magic: [0x47, 0x49, 0x46, 0x38], offset: 0, family: 'gif' },                           // GIF8
  { magic: [0x52, 0x49, 0x46, 0x46], offset: 0, family: 'riff' },                          // webp/wav
  { magic: [0x66, 0x74, 0x79, 0x70], offset: 4, family: 'isobmff' },                       // mp4/m4a
  { magic: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, family: 'matroska' },                      // webm
  { magic: [0x49, 0x44, 0x33], offset: 0, family: 'mp3' },
  { magic: [0x50, 0x4b, 0x03, 0x04], offset: 0, family: 'zip' },                           // zip, docx, xlsx…
  { magic: [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45], offset: 0, family: 'html' }, // <!DOCTYPE
  { magic: [0x3c, 0x68, 0x74, 0x6d, 0x6c], offset: 0, family: 'html' },                    // <html
  { magic: [0x3c, 0x48, 0x54, 0x4d, 0x4c], offset: 0, family: 'html' },
];

/** Which container family a content type belongs to, or '' when the type has
 *  no signature worth checking (text, csv, json and friends). */
function familyOf(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (t === 'image/png') return 'png';
  if (t === 'image/jpeg') return 'jpeg';
  if (t === 'image/gif') return 'gif';
  if (t === 'image/webp' || t === 'audio/wav') return 'riff';
  if (t === 'video/mp4' || t === 'audio/mp4') return 'isobmff';
  if (t === 'video/webm' || t === 'audio/webm') return 'matroska';
  if (t === 'audio/mpeg') return 'mp3';
  if (t === 'application/zip' || t.includes('openxmlformats')) return 'zip';
  if (t === 'text/html') return 'html';
  return '';
}

/** The container the bytes are actually in, or '' when unrecognised. */
export function containerOf(bytes: Buffer): string {
  const head = bytes.subarray(0, SNIFF_BYTES);
  for (const sig of SIGNATURES) {
    if (head.length < sig.offset + sig.magic.length) continue;
    if (sig.magic.every((b, i) => head[sig.offset + i] === b)) return sig.family;
  }
  return '';
}

/** Whether the file reads as text, and so can be shown to the model. */
function textSample(bytes: Buffer, contentType: string): string {
  const t = contentType.toLowerCase();
  const textish = t.startsWith('text/') || t.includes('json') || t.includes('xml') || t.includes('csv') || t === '';
  if (!textish) return '';
  const head = bytes.subarray(0, SAMPLE_CHARS * 2).toString('utf8');
  // A buffer that decodes to replacement characters is not text whatever the
  // label says.
  if (head.includes('�')) return '';
  return head.slice(0, SAMPLE_CHARS);
}

/**
 * Check a file before it is handed to a person.
 *
 * Structure first, because it is certain. A container that disagrees with
 * the declared type is reported without asking anybody.
 */
export async function checkFetchedFile(input: FileCheckInput): Promise<FileCheckVerdict> {
  if (input.bytes.byteLength === 0) {
    return { looksRight: false, concern: 'that file came back empty' };
  }

  const declared = familyOf(input.contentType);
  const actual = containerOf(input.bytes);
  if (declared && actual && declared !== actual) {
    // The one that matters in practice: a site answering a download with its
    // sign-in page, which is a valid HTML response to a request for a PDF.
    const concern = actual === 'html'
      ? `the server sent a web page rather than the ${input.contentType} that was asked for, which usually means a sign-in, an expired link or an error page`
      : `the file says it is ${input.contentType} and its contents are not`;
    logger.info(
      { tenantId: input.tenantId, event: 'browser_file_wrong_container', declared, actual },
      'a fetched file is not the kind of file it says it is',
    );
    return { looksRight: false, concern };
  }
  // An HTML body where nothing was declared is the same failure wearing no
  // label, and it is common enough to be worth naming on its own.
  if (!declared && actual === 'html' && !/\.html?$/i.test(input.filename)) {
    return {
      looksRight: false,
      concern: 'the server sent a web page rather than a file, which usually means a sign-in, an expired link or an error page',
    };
  }

  return judge(input);
}

/** The second question, which no signature can answer: is this the file the
 *  task was after? */
async function judge(input: FileCheckInput): Promise<FileCheckVerdict> {
  const objective = sanitizeBrowserText(input.objective, 600).text.trim();
  if (!objective) return OK;
  const sample = textSample(input.bytes, input.contentType);
  try {
    const answered = await ask(
      FILE_CHECK_SET,
      asEntry({
        wanted: objective,
        file: {
          name: sanitizeBrowserText(input.filename, 200).text,
          type: input.contentType,
          size_bytes: input.bytes.byteLength,
          ...(sample ? { opening_text: sanitizeBrowserText(sample, SAMPLE_CHARS).text } : {}),
        },
      }),
      {
        deadlineMs: FILE_CHECK_TIMEOUT_MS,
        tenantId: input.tenantId,
        ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      },
    );
    if (!answered) return OK;
    const probability = Number(answered.answers.is_the_file?.noul);
    if (!Number.isFinite(probability)) return OK;
    const threshold = FILE_CHECK_SET.thresholds.FILE_T as number;
    if (probability >= threshold) return OK;
    logger.info(
      { tenantId: input.tenantId, event: 'browser_file_not_what_was_asked_for', probability, size_bytes: input.bytes.byteLength },
      'a fetched file does not look like the one the task was after',
    );
    return {
      looksRight: false,
      concern: `this does not look like the file that was asked for: ${input.filename || 'it'} is ${input.contentType || 'of no stated type'} and ${input.bytes.byteLength} bytes`,
    };
  } catch (err) {
    // A check that could not run knows nothing. Refusing to hand over a file
    // on a vendor timeout would be worse than the defect being guarded
    // against.
    logger.warn({ err: (err as Error).message, tenantId: input.tenantId }, 'a fetched file could not be checked; handing it over');
    return OK;
  }
}
