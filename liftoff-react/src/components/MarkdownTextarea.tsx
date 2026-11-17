import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { mergeAttributes } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { Slice, Fragment } from '@tiptap/pm/model'
import { useEffect, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import KnowledgeMentionList, { type KnowledgeMentionListRef, type KnowledgeMentionItem } from './KnowledgeMentionList'
import AgentMentionList, { type AgentMentionListRef, type AgentMentionItem } from './AgentMentionList'
import { KnowledgeMentionChip } from './KnowledgeMentionChip'
import { KnowledgeChipContext, type ChipContextValue } from './knowledgeChipContext'
import './MarkdownTextarea.css'
import './AgentMentionList.css'
import {
  filterKnowledgeMentionItems,
  transformPastedHTML,
  markdownToHtml,
  htmlToMarkdown,
} from './markdownConversion'

// Separate ProseMirror node types for knowledge vs agent mentions so both can
// coexist in the same editor without schema conflicts.
const KnowledgeMention = Mention.extend({ name: 'knowledgeMention' })
const AgentMention = Mention.extend({ name: 'agentMention' })

interface MarkdownTextareaProps {
  value: string
  onChange: (value: string) => void
  onFocus?: () => void
  onKnowledgeIdsChange?: (ids: string[]) => void
  placeholder?: string
  className?: string
  readOnly?: boolean
  knowledgeItems?: KnowledgeMentionItem[]
  agentItems?: AgentMentionItem[]
  /** Connector instance UUIDs the editing agent is currently bound to.
   *  Filters the [[ autocomplete to items from these connectors only
   *  (plus manual-URL items, which have connectorId === null).
   *  Pass an empty array to allow no connector-sourced items. */
  boundConnectorIds?: string[]
}

export default function MarkdownTextarea({
  value,
  onChange,
  onFocus,
  onKnowledgeIdsChange,
  placeholder = '',
  className = '',
  readOnly = false,
  knowledgeItems = [],
  agentItems = [],
  boundConnectorIds = [],
}: MarkdownTextareaProps) {
  // Stable refs so suggestion closures always see latest items
  const knowledgeItemsRef = useRef<KnowledgeMentionItem[]>(knowledgeItems)
  const agentItemsRef = useRef<AgentMentionItem[]>(agentItems)
  const boundConnectorIdsRef = useRef<string[]>(boundConnectorIds)
  useEffect(() => {
    knowledgeItemsRef.current = knowledgeItems
  }, [knowledgeItems])
  useEffect(() => {
    agentItemsRef.current = agentItems
  }, [agentItems])
  useEffect(() => {
    boundConnectorIdsRef.current = boundConnectorIds
  }, [boundConnectorIds])

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2],
        },
        // Bold and inline code stay ON: every catalog template writes its
        // run-in headings as `**...**` and five use backticks for CRM field
        // names, and with the marks off all of it reached the reader as
        // literal asterisks and backticks. markdownConversion converts both
        // directions, sharing one grammar with the read-only detail page.
        italic: false,
        strike: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        // HardBreak emits <br> inside <p> on Shift+Enter AND on plain-text
        // paste via TipTap's default clipboardTextParser. Both routes
        // produced editor states that round-tripped lossily through our
        // markdown converter. Disabling the extension removes <br> from
        // the schema entirely; clipboardTextParser below replaces the
        // paste path with paragraph splits.
        hardBreak: false,
      }),
      Placeholder.configure({
        placeholder,
      }),
      KnowledgeMention.extend({
        addNodeView() {
          return ReactNodeViewRenderer(KnowledgeMentionChip)
        },
      // The refs below are READ inside TipTap's suggestion callbacks, which run
      // when someone types a trigger, long after this config object is built.
      // The compiler cannot see through the plugin API to know that, and the
      // writes are already in effects above.
      // eslint-disable-next-line react-hooks/refs
      }).configure({
        HTMLAttributes: { class: 'knowledge-chip' },
        renderHTML({ node, options }) {
          // Retained for editor.getHTML() serialization (markdown-conversion
          // round-trip at line 74-110) and clipboard copy. The interactive
          // editor view uses the NodeView above; this static shape is the
          // fallback for HTML export.
          return [
            'span',
            mergeAttributes(options.HTMLAttributes, {
              'data-type': 'knowledgeMention',
              'data-id': node.attrs.id,
              'data-label': node.attrs.label,
            }),
            node.attrs.label ?? node.attrs.id ?? '',
          ]
        },
        suggestion: {
          char: '[[',
          items({ query }: { query: string }) {
            return filterKnowledgeMentionItems(
              knowledgeItemsRef.current,
              query,
              boundConnectorIdsRef.current,
            )
          },
          render() {
            let container: HTMLElement | null = null
            let root: Root | null = null
            const listRef = { current: null as KnowledgeMentionListRef | null }

            const applyPosition = (clientRect: (() => DOMRect | null) | null) => {
              if (!container || !clientRect) return
              const rect = clientRect()
              if (!rect) return
              container.style.top = `${rect.bottom + window.scrollY + 4}px`
              container.style.left = `${rect.left + window.scrollX}px`
            }

            const renderList = (props: {
              items: KnowledgeMentionItem[]
              command: (item: { id: string; label: string }) => void
              clientRect: (() => DOMRect | null) | null
            }) => {
              root?.render(
                <KnowledgeMentionList
                  ref={node => { listRef.current = node }}
                  items={props.items}
                  command={props.command}
                />,
              )
              applyPosition(props.clientRect)
            }

            return {
              onStart(props) {
                container = document.createElement('div')
                container.style.cssText = 'position:absolute;z-index:9999;'
                document.body.appendChild(container)
                root = createRoot(container)
                renderList(props as Parameters<typeof renderList>[0])
              },
              onUpdate(props) {
                renderList(props as Parameters<typeof renderList>[0])
              },
              onKeyDown({ event }: { event: KeyboardEvent }) {
                return listRef.current?.onKeyDown(event) ?? false
              },
              onExit() {
                root?.unmount()
                container?.remove()
                container = null
                root = null
              },
            }
          },
        },
      }),
      // eslint-disable-next-line react-hooks/refs
      AgentMention.configure({
        HTMLAttributes: { class: 'agent-chip' },
        renderHTML({ node, options }) {
          return [
            'span',
            mergeAttributes(options.HTMLAttributes, {
              'data-type': 'agentMention',
              'data-id': node.attrs.id,
              'data-label': node.attrs.label,
            }),
            node.attrs.label ?? node.attrs.id ?? '',
          ]
        },
        suggestion: {
          char: '@',
          items({ query }: { query: string }) {
            const q = query.toLowerCase()
            return agentItemsRef.current
              .filter(item => item.label.toLowerCase().includes(q))
              .slice(0, 8)
          },
          render() {
            let container: HTMLElement | null = null
            let root: Root | null = null
            const listRef = { current: null as AgentMentionListRef | null }

            const applyPosition = (clientRect: (() => DOMRect | null) | null) => {
              if (!container || !clientRect) return
              const rect = clientRect()
              if (!rect) return
              container.style.top = `${rect.bottom + window.scrollY + 4}px`
              container.style.left = `${rect.left + window.scrollX}px`
            }

            const renderList = (props: {
              items: AgentMentionItem[]
              command: (item: { id: string; label: string }) => void
              clientRect: (() => DOMRect | null) | null
            }) => {
              root?.render(
                <AgentMentionList
                  ref={node => { listRef.current = node }}
                  items={props.items}
                  command={props.command}
                />,
              )
              applyPosition(props.clientRect)
            }

            return {
              onStart(props) {
                container = document.createElement('div')
                container.style.cssText = 'position:absolute;z-index:9999;'
                document.body.appendChild(container)
                root = createRoot(container)
                renderList(props as Parameters<typeof renderList>[0])
              },
              onUpdate(props) {
                renderList(props as Parameters<typeof renderList>[0])
              },
              onKeyDown({ event }: { event: KeyboardEvent }) {
                return listRef.current?.onKeyDown(event) ?? false
              },
              onExit() {
                root?.unmount()
                container?.remove()
                container = null
                root = null
              },
            }
          },
        },
      }),
    ],
    content: markdownToHtml(value),
    immediatelyRender: true,
    autofocus: false,
    onCreate: ({ editor }) => {
      // Prevent scroll jumps during editor initialization
      const scrollY = window.scrollY
      const html = document.documentElement
      const originalOverflow = html.style.overflow
      html.style.overflow = 'hidden'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = editor.view as any
      view.scrollIntoView = () => {}

      const editorElement = view.dom
      const originalFocus = editorElement.focus.bind(editorElement)
      editorElement.focus = (options?: FocusOptions) => {
        originalFocus({ ...options, preventScroll: true })
      }

      queueMicrotask(() => {
        html.style.overflow = originalOverflow
        window.scrollTo({ top: scrollY, behavior: 'instant' })
      })
    },
    onUpdate: ({ editor }) => {
      const markdown = htmlToMarkdown(editor.getHTML())
      onChange(markdown)
      if (onKnowledgeIdsChange) {
        const ids: string[] = []
        editor.state.doc.descendants(node => {
          if (node.type.name === 'knowledgeMention') ids.push(node.attrs.id as string)
        })
        onKnowledgeIdsChange(ids)
      }
    },
    onFocus: () => {
      onFocus?.()
    },
    editorProps: {
      attributes: {
        class: 'markdown-textarea__editor',
      },
      // Architectural model for this editor: the document contains only
      // paragraphs and h2 headings — no <br>, no lists, no inline marks.
      // Every visual line in the editor is one paragraph in markdown.
      // We enforce that model at all three paste entry points below
      // (plain text, HTML, and any clipboard parsing) so a paste from
      // any source — code editor, browser, Notion, Docs, this app's own
      // rendered output — always lands as a clean sequence of paragraphs.

      // HTML paste: flatten <li>, <br>, and list/div wrappers to
      // paragraph splits BEFORE TipTap parses (see transformPastedHTML
      // for the exact rules). Without this, lists from a webpage paste
      // get their structure stripped and the items concatenated into one
      // <p>; that's the exact symptom the user reported with run-on
      // bullets in saved responsibilities.
      transformPastedHTML,

      // Plain-text paste: TipTap's default clipboardTextParser routes
      // each `\n` to whatever HardBreak does (now disabled). Replace it
      // with one that builds a Slice of paragraph nodes per non-empty
      // line. openStart/openEnd = 1 makes the outer paragraphs merge
      // with the surrounding paragraph at the paste position — i.e. the
      // first line joins the text before the cursor, the last joins the
      // text after, middle lines stand alone.
      clipboardTextParser: (text, $context) => {
        const schema = $context.doc.type.schema
        const paragraphType = schema.nodes.paragraph
        if (!paragraphType) return Slice.empty
        const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.length > 0)
        if (lines.length === 0) return Slice.empty
        const paragraphs = lines.map(line => paragraphType.create({}, schema.text(line)))
        return new Slice(Fragment.from(paragraphs), 1, 1)
      },
      handleKeyDown: (view, event) => {
        // When Enter is pressed in a heading, exit to paragraph
        if (event.key === 'Enter' && !event.shiftKey) {
          const { state } = view
          const { $from } = state.selection
          const node = $from.parent

          if (node.type.name === 'heading') {
            const { tr } = state
            const endPos = $from.end()
            tr.insert(endPos, state.schema.nodes.paragraph.create())
            tr.setSelection(TextSelection.near(tr.doc.resolve(endPos + 1)))
            view.dispatch(tr)
            return true
          }
        }

        // When Backspace at start of paragraph after heading, move to end of heading (don't merge)
        if (event.key === 'Backspace') {
          const { state } = view
          const { $from } = state.selection
          const node = $from.parent

          if (node.type.name === 'paragraph' && $from.parentOffset === 0) {
            const posBefore = $from.before()
            if (posBefore > 0) {
              const resolvedBefore = state.doc.resolve(posBefore - 1)
              const nodeBefore = resolvedBefore.parent

              if (nodeBefore.type.name === 'heading') {
                if (node.content.size === 0) {
                  const { tr } = state
                  tr.delete($from.before(), $from.after())
                  const headingEnd = posBefore - 1
                  tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd)))
                  view.dispatch(tr)
                  return true
                } else {
                  const { tr } = state
                  const headingEnd = posBefore - 1
                  tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd)))
                  view.dispatch(tr)
                  return true
                }
              }
            }
          }
        }

        return false
      },
    },
  })

  // Sync external value changes (like when template is inserted on focus)
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      const currentMarkdown = htmlToMarkdown(editor.getHTML())
      if (currentMarkdown !== value) {
        const scrollY = window.scrollY
        editor.commands.setContent(markdownToHtml(value))
        window.scrollTo({ top: scrollY, behavior: 'instant' })
      }
    }
  }, [value, editor])

  // Context value drives broken-chip rendering in KnowledgeMentionChip.
  // Recomputes only when knowledgeItems or boundConnectorIds change; React
  // re-renders the Provider, propagating the value to every mounted chip's
  // useContext call without ProseMirror trickery.
  const chipContext = useMemo<ChipContextValue>(() => ({
    availableItemIds: new Set(knowledgeItems.map(i => i.id)),
    boundConnectorIds: new Set(boundConnectorIds),
    itemConnectorMap: new Map(knowledgeItems.map(i => [i.id, i.connectorId])),
  }), [knowledgeItems, boundConnectorIds])

  if (readOnly) {
    return (
      <div className={`markdown-textarea markdown-textarea--readonly ${className}`}>
        <div className="markdown-textarea__rendered">
          <ReactMarkdown>{value}</ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <div className={`markdown-textarea ${className}`}>
      <KnowledgeChipContext.Provider value={chipContext}>
        <EditorContent editor={editor} />
      </KnowledgeChipContext.Provider>
    </div>
  )
}
