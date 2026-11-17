import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Source-level guard for brand-icon coloring.
 *
 * Why this test exists:
 *   Every integration icon SVG in IntegrationIcons.tsx renders a third-party
 *   brand mark. Several of them were originally shipped with
 *   `fill="currentColor"` (or `stroke="currentColor"`), which lets the icon
 *   inherit whatever text color its parent container has. That sounds
 *   harmless until any parent flips its text color for state. Concretely:
 *   on /dashboard/agents/update, the .integration-chip--selected rule sets
 *   `color: var(--color-accent)` (orange), and every currentColor brand mark
 *   inside a selected chip silently re-tinted itself orange — a UI bug for
 *   anyone who knows the brand.
 *
 *   Rather than fix the symptom in CSS (a defensive override on the
 *   selected-chip), we pinned every brand mark's color at the SVG source.
 *   This test enforces that decision so the bug class cannot be reintroduced
 *   by a future contributor copy-pasting an SVG that ships with currentColor.
 *
 * What it asserts:
 *   No `fill="currentColor"` and no `stroke="currentColor"` (any whitespace,
 *   any quote style) anywhere in IntegrationIcons.tsx. Brand icons MUST use a
 *   concrete color (hex, rgb, or a design-system CSS variable). If a future
 *   icon genuinely needs to inherit text color, it does NOT belong in this
 *   file — put it under src/assets/icons or src/components/icons next to the
 *   monochrome utility icons (CheckIcon, XIcon, etc.).
 */
describe('IntegrationIcons.tsx — brand-color enforcement', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'IntegrationIcons.tsx'),
    'utf8',
  )

  it('contains no fill="currentColor" (brand marks must pin their own color)', () => {
    const matches = source.match(/fill\s*=\s*["']currentColor["']/gi) ?? []
    expect(matches).toEqual([])
  })

  it('contains no stroke="currentColor" (brand marks must pin their own color)', () => {
    const matches = source.match(/stroke\s*=\s*["']currentColor["']/gi) ?? []
    expect(matches).toEqual([])
  })
})
