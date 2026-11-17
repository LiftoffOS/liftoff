// The mark for a coding tool connected to the workspace, keyed on the vendor
// the platform-backend puts on the row. One table for the two surfaces that
// show a connection: the OAuth consent page (which tool is asking) and the
// teams page (which tool a person connected). The backend decides what a
// client IS (client-brand.ts there turns the registered name into a slug and
// a label); this file only decides what that looks like.
//
// Keys, as the workforce payload and the consent GET send them:
//   'anthropic' | 'openai'   a Switch-flow credential, by its vendor
//   'claude_code_mcp'        a static collab token (Claude Code)
//   'claude-code' | 'codex' | 'opencode' | 'gemini-cli' | 'grok' | 'vscode'
//   | 'cursor' | 'windsurf'  an OAuth-connected tool, by its client slug
//   'mcp' / null             an OAuth client that is not a tool we know
//   undefined                a platform-backend that predates the field, which
//                            only ever listed Claude Code connections
//
// `dark` marks the SVGs that paint with currentColor: beside a mark with its
// own brand fill they would inherit the wrapper's muted grey and read as
// disabled, so the caller switches them to the black text colour.

import type { ComponentType, SVGProps } from 'react'
import ClaudeIcon from '../assets/icons/claude.svg?react'
import OpenAIIcon from '../assets/icons/openai.svg?react'
import OpenCodeIcon from '../assets/icons/opencode.svg?react'
import GeminiIcon from '../assets/icons/gemini.svg?react'
import GrokIcon from '../assets/icons/grok.svg?react'
import VsCodeIcon from '../assets/icons/vscode.svg?react'
import CursorIcon from '../assets/icons/cursor.svg?react'
import PlugIcon from '../assets/icons/plug.svg?react'

export interface CodingToolMark {
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  /** The tool's product name, for the tooltip when the row carries no label. */
  label: string
  /** The SVG paints with currentColor and needs the dark text colour. */
  dark: boolean
}

const CLAUDE_CODE: CodingToolMark = { Icon: ClaudeIcon, label: 'Claude Code', dark: false }
const GENERIC: CodingToolMark = { Icon: PlugIcon, label: 'MCP client', dark: true }

const MARKS: Record<string, CodingToolMark> = {
  anthropic: CLAUDE_CODE,
  claude_code_mcp: CLAUDE_CODE,
  'claude-code': CLAUDE_CODE,
  openai: { Icon: OpenAIIcon, label: 'OpenAI Codex', dark: true },
  codex: { Icon: OpenAIIcon, label: 'Codex', dark: true },
  opencode: { Icon: OpenCodeIcon, label: 'OpenCode', dark: false },
  'gemini-cli': { Icon: GeminiIcon, label: 'Gemini CLI', dark: false },
  grok: { Icon: GrokIcon, label: 'Grok', dark: true },
  vscode: { Icon: VsCodeIcon, label: 'VS Code', dark: false },
  cursor: { Icon: CursorIcon, label: 'Cursor', dark: true },
  windsurf: { ...GENERIC, label: 'Windsurf' },
}

export function codingToolMark(vendor: string | null | undefined): CodingToolMark {
  if (vendor === undefined) return CLAUDE_CODE
  if (vendor === null) return GENERIC
  return MARKS[vendor] ?? GENERIC
}
