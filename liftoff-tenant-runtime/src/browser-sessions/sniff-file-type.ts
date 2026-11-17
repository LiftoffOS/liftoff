// What a file's BYTES say it is, as opposed to what it was called.
//
// A download's type came from its name, and a name is chosen by the site. A
// generator that has run out of free credits answers its own download control
// with its rate-limit page, served as an attachment called clip.mp4, and every
// layer after that treats it as a video: the type is right there in the
// filename, and nothing looks inside. The person is handed an HTML error page
// as their video, and told it is their video.
//
// So the label has to AGREE with the container the bytes are in. This reads the
// first few bytes, names the container, and answers with the types that
// container can legitimately hold.
//
// A container check, not a parse. Two of the pairs are genuinely one container
// — video/mp4 and audio/mp4 are both ISO-BMFF, video/webm and audio/webm both
// Matroska — and separating those needs a demuxer. Where the container agrees,
// the label may choose between the types it can hold.
//
// The control plane carries the same table for inbound media
// (`src/media/sniff-media-type.ts` there). Kept separate rather than shared
// because a shared package is a four-repo landing, and this one answers a
// different question: that one admits or refuses an upload, this one corrects
// a claim about a file already in hand.

interface Signature {
  magic: number[];
  offset: number;
  /** A second run of bytes, for containers whose brand sits past the magic. */
  also?: { magic: number[]; offset: number };
  types: readonly string[];
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: Signature[] = [
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, types: ['image/png'] },
  // SOI plus the first marker. The fourth byte varies by encoder, so three is
  // the honest length.
  { magic: [0xff, 0xd8, 0xff], offset: 0, types: ['image/jpeg'] },
  { magic: ascii('GIF87a'), offset: 0, types: ['image/gif'] },
  { magic: ascii('GIF89a'), offset: 0, types: ['image/gif'] },
  // RIFF is also WAV, so the brand at 8 is what makes it WebP.
  { magic: ascii('RIFF'), offset: 0, also: { magic: ascii('WEBP'), offset: 8 }, types: ['image/webp'] },
  { magic: ascii('RIFF'), offset: 0, also: { magic: ascii('WAVE'), offset: 8 }, types: ['audio/wav', 'audio/x-wav'] },
  { magic: ascii('RIFF'), offset: 0, also: { magic: ascii('AVI '), offset: 8 }, types: ['video/x-msvideo'] },
  // ISO base media. The size occupies 0-3, so the box type is at 4.
  { magic: ascii('ftyp'), offset: 4, types: ['video/mp4', 'audio/mp4', 'video/quicktime'] },
  { magic: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, types: ['video/webm', 'audio/webm', 'video/x-matroska'] },
  { magic: ascii('OggS'), offset: 0, types: ['audio/ogg', 'video/ogg'] },
  { magic: ascii('ID3'), offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xfb], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xf3], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xf2], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xe3], offset: 0, types: ['audio/mpeg'] },
  { magic: ascii('%PDF-'), offset: 0, types: ['application/pdf'] },
  // ZIP, and everything built on it: a document, a spreadsheet, a plain
  // archive. Which one it is lives inside, so the container admits them all.
  {
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    types: [
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/epub+zip',
    ],
  },
  { magic: [0x50, 0x4b, 0x05, 0x06], offset: 0, types: ['application/zip'] },
  { magic: [0x1f, 0x8b], offset: 0, types: ['application/gzip', 'application/x-gzip'] },
  { magic: ascii('%!PS'), offset: 0, types: ['application/postscript'] },
];

function matches(bytes: Buffer, sig: Signature): boolean {
  const at = (magic: number[], offset: number): boolean => {
    if (bytes.length < offset + magic.length) return false;
    for (let i = 0; i < magic.length; i += 1) {
      if (bytes[offset + i] !== magic[i]) return false;
    }
    return true;
  };
  if (!at(sig.magic, sig.offset)) return false;
  return sig.also ? at(sig.also.magic, sig.also.offset) : true;
}

/** True when the bytes begin as markup — the shape of a site answering a
 *  download with a login, a paywall or a rate-limit page. Leading whitespace
 *  and a BOM are skipped, because a served page often carries them. */
export function looksLikeMarkup(bytes: Buffer): boolean {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  const head = bytes.subarray(i, i + 15).toString('ascii').toLowerCase();
  return head.startsWith('<!doctype html')
    || head.startsWith('<html')
    || head.startsWith('<?xml')
    || head.startsWith('<head')
    || head.startsWith('<body');
}

/** The types the bytes could legitimately be called, or null when no container
 *  here recognises them. Null is "not one of the kinds we can vouch for", not
 *  "fine". */
export function sniffFileTypes(bytes: Buffer): readonly string[] | null {
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig)) return sig.types;
  }
  return null;
}

export interface TypeVerdict {
  /** The type to hand over: the claim when the bytes bear it out, otherwise
   *  what they actually are, otherwise a plain file. */
  contentType: string;
  /** What is wrong, in words for the person, when the claim did not hold.
   *  Empty when it did, or when nothing could be told either way. */
  concern: string;
}

/** A type nothing can be said about: no container claim to contradict. */
const UNTYPED = 'application/octet-stream';

/**
 * Hold a file's claimed type against its bytes.
 *
 * Three answers, and only one of them is a correction:
 *  - the bytes bear the claim out, and it stands;
 *  - the bytes are a container we know, and it is not the one claimed: the
 *    claim is replaced by what they are, and the difference is said out loud;
 *  - nothing recognises the bytes: the claim is dropped to a plain file, and
 *    said out loud only when the bytes look like markup — a page served in
 *    place of a file, which is the failure worth naming. Anything else
 *    unrecognised is left quiet, because most of what people download is a
 *    kind this table has never heard of.
 */
export function verifyClaimedType(bytes: Buffer, claimed: string, filename: string): TypeVerdict {
  const claim = (claimed || '').split(';')[0].trim().toLowerCase();
  const actual = sniffFileTypes(bytes);
  if (actual && claim && actual.includes(claim)) return { contentType: claim, concern: '' };
  const named = filename || 'the file';
  if (actual) {
    return {
      contentType: actual[0],
      concern: claim
        ? `${named} is not ${claim}. Its contents are ${actual[0]}.`
        : `${named} is ${actual[0]}.`,
    };
  }
  if (looksLikeMarkup(bytes)) {
    return {
      contentType: 'text/html',
      concern: `${named} is a web page, not ${claim || 'a file'}. The site answered the download with a page of its own, `
        + 'which usually means a sign-in, a paywall or a limit was reached rather than the file being ready.',
    };
  }
  // Unrecognised and not markup: no claim can be made either way, so the type
  // stops asserting one. A file downloads cleanly as a plain file and does not
  // render inline, which is the safe way to be wrong.
  return { contentType: claim && claim !== 'text/html' ? claim : UNTYPED, concern: '' };
}
