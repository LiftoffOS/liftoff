// The bytes have to agree with the label, or the allow-list is decoration.
//
// The producer route can trust a declared Content-Type: every caller is one of
// our services behind a service token. The inbound route cannot — the label is
// chosen by a browser, and a browser that has been asked nicely will send any
// label at all. These tests pin the one property that makes the allow-list
// mean something: `image/png` has to be a PNG.

import { bytesMatchDeclaredType, sniffMediaTypes } from '../sniff-media-type';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const gif = Buffer.from('GIF89a....', 'binary');
const webp = Buffer.concat([
  Buffer.from('RIFF', 'binary'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'binary'),
]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'binary')]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const ogg = Buffer.from('OggS....', 'binary');
const mp3 = Buffer.from('ID3 ', 'binary');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
const html = Buffer.from('<!doctype html><html></html>', 'utf8');

describe('sniffMediaTypes', () => {
  it.each([
    ['png', png, 'image/png'],
    ['jpeg', jpeg, 'image/jpeg'],
    ['gif', gif, 'image/gif'],
    ['webp', webp, 'image/webp'],
    ['ogg', ogg, 'audio/ogg'],
    ['mp3', mp3, 'audio/mpeg'],
  ])('recognises %s', (_name, bytes, expected) => {
    expect(sniffMediaTypes(bytes as Buffer)).toContain(expected);
  });

  // Two of the allow-listed pairs are genuinely the same container. Telling
  // them apart needs a demuxer, so the check is deliberately "the container is
  // right and the label is one this container can hold".
  it('lets an ISO-BMFF file be labelled as either video or audio', () => {
    expect(sniffMediaTypes(mp4)).toEqual(expect.arrayContaining(['video/mp4', 'audio/mp4']));
  });

  it('lets a Matroska file be labelled as either video or audio', () => {
    expect(sniffMediaTypes(webm)).toEqual(expect.arrayContaining(['video/webm', 'audio/webm']));
  });

  it('recognises nothing in text', () => {
    expect(sniffMediaTypes(svg)).toBeNull();
    expect(sniffMediaTypes(html)).toBeNull();
    expect(sniffMediaTypes(Buffer.alloc(0))).toBeNull();
  });
});

describe('bytesMatchDeclaredType', () => {
  it('accepts a PNG declared as a PNG', () => {
    expect(bytesMatchDeclaredType(png, 'image/png')).toBe(true);
  });

  // The whole point. Without this the allow-list checks a string the attacker
  // wrote, and an SVG — executable markup served back into the user's origin —
  // reaches the bucket by being called image/png.
  it('refuses an SVG wearing a PNG label', () => {
    expect(bytesMatchDeclaredType(svg, 'image/png')).toBe(false);
  });

  it('refuses HTML wearing an image label', () => {
    expect(bytesMatchDeclaredType(html, 'image/jpeg')).toBe(false);
  });

  it('refuses a real PNG mislabelled as a JPEG', () => {
    expect(bytesMatchDeclaredType(png, 'image/jpeg')).toBe(false);
  });

  it('accepts a real JPEG declared as a JPEG', () => {
    expect(bytesMatchDeclaredType(jpeg, 'image/jpeg')).toBe(true);
  });

  it('is case-insensitive about the label', () => {
    expect(bytesMatchDeclaredType(png, 'IMAGE/PNG')).toBe(true);
  });
});
