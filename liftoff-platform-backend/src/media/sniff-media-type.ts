// What the BYTES say they are, as opposed to what the browser claimed.
//
// A multipart part's Content-Type is chosen by the client. On the producer
// route that is tolerable — every producer is one of our own services behind a
// service token — but inbound media arrives from a person's browser, and a
// browser that has been asked nicely will send any Content-Type at all. The
// store's allow-list is what keeps `image/svg+xml` and `text/html` out of a
// bucket whose objects are served back from a URL the browser renders, and an
// allow-list checked only against a client-supplied label is not a check.
//
// So the declared type must AGREE with the container the bytes are actually in.
// This reads the first few bytes, identifies the container, and answers with
// the set of media types that container can legitimately hold.
//
// Deliberately a container check, not a full parse. Two of the allow-listed
// pairs are genuinely the same container — video/webm and audio/webm are both
// Matroska, video/mp4 and audio/mp4 are both ISO-BMFF — and telling them apart
// needs a real demuxer. Where the container is right, the declared type is
// allowed to choose between the types that container can hold: an attacker who
// controls the label can at most make a video play in an <audio> element, which
// is a rendering annoyance rather than a way to get executable markup stored.

/** Container signatures, longest-first where one is a prefix of another. */
interface Signature {
  /** Bytes that must match at `offset`. */
  magic: number[];
  offset: number;
  /** Additional bytes that must match, for containers whose brand sits past
   *  the leading magic (RIFF/WebP). */
  also?: { magic: number[]; offset: number };
  /** The media types this container may legitimately be labelled as. */
  types: readonly string[];
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES: Signature[] = [
  // PNG — the full 8-byte signature, including the CRLF/EOF pair that exists
  // precisely so a corrupted text-mode transfer is detectable.
  {
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
    types: ['image/png'],
  },
  // JPEG — SOI plus the first marker byte. The fourth byte varies by encoder
  // (0xE0 JFIF, 0xE1 Exif, 0xDB raw quantisation tables), so three is the
  // honest length.
  { magic: [0xff, 0xd8, 0xff], offset: 0, types: ['image/jpeg'] },
  { magic: ascii('GIF87a'), offset: 0, types: ['image/gif'] },
  { magic: ascii('GIF89a'), offset: 0, types: ['image/gif'] },
  // WebP is a RIFF container; the four bytes at 8 are what make it WebP rather
  // than a WAV file, so both halves are required.
  {
    magic: ascii('RIFF'),
    offset: 0,
    also: { magic: ascii('WEBP'), offset: 8 },
    types: ['image/webp'],
  },
  // ISO base media format. The size field occupies bytes 0-3, so the box type
  // is at 4. Both audio and video ride this container.
  { magic: ascii('ftyp'), offset: 4, types: ['video/mp4', 'audio/mp4'] },
  // Matroska / WebM, EBML header. Same container for both lanes.
  { magic: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, types: ['video/webm', 'audio/webm'] },
  { magic: ascii('OggS'), offset: 0, types: ['audio/ogg'] },
  // MPEG audio arrives either with an ID3v2 tag in front of it or as a bare
  // frame. Both are audio/mpeg.
  { magic: ascii('ID3'), offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xfb], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xf3], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xf2], offset: 0, types: ['audio/mpeg'] },
  { magic: [0xff, 0xe3], offset: 0, types: ['audio/mpeg'] },
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

/**
 * The media types the bytes could legitimately be labelled as, or null when
 * nothing recognises them.
 *
 * Null is a REFUSAL, not an unknown to be waved through. Every type the store
 * accepts has a signature here, so bytes that match none of them are not a
 * media file of a supported type, whatever the upload said.
 */
export function sniffMediaTypes(bytes: Buffer): readonly string[] | null {
  for (const sig of SIGNATURES) {
    if (matches(bytes, sig)) return sig.types;
  }
  return null;
}

/**
 * True when the declared type is consistent with what the bytes actually are.
 *
 * The declared type still has to be on the store's allow-list — that check is
 * separate and comes first. This one only answers whether the label and the
 * container agree.
 */
export function bytesMatchDeclaredType(bytes: Buffer, declared: string): boolean {
  const candidates = sniffMediaTypes(bytes);
  return candidates !== null && candidates.includes(declared.toLowerCase());
}
