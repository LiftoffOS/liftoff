// Intrinsic pixel dimensions, read from an image's own header.
//
// WHY THIS EXISTS. A MediaRef carries `width` and `height` so the renderer can
// reserve the right box before the bytes arrive. Without them a full-page
// screenshot lands as a zero-height element that suddenly becomes 3000px tall,
// and the transcript jumps under whoever is reading it. "When known" is only
// worth having in the contract if something actually knows, and the only party
// that does is the code holding the buffer.
//
// Header parsing rather than a decoder. There is no `sharp` and no `canvas` in
// this estate and adding one for two integers would be a native build
// dependency on every image in every service. Every format on the media
// allow-list writes its dimensions in a fixed position near the front of the
// file, so this reads a few dozen bytes and never touches the pixel data.
//
// Best effort by contract: an unreadable or truncated header returns null and
// the renderer falls back to laying out on arrival, exactly as it does for a
// producer that supplied nothing. It must never throw — a picture that cannot
// be measured is still a picture worth showing.

export interface PixelDimensions {
  width: number;
  height: number;
}

/** PNG: 8-byte signature, then the IHDR chunk whose first two big-endian
 *  uint32s are width and height. Position is fixed by the spec. */
function readPng(buf: Buffer): PixelDimensions | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: "GIF87a"/"GIF89a" then the logical screen descriptor, two little-endian
 *  uint16s. */
function readGif(buf: Buffer): PixelDimensions | null {
  if (buf.length < 10) return null;
  const magic = buf.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/**
 * JPEG: walk the marker chain to the first frame header (SOFn) and read the
 * two big-endian uint16s inside it.
 *
 * The walk is necessary — a JPEG's size is not at a fixed offset, because EXIF,
 * ICC profiles and thumbnails all sit in front of the frame. SOF4 (0xC4, define
 * Huffman table), SOF8 (0xC8, reserved) and SOFC (0xCC, define arithmetic
 * coding) are NOT frame headers despite falling in the 0xC0-0xCF range, which
 * is the trap in every naive version of this function.
 */
/**
 * EXIF orientation, when the file declares one.
 *
 * This is the difference between the pixels a JPEG stores and the picture a
 * person sees. A phone shot in portrait writes LANDSCAPE pixels plus a flag
 * saying "rotate on display", and every browser honours the flag — so the frame
 * header's width and height are transposed relative to what is rendered.
 *
 * Recording the raw numbers made the transcript reserve a landscape box for a
 * portrait photograph. Values 5 through 8 are the quarter-turns; 1 through 4
 * are identity and mirror flips, which do not change the shape.
 *
 * Returns 1 (no rotation) whenever the tag is absent or unreadable, because
 * "no EXIF" is by far the common case and is not an error.
 */
function readJpegOrientation(buf: Buffer): number {
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) return 1;
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return 1; // pixel data; no EXIF ahead
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return 1;
    // APP1, and only the Exif flavour — APP1 also carries XMP.
    if (marker === 0xe1 && buf.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      const tiff = offset + 10;
      if (tiff + 8 > buf.length) return 1;
      const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (at: number): number => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
      const u32 = (at: number): number => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
      if (u16(tiff + 2) !== 0x002a) return 1;
      const ifd0 = tiff + u32(tiff + 4);
      if (ifd0 + 2 > buf.length) return 1;
      const count = u16(ifd0);
      for (let i = 0; i < count; i += 1) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 12 > buf.length) return 1;
        // 0x0112 = Orientation. Value sits in the first 2 bytes of the payload.
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

/** Orientations 5-8 are quarter-turns, so the stored pixels are transposed
 *  relative to what is displayed. 1-4 are identity and mirror flips. */
function isQuarterTurn(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

function readJpeg(buf: Buffer): PixelDimensions | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) return null; // out of sync with the marker chain
    const marker = buf[offset + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data follows and there is no frame header left.
    if (marker === 0xda) return null;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > buf.length) return null;
      // Payload: precision (1 byte), height (2), width (2).
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      // As DISPLAYED, not as stored. Consumers use these to reserve layout
      // space, and the space a picture takes is the space after the browser has
      // applied the orientation flag.
      return isQuarterTurn(readJpegOrientation(buf))
        ? { width: height, height: width }
        : { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP: a RIFF container with three different chunk layouts, and each stores
 * its size differently.
 *   VP8  (lossy)    — 14-bit dimensions after a 3-byte start code.
 *   VP8L (lossless) — 14-bit dimensions packed into a 32-bit little-endian word.
 *   VP8X (extended) — 24-bit canvas size, stored minus one.
 */
function readWebp(buf: Buffer): PixelDimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf.readUInt8(23) !== 0x9d || buf.readUInt8(24) !== 0x01 || buf.readUInt8(25) !== 0x2a) {
      return null;
    }
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (buf.readUInt8(20) !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    const width = buf.readUIntLE(24, 3) + 1;
    const height = buf.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  return null;
}

const READERS: Record<string, (buf: Buffer) => PixelDimensions | null> = {
  'image/png': readPng,
  'image/jpeg': readJpeg,
  'image/gif': readGif,
  'image/webp': readWebp,
};

/**
 * Intrinsic dimensions for an allow-listed image, or null when they cannot be
 * read. Never throws: a malformed header is a reason to lay the image out on
 * arrival, not a reason to refuse to show it.
 *
 * Video and audio return null. Their duration and frame size live behind a
 * container parse deep enough to need a demuxer, and nothing produces either
 * yet — `durationMs` stays absent rather than guessed.
 */
export function readImageDimensions(mimeType: string, bytes: Buffer): PixelDimensions | null {
  const reader = READERS[mimeType];
  if (!reader) return null;
  try {
    const dims = reader(bytes);
    if (!dims) return null;
    // A zero or absurd dimension is a misparse, not a picture. The cap is the
    // largest sane canvas by an order of magnitude; anything past it would only
    // poison the aspect-ratio box it exists to set.
    if (!Number.isInteger(dims.width) || !Number.isInteger(dims.height)) return null;
    if (dims.width <= 0 || dims.height <= 0) return null;
    if (dims.width > 100_000 || dims.height > 100_000) return null;
    return dims;
  } catch {
    return null;
  }
}
