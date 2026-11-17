// Header parsing is exactly the kind of code that is confidently wrong.
//
// Every format here writes its size somewhere different, two of them pack the
// numbers into bit fields, and JPEG hides it behind a marker walk that three of
// the four "read image size" snippets on the internet get wrong in the same
// way. So the fixtures are built byte by byte from the specs rather than
// checked in as opaque files: a failure names the field, not "the PNG broke".

import { readImageDimensions } from '../image-dimensions';

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);          // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** SOI, then `leading` filler segments, then a frame header. The filler is what
 *  makes this a real test: a reader that assumes a fixed offset passes on a
 *  bare JPEG and fails on every one a camera or a screenshot tool produced. */
function jpeg(width: number, height: number, opts: { sofMarker?: number; leading?: number[] } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const marker of opts.leading ?? [0xe0, 0xe1, 0xdb]) {
    const payload = Buffer.alloc(14, 0);
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt8(0xff, 0);
    seg.writeUInt8(marker, 1);
    seg.writeUInt16BE(2 + payload.length, 2);
    payload.copy(seg, 4);
    parts.push(seg);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(opts.sofMarker ?? 0xc0, 1);
  sof.writeUInt16BE(9, 2);   // length
  sof.writeUInt8(8, 4);      // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

function webpLossy(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0x9d, 23);
  buf.writeUInt8(0x01, 24);
  buf.writeUInt8(0x2a, 25);
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

function webpLossless(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0x2f, 20);
  // 14 bits of (width - 1), then 14 bits of (height - 1).
  buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buf;
}

function webpExtended(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe('readImageDimensions', () => {
  it('reads a PNG', () => {
    expect(readImageDimensions('image/png', png(1280, 3200))).toEqual({ width: 1280, height: 3200 });
  });

  it('reads a GIF', () => {
    expect(readImageDimensions('image/gif', gif(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it('reads a GIF87a as well as a GIF89a', () => {
    const buf = gif(64, 48);
    buf.write('GIF87a', 0, 'ascii');
    expect(readImageDimensions('image/gif', buf)).toEqual({ width: 64, height: 48 });
  });

  it('walks past EXIF and quantization segments to the JPEG frame header', () => {
    expect(readImageDimensions('image/jpeg', jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a progressive JPEG (SOF2), not just a baseline one', () => {
    expect(readImageDimensions('image/jpeg', jpeg(800, 600, { sofMarker: 0xc2 })))
      .toEqual({ width: 800, height: 600 });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    // 0xC4 sits inside the 0xC0-0xCF range and is NOT a frame header. A reader
    // that takes the range at face value reads two bytes of a Huffman table as
    // the image size and reports a plausible-looking wrong answer.
    const buf = jpeg(640, 480, { leading: [0xe0, 0xc4] });
    expect(readImageDimensions('image/jpeg', buf)).toEqual({ width: 640, height: 480 });
  });

  it('reads all three WebP chunk layouts', () => {
    expect(readImageDimensions('image/webp', webpLossy(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions('image/webp', webpLossless(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions('image/webp', webpExtended(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it('returns null rather than throwing on anything it cannot read', () => {
    // Each of these is a way the caller could be holding something unexpected,
    // and none of them may cost the person their picture: the renderer simply
    // lays out on arrival instead.
    expect(readImageDimensions('image/png', Buffer.alloc(0))).toBeNull();
    expect(readImageDimensions('image/png', Buffer.from('not a png at all'))).toBeNull();
    expect(readImageDimensions('image/png', png(1280, 720).subarray(0, 15))).toBeNull();
    expect(readImageDimensions('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(readImageDimensions('image/webp', Buffer.alloc(30))).toBeNull();
  });

  it('refuses a zero dimension, which is a misparse rather than a picture', () => {
    expect(readImageDimensions('image/png', png(0, 100))).toBeNull();
    expect(readImageDimensions('image/gif', gif(100, 0))).toBeNull();
  });

  it('reads nothing for video and audio, which need a demuxer', () => {
    expect(readImageDimensions('video/mp4', Buffer.alloc(64))).toBeNull();
    expect(readImageDimensions('audio/mpeg', Buffer.alloc(64))).toBeNull();
  });
});


// EXIF orientation: the difference between the pixels a JPEG stores and the
// picture a person sees.
//
// A phone shot in portrait writes LANDSCAPE pixels plus a flag saying "rotate
// on display". Every browser honours the flag, so recording the frame header's
// numbers verbatim made the transcript reserve a landscape box for a portrait
// photograph — and, while an aspect ratio was imposed from them, stretched the
// picture sideways to fill it.
describe('EXIF orientation', () => {
  /** A minimal JPEG: SOI, an Exif APP1 carrying one IFD0 orientation tag, then
   *  an SOF0 frame header declaring landscape pixels. */
  function jpegWithOrientation(orientation: number, littleEndian = true): Buffer {
    const entry = Buffer.alloc(12);
    const w = (at: number, v: number): void => {
      if (littleEndian) entry.writeUInt16LE(v, at);
      else entry.writeUInt16BE(v, at);
    };
    w(0, 0x0112); // Orientation tag
    w(2, 3); // SHORT
    if (littleEndian) entry.writeUInt32LE(1, 4); else entry.writeUInt32BE(1, 4);
    w(8, orientation);

    const tiff = Buffer.alloc(8);
    tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
    if (littleEndian) { tiff.writeUInt16LE(0x2a, 2); tiff.writeUInt32LE(8, 4); }
    else { tiff.writeUInt16BE(0x2a, 2); tiff.writeUInt32BE(8, 4); }

    const ifd = Buffer.alloc(2 + 12 + 4);
    if (littleEndian) ifd.writeUInt16LE(1, 0); else ifd.writeUInt16BE(1, 0);
    entry.copy(ifd, 2);

    const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff, ifd]);
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1]),
      (() => { const l = Buffer.alloc(2); l.writeUInt16BE(exifBody.length + 2); return l; })(),
      exifBody,
    ]);

    // SOF0: length 17, precision 8, height 3024, width 4032 (landscape pixels).
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(3024, 5);
    sof.writeUInt16BE(4032, 7);

    return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]);
  }

  it.each([6, 8, 5, 7])('transposes a quarter-turn (orientation %i)', (o) => {
    // Stored 4032x3024 landscape; displayed 3024x4032 portrait.
    expect(readImageDimensions('image/jpeg', jpegWithOrientation(o)))
      .toEqual({ width: 3024, height: 4032 });
  });

  it.each([1, 2, 3, 4])('leaves an identity or mirror flip alone (orientation %i)', (o) => {
    expect(readImageDimensions('image/jpeg', jpegWithOrientation(o)))
      .toEqual({ width: 4032, height: 3024 });
  });

  // EXIF is TIFF, and TIFF comes in both byte orders.
  it('reads a big-endian (MM) EXIF block', () => {
    expect(readImageDimensions('image/jpeg', jpegWithOrientation(6, false)))
      .toEqual({ width: 3024, height: 4032 });
  });

  // By far the common case, and not an error.
  it('treats a JPEG with no EXIF as unrotated', () => {
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(600, 5);
    sof.writeUInt16BE(800, 7);
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
    expect(readImageDimensions('image/jpeg', plain)).toEqual({ width: 800, height: 600 });
  });
});
