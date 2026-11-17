import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Markdown.css'

/** Text written by an agent, rendered as the markdown it is.
 *
 *  Every surface that shows model-authored prose gets the same treatment:
 *  `**bold**`, `` `code` ``, and numbered lists arrive as markup in the string,
 *  and printing that string raw shows the reader the asterisks and backticks
 *  instead of the emphasis they stand for.
 *
 *  Raw HTML is deliberately not enabled (no rehype-raw): this text comes back
 *  from a model and from tool output, so it is never trusted as markup.
 */
interface MarkdownProps {
  children: string
  /** Extra class on the wrapper, for surface-specific size and colour. */
  className?: string
  /** Render without block wrappers, for markdown that sits inside a sentence
   *  (a labelled line such as "Why: ..."). Paragraphs are unwrapped so the
   *  text stays on the label's line. */
  inline?: boolean
}

// Links in this text point at whatever the team was working on, which is never
// this app; opening one in place would lose the reader's place in the queue.
const blockComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
}

const inlineComponents: Components = {
  ...blockComponents,
  p: ({ children }) => <>{children}</>,
}

export default function Markdown({ children, className = '', inline = false }: MarkdownProps) {
  const classes = [
    'markdown',
    inline ? 'markdown--inline' : '',
    className,
  ].filter(Boolean).join(' ')

  const body = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={inline ? inlineComponents : blockComponents}
    >
      {children}
    </ReactMarkdown>
  )

  return inline
    ? <span className={classes}>{body}</span>
    : <div className={classes}>{body}</div>
}
