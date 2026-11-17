// Types for the build script, so the agent-readiness test can import its pure
// functions and assert the checked-in nginx allowlist still matches App.tsx.
// Without this, `tsc --noEmit` fails on the untyped .mjs import (the test runs
// fine under vitest either way, which is exactly how it would slip through).
//
// Hand-written rather than generated: the script is plain ESM run by node during
// the build, and adding allowJs/checkJs to tsconfig to infer this would pull
// every .js in the repo into the typecheck.

/**
 * Walk the <Routes> tree in App.tsx source and return every full route path the
 * app can render, with nesting resolved and :params intact. Throws if no "/"
 * route is present, or if fewer routes are found than the app is known to have
 * (which means the parser has stopped matching).
 */
export function deriveRoutePaths(source: string): string[]

/**
 * Turn one route path into the anchored nginx regex used in the allowlist.
 * The returned string always begins with "~" — without it nginx compares the
 * key literally and it never matches.
 */
export function toPattern(path: string): string

/** Render route paths as the nginx `map $request_uri $is_spa_route` block. */
export function renderConf(paths: string[]): string
