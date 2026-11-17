// A bounded description of the control a person used, from the event alone.
//
// This runs inside the session's page, in the recorder's isolated world, and
// its whole job is to answer "which control was that?". It names the control
// the way assistive technology would — the tag, the role, an input's type,
// and an accessible name drawn from aria-label, an associated label,
// placeholder, title, alt, the name attribute or the control's own caption —
// and reads nothing else here: not the value, not the files, not the
// selected options, not the form's data, not the page's body text. The VALUE
// is read by the recorder itself, separately, and only after
// `classifyProtectedControl` answered that the control is recordable; this
// function hands the control back (`control`) so that read has the element
// without searching the path twice. `recorder-sources.test.ts` holds the
// recorder to that order.
//
// The control is the first INTERACTIVE element on the event's composed path,
// not the raw target. A click on `<button><span>Sign in</span></button>`
// lands on the span; recording "span" would lose the control's identity, and
// the caption "Sign in" is what tells the Chief AI Officer which button it
// was. The caption includes descendant text for the same reason.
//
// It includes it ONLY THERE. When nothing on the path is interactive the
// control is the raw target — a layout element the click happened to land on
// — and that element's descendants are the page, not its name. A point at
// the blank half of a page can resolve the wide row that holds the footer,
// and reading every word inside it back as the control's name gives
// `div "Powered by …"`, for text the person could not see at the spot they
// clicked and, at the pane's scale, could barely see at all. Such an element may only be named by
// a line of text it actually holds: hand it one block-level child and it is
// a layout container with no name of its own — and a point that lands on
// something with neither a name nor a role is a point at nothing, which
// `elementAtPoint` reports as such. A paragraph with links in it is still a
// line of text and still reads whole; the swept measure is what it costs on
// a real page, and it was 46% of Wikipedia's viewport naming a container.
//
// What this does and does not promise: the name IS page-authored text and can
// echo something the person typed ("Continue as jane@example.com" is a
// caption a real site renders). That is a documented limit of describing a
// control by its label, not a leak of a value read, and the reader redacts
// known sensitive patterns before the Chief AI Officer sees it.
//
// Self-contained by design: its source is embedded in the recorder through
// `Function.prototype.toString()`, so it may reference nothing outside its
// own body. The DOM types below are structural stand-ins — this runtime is
// compiled without the DOM lib — and cost nothing at runtime.

/** The slice of the DOM this reads. Structural, so it compiles without the
 *  DOM lib and still describes exactly what the function touches. */
export interface DomNodeLike {
  nodeType?: number;
  tagName?: string;
  parentElement?: DomNodeLike | null;
  textContent?: string | null;
  /** Direct children, for a caption that must not borrow a descendant's
   *  text. Structural, like the rest of this interface. */
  childNodes?: ArrayLike<{ nodeType?: number; tagName?: string }> | null;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  closest?(selector: string): DomNodeLike | null;
  labels?: ArrayLike<DomNodeLike> | null;
  ownerDocument?: { getElementById(id: string): DomNodeLike | null } | null;
  isContentEditable?: boolean;
  href?: unknown;
  multiple?: boolean;
  size?: number;
}

export interface DomEventLike {
  type: string;
  target?: DomNodeLike | null;
  submitter?: DomNodeLike | null;
  composedPath?(): DomNodeLike[];
}

export interface TargetDescription {
  tag: string;
  role: string;
  inputType: string;
  /** The control's autocomplete token, lowercased; '' when it has none. The
   *  classifier reads it as evidence; the saved-login fill reads it to tell a
   *  one-time-code box from the rest. Never on a recorded row. */
  autocomplete: string;
  name: string;
  /** The accessible name was longer than its cap and was cut. */
  nameTruncated: boolean;
  /** The control itself, for the recorder's value read and form evidence. */
  control: DomNodeLike;
}

/**
 * Describe the control behind an event, or null when the event has no element.
 *
 * `submit` describes the submitter when the browser reports one (the button
 * that sent the form), else the form itself without a caption — a form's
 * descendant text is the page, not a control.
 */
