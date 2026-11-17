// Bidi and zero-width matches are built from RegExp constructors with \u
// escape strings so this source file has no irregular-whitespace bytes
// (eslint no-irregular-whitespace).
const BIDI_CTRL_RE = new RegExp(
  '[‎‏؜‪-‮⁦-⁩]', 'g',
);
const ZERO_WIDTH_RES = [
  new RegExp('​', 'g'),
  new RegExp('‌', 'g'),
  new RegExp('‍', 'g'),
  new RegExp('﻿', 'g'),
  new RegExp('⁠', 'g'),
];

export function sanitizeWebContent(content: string): string {
  let s = content.normalize('NFKC');
  s = s.replace(BIDI_CTRL_RE, '');
  for (const r of ZERO_WIDTH_RES) s = s.replace(r, '');
  // ChatML and Llama instruction-tuned delimiters
  s = s.replace(/<\|im_(start|end|sep)\|>/gi, '');
  s = s.replace(/\[\/?(INST|SYS)\]/gi, '');
  s = s.replace(/<<\/?SYS>>/gi, '');
  // Claude XML role tags
  s = s.replace(/<\/?(system|human|user|assistant|instructions?)\s*>/gi, '');
  // ANSI escapes
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B/g, '');
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  return s;
}
