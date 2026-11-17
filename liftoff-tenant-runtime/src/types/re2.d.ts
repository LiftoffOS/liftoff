// Ambient declaration for `re2` (Google's RE2 regex engine, native binding).
//
// The package itself ships without type declarations. We capture only the
// surface the predicate-evaluator uses — instantiate with a pattern string,
// call .test(input). This intentionally narrower than the full RE2 API.

declare module 're2' {
  class RE2 {
    constructor(pattern: string | RegExp, flags?: string);
    test(input: string): boolean;
    exec(input: string): RegExpExecArray | null;
    match(input: string): RegExpMatchArray | null;
    replace(input: string, replacement: string | ((match: string, ...args: unknown[]) => string)): string;
    source: string;
    flags: string;
  }
  export default RE2;
  export { RE2 };
}
