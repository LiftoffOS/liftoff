// Sanitizes prompt-injection markers from web content. All Unicode-controlled
// regexes are built via the RegExp constructor with \u escape strings — this
// keeps the source file free of irregular-whitespace bytes (eslint
// no-irregular-whitespace) and of joined-character-class sequences (eslint
// no-misleading-character-class).
//
// Bidi controls: U+200E LRM, U+200F RLM, U+061C ALM, U+202A-202E
// (LRE/RLE/PDF/LRO/RLO), U+2066-2069 (LRI/RLI/FSI/PDI).
const BIDI_CTRL_RE = new RegExp(
  '[‎‏؜‪-‮⁦-⁩]', 'g',
);

// Zero-width / invisible — each as its own regex to avoid ZWJ joining
// adjacent codepoints inside a character class.
const ZERO_WIDTH_RES = [
  new RegExp('​', 'g'), // ZWSP
  new RegExp('‌', 'g'), // ZWNJ
  new RegExp('‍', 'g'), // ZWJ
  new RegExp('﻿', 'g'), // BOM
  new RegExp('⁠', 'g'), // WORD JOINER
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