export function describeTarget(event: DomEventLike): TargetDescription | null {
  const TAG_CAP = 32;
  const ROLE_CAP = 64;
  const INPUT_TYPE_CAP = 32;
  /** Autocomplete is a token list ("section-blue shipping street-address"). */
  const AUTOCOMPLETE_CAP = 64;
  const NAME_CAP = 200;
  const ELEMENT_NODE = 1;

  const isElement = (n: DomNodeLike | null | undefined): n is DomNodeLike =>
    !!n && n.nodeType === ELEMENT_NODE && typeof n.tagName === 'string';

  const attr = (el: DomNodeLike, name: string): string => {
    const v = el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  };

  let nameTruncated = false;
  const clean = (text: string | null | undefined, cap: number): string => {
    const whole = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
    if (cap === NAME_CAP && whole.length > cap) nameTruncated = true;
    return whole.slice(0, cap);
  };

  const INTERACTIVE_TAGS: Record<string, true> = {
    button: true, input: true, select: true, textarea: true, summary: true, option: true,
  };
  const INTERACTIVE_ROLES: Record<string, true> = {
    button: true, link: true, checkbox: true, radio: true, switch: true, tab: true,
    menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true,
    combobox: true, textbox: true, searchbox: true, slider: true, spinbutton: true,
    treeitem: true, listbox: true,
  };

  const isInteractive = (el: DomNodeLike): boolean => {
    const tag = (el.tagName ?? '').toLowerCase();
    if (INTERACTIVE_TAGS[tag]) return true;
    if (tag === 'a' && (el.hasAttribute ? el.hasAttribute('href') : false)) return true;
    const role = attr(el, 'role').toLowerCase();
    if (role && INTERACTIVE_ROLES[role]) return true;
    if (el.isContentEditable === true) return true;
    const tabindex = attr(el, 'tabindex');
    if (tabindex !== '' && Number(tabindex) >= 0) return true;
    return false;
  };

  // The path from the target outwards. composedPath crosses shadow roots,
  // which is where a click on a web component's inner button would otherwise
  // be lost; the parent chain is the fallback for an event without one.
  const path: DomNodeLike[] = [];
  if (event.composedPath) {
    for (const n of event.composedPath()) if (isElement(n)) path.push(n);
  } else {
    for (let n = event.target ?? null; isElement(n); n = n.parentElement ?? null) path.push(n);
  }
  if (path.length === 0) return null;

  let control: DomNodeLike | null = null;
  let captionAllowed = true;
  if (event.type === 'submit') {
    if (isElement(event.submitter)) {
      control = event.submitter;
    } else {
      control = path.find((n) => (n.tagName ?? '').toLowerCase() === 'form') ?? path[0];
      captionAllowed = false;
    }
  } else {
    control = path.find(isInteractive) ?? path[0];
  }
  const controlIsInteractive = isInteractive(control);
  const tag = (control.tagName ?? '').toLowerCase();
  if (tag === 'html' || tag === 'body') captionAllowed = false;

  const inputType = tag === 'input' ? attr(control, 'type').toLowerCase() || 'text' : '';
  const autocomplete = attr(control, 'autocomplete').toLowerCase();

  const implicitRole = (): string => {
    switch (tag) {
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'a': return control && control.hasAttribute && control.hasAttribute('href') ? 'link' : '';
      case 'select': {
        const multiple = control?.multiple === true || attr(control, 'multiple') !== '';
        const size = typeof control?.size === 'number' ? control.size : Number(attr(control, 'size') || '0');
        return multiple || size > 1 ? 'listbox' : 'combobox';
      }
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'form': return 'form';
      case 'img': return 'img';
      case 'nav': return 'navigation';
      case 'li': return 'listitem';
      case 'ul': case 'ol': return 'list';
      case 'table': return 'table';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'input':
        switch (inputType) {
          case 'button': case 'submit': case 'reset': case 'image': return 'button';
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'number': return 'spinbutton';
          case 'search': return 'searchbox';
          case 'hidden': return '';
          default: return 'textbox';
        }
      default: return '';
    }
  };
  const role = attr(control, 'role').toLowerCase() || implicitRole();

  // Accessible name, in order of preference. Each source is read from the
  // control or its associated label only.
  const labelText = (): string => {
    const byId = attr(control, 'aria-labelledby');
    if (byId && control.ownerDocument) {
      const parts: string[] = [];
      for (const id of byId.split(/\s+/)) {
        const ref = id ? control.ownerDocument.getElementById(id) : null;
        if (ref) parts.push(clean(ref.textContent, NAME_CAP));
      }
      const joined = parts.filter(Boolean).join(' ');
      if (joined) return joined;
    }
    const labels = control.labels;
    if (labels && labels.length > 0) {
      for (let i = 0; i < labels.length; i++) {
        const t = clean(labels[i].textContent, NAME_CAP);
        if (t) return t;
      }
    }
    const wrapping = control.closest ? control.closest('label') : null;
    if (wrapping) return clean(wrapping.textContent, NAME_CAP);
    return '';
  };

  /** Tags that flow inside a line of text. Everything else, including an
   *  element this does not know, counts as a block and makes its parent a
   *  container. Unknown-means-block is the safe way round: a caption that
   *  was not taken costs a name, a caption taken off a container is the
   *  page read back as one. */
  const INLINE_TAGS: Record<string, true> = {
    a: true, abbr: true, b: true, bdi: true, bdo: true, br: true, cite: true, code: true,
    data: true, dfn: true, em: true, i: true, img: true, kbd: true, mark: true, picture: true,
    q: true, rp: true, rt: true, ruby: true, s: true, samp: true, small: true, span: true,
    strong: true, sub: true, sup: true, time: true, u: true, var: true, wbr: true,
  };

  // The caption. A control's own label includes what is drawn inside it, so
  // an interactive control reads its whole subtree — that is the point of
  // reading it. Anything else is an element the click landed on, and it may
  // only be named by a line of text it actually holds: one block-level child
  // and it is a layout container, whose contents are the page.
  const caption = (): string => {
    if (controlIsInteractive) return control.textContent ?? '';
    const kids = control.childNodes;
    if (!kids) return '';
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n && n.nodeType === ELEMENT_NODE && !INLINE_TAGS[(n.tagName ?? '').toLowerCase()]) return '';
    }
    return control.textContent ?? '';
  };

  // Each candidate is tried in order and the first non-empty one wins; the
  // truncation flag is reset before each so it describes the chosen name
  // only.
  const candidates: Array<() => string> = [
    () => attr(control, 'aria-label'),
    () => labelText(),
    () => attr(control, 'placeholder'),
    () => attr(control, 'title'),
    () => attr(control, 'alt'),
    () => attr(control, 'name'),
    () => (captionAllowed ? caption() : ''),
  ];
  let name = '';
  for (const candidate of candidates) {
    nameTruncated = false;
    name = clean(candidate(), NAME_CAP);
    if (name) break;
  }

  return {
    tag: clean(tag, TAG_CAP),
    role: clean(role, ROLE_CAP),
    inputType: clean(inputType, INPUT_TYPE_CAP),
    autocomplete: clean(autocomplete, AUTOCOMPLETE_CAP),
    name,
    nameTruncated: name.length > 0 && nameTruncated,
    control,
  };
}
