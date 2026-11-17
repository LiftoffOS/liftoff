// The page's controls and text, read in the recorder's isolated world.
//
// The fine-grained pane actions (browser-sessions/pane-actions.ts) name a
// control by what it is, `(role, name, nth)`, act on it with trusted input at
// its box, and refuse when something covers it. Everything they need to know
// about the page is read HERE, in the same isolated world the takeover
// recorder runs in, by the same `describeTarget` and
// `classifyProtectedControl` the recorder uses, embedded by source
// (`Function.prototype.toString()`) into the recorder script (recorder.ts)
// and reached from Node through `Runtime.evaluate` in that world's context.
// Page code holds no reference to any of it.
//
// CLASSIFY BEFORE READING. No value of a form control is read before the
// control is classified; a protected control (authentication, payment,
// high-risk identity, file) contributes its role, name and kind, and its
// value state is the word `protected`. The text projection follows the same
// rule for every control it names.
//
// Self-contained by design: each exported function references nothing
// outside its own body except its parameters. The DOM types are structural
// stand-ins, because this runtime is compiled without the DOM lib; they
// describe exactly what the functions touch.

import type { DomEventLike, TargetDescription } from './describe-target';
import type { ProtectedControlClass, ProtectedControlEvidence } from './protected-control';

/** The functions the walker is handed, by the recorder script. */
export interface PageControlsDeps {
  describeTarget: (event: DomEventLike) => TargetDescription | null;
  classifyProtectedControl: (evidence: ProtectedControlEvidence) => ProtectedControlClass;
  recordedUrl: (url: string) => { text: string; truncated: boolean; protectedDataOmitted: boolean };
}

/** A control's identity: recomputed from the DOM on every use, so it
 *  survives a change of instance and of connection. `nth` counts, in
 *  document order over the whole walk of one document space, the controls
 *  with the same role and name. A cross-origin frame is its own space. */
export interface ControlIdentity {
  role: string;
  name: string;
  nth: number;
}

export interface WalkedControl extends ControlIdentity {
  tag: string;
  inputType: string;
  /** The control's autocomplete token, lowercased; '' when it has none. Read
   *  for the classifier already; carried so the saved-login fill can tell a
   *  one-time-code box from the rest without a second read. Not on the
   *  model-facing listing. */
  autocomplete: string;
  /** Which form the control belongs to, as an index within this document
   *  space ('f0', 'f1', …); '' when it is in none. The saved-login fill reads
   *  it to keep to the sign-in form the password is in rather than typing a
   *  username into whatever text box the page happens to show first. Not on
   *  the model-facing listing. */
  formKey: string;
  nameTruncated: boolean;
  /** The value of a text-like control, "checked" / "unchecked", the selected
   *  option's label; "protected" for a protected control; "" otherwise. */
  valueState: string;
  disabled: boolean;
  protectedKind: string;
  /** Outside the viewport at walk time. */
  offscreen: boolean;
  /** Viewport coordinates of the control's box (a same-origin frame's box
   *  added); for a cross-origin frame's own walk, frame coordinates. */
  box: { x: number; y: number; width: number; height: number };
  /** Position in document order, across the placeholders of cross-origin
   *  frames, so their controls can be merged in their place. */
  docIndex: number;
}

/** A cross-origin frame the walk could not enter: its box, so its own walk
 *  can be offset and merged, and its place in document order. */
export interface WalkedFrame {
  index: number;
  box: { x: number; y: number; width: number; height: number };
  docIndex: number;
  /** Where in the text projection its text belongs. */
  textIndex: number;
}

export interface WalkResult {
  url: string;
  title: string;
  controls: WalkedControl[];
  /** Total interactive controls in this document space, before any cap. */
  total: number;
  /** The walk stopped at its hard cap. */
  hardCapped: boolean;
  frames: WalkedFrame[];
  /** The projection, when asked: text segments with a placeholder index
   *  where a cross-origin frame's text belongs. */
  text: Array<string | { frame: number }> | null;
  /** A closed shadow root, or a frame with no document, was met. */
  partial: boolean;
}

export interface WalkOptions {
  includeText: boolean;
  /** Controls kept per document space at most; the rest is counted. */
  hardCap: number;
  /** Characters of text kept at most. */
  textCap: number;
}

export interface HitResult {
  found: boolean;
  role: string;
  name: string;
  tag: string;
  inputType: string;
  disabled: boolean;
  protectedKind: string;
  box: { x: number; y: number; width: number; height: number };
  /** The point a pointer would reach the control at, or null when every
   *  candidate hit something else. */
  hit: { x: number; y: number } | null;
  /** When null hit: the covering element, described. */
  coveredBy: string;
}

/**
 * Walk the document: every interactive control, visible, in document order,
 * described and classified before anything else is read; same-origin child
 * frames through contentDocument with the frame's box added; a cross-origin
 * frame recorded as a placeholder for its own walk. The text projection, when
 * asked, is the world's own: a TreeWalker over elements and text nodes,
 * block boundaries as line breaks, headings, list items, cells, links with
 * the safe href, image alt text, open shadow roots in place, form controls
 * as their recordable value or their protected marker.
 */
export function walkPageControls(deps: PageControlsDeps, opts: WalkOptions): WalkResult {
  const describeTarget = deps.describeTarget;
  const classifyProtectedControl = deps.classifyProtectedControl;
  const recordedUrl = deps.recordedUrl;
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g as unknown as {
    document: DocLike; innerWidth: number; innerHeight: number; location: { href: string };
    getComputedStyle: (el: ElLike) => { visibility: string; display: string; pointerEvents: string };
    Node?: { ELEMENT_NODE: number; TEXT_NODE: number };
  };
  const VALUE_CAP = 200;
  const NAME_CAP = 200;
  const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=true],[contenteditable=""],'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],'
    + '[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
    + '[role=treeitem],[role=listbox]';
  const frames: WalkedFrame[] = [];
  const frameElements: ElLike[] = [];
  /** Forms met in this walk, so each control can name the one it is in. */
  const forms: ElLike[] = [];
  const controls: WalkedControl[] = [];
  const counts: Record<string, number> = {};
  let docIndex = 0;
  let total = 0;
  let hardCapped = false;
  let partial = false;
  const text: Array<string | { frame: number }> = [];
  let textChars = 0;
  let textTruncated = false;

  interface ElLike {
    nodeType?: number; tagName?: string; nodeValue?: string | null; textContent?: string | null;
    childNodes?: ArrayLike<ElLike>; parentElement?: ElLike | null; parentNode?: ElLike | null;
    getAttribute?(n: string): string | null; hasAttribute?(n: string): boolean;
    getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
    getClientRects?(): ArrayLike<unknown>;
    querySelectorAll?(s: string): ArrayLike<ElLike>;
    matches?(s: string): boolean;
    closest?(s: string): ElLike | null;
    shadowRoot?: { childNodes?: ArrayLike<ElLike>; mode?: string } | null;
    contentDocument?: DocLike | null;
    isContentEditable?: boolean;
    disabled?: boolean; checked?: boolean; value?: unknown; selectedOptions?: ArrayLike<{ textContent?: string | null; value?: string }>;
    href?: unknown; alt?: string; type?: string;
    form?: ElLike | null; elements?: ArrayLike<ElLike>;
  }
  interface DocLike {
    body?: ElLike | null; documentElement?: ElLike | null; title?: string;
    querySelectorAll?(s: string): ArrayLike<ElLike>;
    defaultView?: { innerWidth: number; innerHeight: number; getComputedStyle: (el: ElLike) => { visibility: string; display: string; pointerEvents: string } } | null;
  }

  function tagOf(el: ElLike): string { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function attr(el: ElLike, name: string): string {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  function typeOf(el: ElLike): string { return tagOf(el) === 'input' ? (attr(el, 'type').toLowerCase() || 'text') : ''; }
  function bounded(s: unknown, cap: number): string {
    const whole = (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
    return whole.length > cap ? whole.slice(0, cap) : whole;
  }
  function isShown(el: ElLike, doc: DocLike): boolean {
    const view = doc.defaultView || win;
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    try {
      const cs = view.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    } catch (_) { /* no style: treat as shown */ }
    let n: ElLike | null | undefined = el;
    while (n && n.nodeType === 1) {
      if (attr(n, 'aria-hidden') === 'true') return false;
      n = n.parentElement || (n.parentNode && (n.parentNode as { host?: ElLike }).host) || null;
    }
    return true;
  }
  function boxOf(el: ElLike, offset: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    return { x: r.left + offset.x, y: r.top + offset.y, width: r.width, height: r.height };
  }
  function inViewport(box: { x: number; y: number; width: number; height: number }): boolean {
    return box.x + box.width > 0 && box.y + box.height > 0 && box.x < win.innerWidth && box.y < win.innerHeight;
  }
  function evidenceOf(el: ElLike, name: string): ProtectedControlEvidence {
    return {
      tag: tagOf(el), type: typeOf(el), name: name || '', attrName: attr(el, 'name'), id: attr(el, 'id'),
      placeholder: attr(el, 'placeholder'), autocomplete: attr(el, 'autocomplete'),
    };
  }
  function formFieldsOf(form: ElLike | null): ProtectedControlEvidence[] {
    const out: ProtectedControlEvidence[] = [];
    if (!form || !form.elements) return out;
    const els = form.elements;
    for (let i = 0; i < els.length && i < 200; i++) {
      const f = els[i];
      const t = tagOf(f);
      if (t !== 'input' && t !== 'textarea' && t !== 'select') continue;
      const d = describeTarget({ type: 'change', target: f as never, composedPath: function () { return [f as never]; } });
      out.push(evidenceOf(f, d ? d.name : ''));
    }
    return out;
  }
  /** The control's containing form, as the classifier resolves it: the
   *  `form` property (which honours a `form=` attribute) then the ancestor. */
  function formOf(el: ElLike): ElLike | null {
    const form = el.form ? el.form : (el.closest ? el.closest('form') : null);
    return form && tagOf(form) === 'form' ? form : null;
  }
  function formKeyOf(el: ElLike): string {
    const form = formOf(el);
    if (!form) return '';
    for (let i = 0; i < forms.length; i++) if (forms[i] === form) return 'f' + i;
    forms.push(form);
    return 'f' + (forms.length - 1);
  }
  function classify(el: ElLike, name: string, doc: DocLike): string {
    const evidence = evidenceOf(el, name);
    const form = el.form ? el.form : (el.closest ? el.closest('form') : null);
    evidence.formFields = formFieldsOf(form && tagOf(form) === 'form' ? form : null);
    const view = doc.defaultView as unknown as { location?: { href?: string } } | null;
    evidence.url = doc === win.document ? win.location.href : (view && view.location && view.location.href ? String(view.location.href) : win.location.href);
    return classifyProtectedControl(evidence);
  }
  // An editing host: the property where the browser has it, the attribute
  // where it does not (a DOM with no layout engine).
  function isEditingHost(el: ElLike): boolean {
    if (el.isContentEditable === true) return true;
    if (!el.hasAttribute || !el.hasAttribute('contenteditable')) return false;
    const v = attr(el, 'contenteditable').toLowerCase();
    return v === '' || v === 'true' || v === 'plaintext-only';
  }
  function isEditableControl(el: ElLike): boolean {
    const t = tagOf(el);
    if (t === 'textarea' || t === 'select') return true;
    if (t === 'input') {
      const ty = typeOf(el);
      return ty !== 'submit' && ty !== 'button' && ty !== 'reset' && ty !== 'image';
    }
    return isEditingHost(el);
  }
  // A described control's role, with the one fallback the description has
  // none for: an editing host with no ARIA role is a text box.
  function roleOf(el: ElLike, described: TargetDescription): string {
    return described.role || (isEditingHost(el) ? 'textbox' : '');
  }
  // The value read: ONLY here, ONLY after classify() answered '', and never
  // on a file input, which the classifier refuses before this runs.
  function readValueState(el: ElLike): string {
    const t = tagOf(el);
    if (t === 'select') {
      const chosen: string[] = [];
      const opts = el.selectedOptions || [];
      for (let i = 0; i < opts.length && i < 20; i++) chosen.push(bounded(opts[i].textContent || opts[i].value || '', VALUE_CAP));
      return chosen.join(', ');
    }
    if (t === 'input') {
      const ty = typeOf(el);
      if (ty === 'checkbox' || ty === 'radio') return el.checked ? 'checked' : 'unchecked';
      return bounded(typeof el.value === 'string' ? el.value : '', VALUE_CAP);
    }
    if (t === 'textarea') return bounded(typeof el.value === 'string' ? el.value : '', VALUE_CAP);
    if (isEditingHost(el)) return bounded(typeof el.textContent === 'string' ? el.textContent : '', VALUE_CAP);
    const role = attr(el, 'role').toLowerCase();
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = attr(el, 'aria-checked');
      return checked === 'true' ? 'checked' : checked === 'false' ? 'unchecked' : '';
    }
    if (role === 'tab') return attr(el, 'aria-selected') === 'true' ? 'selected' : '';
    return '';
  }
  function valueStateOf(el: ElLike, kind: string): string {
    if (kind) return 'protected';
    if (!isEditableControl(el)) {
      const role = attr(el, 'role').toLowerCase();
      if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'tab' || role === 'menuitemcheckbox' || role === 'menuitemradio') return readValueState(el);
      return '';
    }
    return readValueState(el);
  }
  function describe(el: ElLike): TargetDescription | null {
    return describeTarget({ type: 'click', target: el as never, composedPath: function () { return [el as never]; } });
  }
  function addControl(el: ElLike, doc: DocLike, offset: { x: number; y: number }): void {
    if (!isShown(el, doc)) return;
    total++;
    if (controls.length >= opts.hardCap) { hardCapped = true; return; }
    const d = describe(el);
    if (!d) return;
    // Classified BEFORE anything else is read.
    // Protection is about what a person TYPES, so it is asked only of a
    // control that takes typed input. The classifier reads an element's
    // labels before it asks whether the element is editable, which is right
    // for the recorder (a label is what names a field) and wrong for a
    // listing: a news headline reading "… cancer diagnosis" can match the
    // identity labels and be listed as protected, and the assistant would
    // tell the person it could not act on that link. A link, a
    // button, a tab: nothing can be typed into them, so nothing about them
    // is protected data.
    const kind = isEditableControl(el) ? classify(el, d.name, doc) : '';
    const role = roleOf(el, d);
    const key = role + '\u0000' + d.name;
    const nth = counts[key] || 0;
    counts[key] = nth + 1;
    const box = boxOf(el, offset);
    controls.push({
      role: role, name: bounded(d.name, NAME_CAP), nth: nth,
      tag: d.tag, inputType: d.inputType, autocomplete: d.autocomplete, formKey: formKeyOf(el),
      nameTruncated: d.nameTruncated,
      valueState: valueStateOf(el, kind),
      disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true',
      protectedKind: kind,
      offscreen: !inViewport(box),
      box: box,
      docIndex: docIndex++,
    });
  }
  function emitText(s: string): void {
    if (textTruncated || !opts.includeText) return;
    if (textChars + s.length > opts.textCap) {
      s = s.slice(0, Math.max(0, opts.textCap - textChars));
      textTruncated = true;
    }
    if (s) { text.push(s); textChars += s.length; }
  }
  const BLOCK: Record<string, boolean> = {
    p: true, div: true, section: true, article: true, header: true, footer: true, nav: true, aside: true, main: true,
    ul: true, ol: true, li: true, table: true, tr: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
    form: true, fieldset: true, blockquote: true, pre: true, hr: true, br: true, details: true, summary: true, dl: true, dt: true, dd: true,
    tbody: true, thead: true, figure: true, figcaption: true, address: true,
  };
  const SKIP: Record<string, boolean> = { script: true, style: true, noscript: true, template: true, svg: true, head: true };

  function walkNode(node: ElLike, doc: DocLike, offset: { x: number; y: number }): void {
    if (!node) return;
    if (node.nodeType === 3) {
      const s = (node.nodeValue || '').replace(/\s+/g, ' ');
      if (s.trim()) emitText(s);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (SKIP[tag]) return;
    if (attr(node, 'hidden') !== '' || attr(node, 'aria-hidden') === 'true') return;
    if (node.hasAttribute && node.hasAttribute('hidden')) return;
    try {
      const cs = (doc.defaultView || win).getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
    } catch (_) { /* no style */ }
    if (tag === 'iframe') {
      let childDoc: DocLike | null = null;
      try { childDoc = node.contentDocument || null; } catch (_) { childDoc = null; }
      const fbox = boxOf(node, offset);
      if (childDoc && (childDoc.body || childDoc.documentElement)) {
        walkNode((childDoc.body || childDoc.documentElement) as ElLike, childDoc, { x: fbox.x, y: fbox.y });
      } else {
        // Cross-origin: its own world walks it; Node merges by index.
        const idx = frames.length;
        frames.push({ index: idx, box: fbox, docIndex: docIndex++, textIndex: text.length });
        frameElements.push(node);
        if (opts.includeText) text.push({ frame: idx });
      }
      return;
    }
    const isControl = !!(node.matches && node.matches(CONTROL_SELECTOR));
    if (isControl) addControl(node, doc, offset);
    if (opts.includeText) {
      if (isControl && isEditableControl(node)) {
        const d = describe(node);
        const kind = d ? classify(node, d.name, doc) : '';
        const label = d && d.name ? ' ' + JSON.stringify(bounded(d.name, NAME_CAP)) : '';
        if (kind === 'authentication' && typeOf(node) === 'password') emitText('[password field]');
        else if (kind) emitText('[' + kind.replace(/_/g, ' ') + ' field' + label + ']');
        else {
          const vs = readValueState(node);
          emitText('[' + (d ? (roleOf(node, d) || d.tag) : tag) + label + (vs ? ': ' + JSON.stringify(vs) : '') + ']');
        }
        return;
      }
      if (tag === 'img') {
        const altText = bounded(node.alt || attr(node, 'alt'), NAME_CAP);
        if (altText) emitText('[image: ' + altText + ']');
        return;
      }
      if (tag === 'a' && node.hasAttribute && node.hasAttribute('href')) {
        const href = recordedUrl(String(node.href || attr(node, 'href'))).text;
        const inner = bounded(node.textContent, NAME_CAP);
        emitText('[' + inner + '](' + href + ')');
        return;
      }
      if (/^h[1-6]$/.test(tag)) emitText('\n' + '#'.repeat(Number(tag.charAt(1))) + ' ');
      else if (tag === 'li') emitText('\n- ');
      else if (tag === 'td' || tag === 'th') emitText(' | ');
      else if (BLOCK[tag]) emitText('\n');
    }
    if (node.shadowRoot && node.shadowRoot.childNodes) {
      const kids = node.shadowRoot.childNodes;
      for (let i = 0; i < kids.length; i++) walkNode(kids[i], doc, offset);
    } else if (tag.indexOf('-') !== -1 && !node.shadowRoot && (!node.childNodes || node.childNodes.length === 0)) {
      // A closed shadow root is invisible to script: a custom element with
      // no open root and no children is the shape one leaves behind, and
      // the record says the part was not shown rather than presenting the
      // page as complete.
      partial = true;
      emitText('[content in a closed part of the page is not shown]');
    }
    const children = node.childNodes || [];
    for (let j = 0; j < children.length; j++) walkNode(children[j], doc, offset);
    if (opts.includeText && BLOCK[tag] && tag !== 'br') emitText('\n');
  }

  const doc = win.document;
  const start = doc.body || doc.documentElement;
  if (start) walkNode(start, doc, { x: 0, y: 0 });
  g.__liftoffFrameElements = frameElements;
  const titleText = bounded(doc.title, 400);
  if (textTruncated) text.push('\n[the page text was cut at the cap]');
  return {
    url: win.location.href,
    title: titleText,
    controls: controls,
    total: total,
    hardCapped: hardCapped,
    frames: frames,
    text: opts.includeText ? text : null,
    partial: partial,
  };
}

/**
 * Find a control by its identity, scroll it into view, re-read its box and
 * classification, and ask what a pointer at the centre and at the four
 * quadrant centres would hit: the control or a descendant of it counts. The
 * first point that hits is the point to act at; when none does, the covering
 * element is described so the caller can act on it first.
 */
export function hitTestControl(deps: PageControlsDeps, id: ControlIdentity, opts: { scroll: boolean }): HitResult {
  const describeTarget = deps.describeTarget;
  const classifyProtectedControl = deps.classifyProtectedControl;
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g as unknown as { document: DocLike; location: { href: string }; getComputedStyle: (el: ElLike) => { visibility: string; display: string } };
  const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=true],[contenteditable=""],'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],'
    + '[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
    + '[role=treeitem],[role=listbox]';
  interface ElLike {
    nodeType?: number; tagName?: string; childNodes?: ArrayLike<ElLike>; parentElement?: ElLike | null; parentNode?: ElLike | null;
    getAttribute?(n: string): string | null; hasAttribute?(n: string): boolean;
    getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
    getClientRects?(): ArrayLike<unknown>;
    querySelectorAll?(s: string): ArrayLike<ElLike>; matches?(s: string): boolean; closest?(s: string): ElLike | null;
    contains?(n: ElLike): boolean; scrollIntoView?(o: unknown): void; contentDocument?: DocLike | null;
    shadowRoot?: { childNodes?: ArrayLike<ElLike>; mode?: string } | null;
    disabled?: boolean; form?: ElLike | null; elements?: ArrayLike<ElLike>; isContentEditable?: boolean;
    ownerDocument?: DocLike | null;
  }
  interface DocLike {
    body?: ElLike | null; documentElement?: ElLike | null;
    elementFromPoint?(x: number, y: number): ElLike | null;
    defaultView?: { getComputedStyle: (el: ElLike) => { visibility: string; display: string }; location?: { href: string } } | null;
  }
  function tagOf(el: ElLike): string { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function attr(el: ElLike, name: string): string {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  function typeOf(el: ElLike): string { return tagOf(el) === 'input' ? (attr(el, 'type').toLowerCase() || 'text') : ''; }
  function isEditingHost(el: ElLike): boolean {
    if (el.isContentEditable === true) return true;
    if (!el.hasAttribute || !el.hasAttribute('contenteditable')) return false;
    const v = attr(el, 'contenteditable').toLowerCase();
    return v === '' || v === 'true' || v === 'plaintext-only';
  }
  function roleOf(el: ElLike, described: TargetDescription): string {
    return described.role || (isEditingHost(el) ? 'textbox' : '');
  }
  function isEditableControl(el: ElLike): boolean {
    const t = tagOf(el);
    if (t === 'textarea' || t === 'select') return true;
    if (t === 'input') {
      const ty = typeOf(el);
      return ty !== 'submit' && ty !== 'button' && ty !== 'reset' && ty !== 'image';
    }
    return isEditingHost(el);
  }
  function isShown(el: ElLike, doc: DocLike): boolean {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    try {
      const cs = (doc.defaultView || win).getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    } catch (_) { /* no style */ }
    let n: ElLike | null | undefined = el;
    while (n && n.nodeType === 1) {
      if (attr(n, 'aria-hidden') === 'true') return false;
      n = n.parentElement || (n.parentNode && (n.parentNode as { host?: ElLike }).host) || null;
    }
    return true;
  }
  function describe(el: ElLike): TargetDescription | null {
    return describeTarget({ type: 'click', target: el as never, composedPath: function () { return [el as never]; } });
  }
  // The same walk as walkPageControls, counting the same way, over the same
  // document spaces (same-origin frames through contentDocument), so `nth`
  // means the same thing here as it did in the listing.
  const counts: Record<string, number> = {};
  let found: { el: ElLike; doc: DocLike; offset: { x: number; y: number }; described: TargetDescription } | null = null;
  function visit(node: ElLike, doc: DocLike, offset: { x: number; y: number }): void {
    if (found || !node || node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript' || tag === 'svg') return;
    if (attr(node, 'aria-hidden') === 'true') return;
    try {
      const cs = (doc.defaultView || win).getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
    } catch (_) { /* no style */ }
    if (tag === 'iframe') {
      let childDoc: DocLike | null = null;
      try { childDoc = node.contentDocument || null; } catch (_) { childDoc = null; }
      if (childDoc && (childDoc.body || childDoc.documentElement)) {
        const r = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        visit((childDoc.body || childDoc.documentElement) as ElLike, childDoc, { x: r.left + offset.x, y: r.top + offset.y });
      }
      return;
    }
    if (node.matches && node.matches(CONTROL_SELECTOR) && isShown(node, doc)) {
      const d = describe(node);
      if (d) {
        const role = roleOf(node, d);
        const key = role + '\u0000' + d.name;
        const nth = counts[key] || 0;
        counts[key] = nth + 1;
        if (role === id.role && d.name === id.name && nth === id.nth) {
          found = { el: node, doc: doc, offset: offset, described: { tag: d.tag, role: role, inputType: d.inputType, autocomplete: d.autocomplete, name: d.name, nameTruncated: d.nameTruncated, control: d.control } };
          return;
        }
      }
    }
    if (node.shadowRoot && node.shadowRoot.childNodes) {
      const kids = node.shadowRoot.childNodes;
      for (let i = 0; i < kids.length && !found; i++) visit(kids[i], doc, offset);
    }
    const children = node.childNodes || [];
    for (let j = 0; j < children.length && !found; j++) visit(children[j], doc, offset);
  }
  const start = win.document.body || win.document.documentElement;
  if (start) visit(start, win.document, { x: 0, y: 0 });
  const none: HitResult = { found: false, role: '', name: '', tag: '', inputType: '', disabled: false, protectedKind: '', box: { x: 0, y: 0, width: 0, height: 0 }, hit: null, coveredBy: '' };
  if (!found) return none;
  const f = found as { el: ElLike; doc: DocLike; offset: { x: number; y: number }; described: TargetDescription };
  const el = f.el;
  if (opts.scroll && el.scrollIntoView) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { /* not scrollable */ }
  }
  const d2 = f.described;
  const evidence: ProtectedControlEvidence = {
    tag: tagOf(el), type: typeOf(el), name: d2.name, attrName: attr(el, 'name'), id: attr(el, 'id'),
    placeholder: attr(el, 'placeholder'), autocomplete: attr(el, 'autocomplete'),
  };
  const form = el.form ? el.form : (el.closest ? el.closest('form') : null);
  const fields: ProtectedControlEvidence[] = [];
  if (form && form.elements) {
    for (let k = 0; k < form.elements.length && k < 200; k++) {
      const fe = form.elements[k];
      const t2 = tagOf(fe);
      if (t2 !== 'input' && t2 !== 'textarea' && t2 !== 'select') continue;
      const fd = describe(fe);
      fields.push({ tag: t2, type: typeOf(fe), name: fd ? fd.name : '', attrName: attr(fe, 'name'), id: attr(fe, 'id'), placeholder: attr(fe, 'placeholder'), autocomplete: attr(fe, 'autocomplete') });
    }
  }
  evidence.formFields = fields;
  evidence.url = f.doc === win.document ? win.location.href : (f.doc.defaultView && f.doc.defaultView.location ? f.doc.defaultView.location.href : win.location.href);
  // Asked of a control that takes typed input only, as the walk asks it.
  const kind = isEditableControl(el) ? classifyProtectedControl(evidence) : '';
  const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const box = { x: r2.left + f.offset.x, y: r2.top + f.offset.y, width: r2.width, height: r2.height };
  // Frame-relative candidates: the centre first, then the four quadrants.
  const cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
  const qx = r2.width / 4, qy = r2.height / 4;
  const candidates = [
    { x: cx, y: cy }, { x: cx - qx, y: cy - qy }, { x: cx + qx, y: cy - qy }, { x: cx - qx, y: cy + qy }, { x: cx + qx, y: cy + qy },
  ];
  let hit: { x: number; y: number } | null = null;
  let cover: ElLike | null = null;
  for (let c = 0; c < candidates.length; c++) {
    const p = candidates[c];
    const at: ElLike | null = f.doc.elementFromPoint ? f.doc.elementFromPoint(p.x, p.y) : null;
    // Through an open shadow root: the host is what elementFromPoint answers
    // from outside; a descendant inside counts through the host.
    if (at && (at === el || (el.contains && el.contains(at)) || (at.shadowRoot && at.shadowRoot.childNodes && el.contains && el.contains(at)))) {
      hit = { x: p.x + f.offset.x, y: p.y + f.offset.y };
      break;
    }
    // A control inside the host's shadow tree: elementFromPoint in the light
    // DOM answers the host, which contains nothing of the shadow tree by
    // `contains`; walk up from the control to see whether the hit is its host.
    let host: ElLike | null | undefined = el;
    while (host && host !== at) host = host.parentElement || (host.parentNode && (host.parentNode as { host?: ElLike }).host) || null;
    if (host === at && at) {
      hit = { x: p.x + f.offset.x, y: p.y + f.offset.y };
      break;
    }
    if (!cover && at) cover = at;
  }
  let coveredBy = '';
  if (!hit && cover) {
    const cd = describe(cover);
    coveredBy = cd ? (cd.role || cd.tag) + (cd.name ? ' ' + JSON.stringify(cd.name) : '') : 'an element';
  }
  return {
    found: true,
    role: d2.role, name: d2.name, tag: d2.tag, inputType: d2.inputType,
    disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true',
    protectedKind: kind,
    box: box,
    hit: hit,
    coveredBy: coveredBy,
  };
}

/**
 * Choose an option of a native select, in the world: by label then by
 * value, through the native prototype setter, with `input` and `change`
 * dispatched bubbling, as Playwright's own injected script does.
 */
export function selectOptionInWorld(
  deps: PageControlsDeps,
  id: ControlIdentity,
  value: string,
): { outcome: 'selected' | 'option_not_found' | 'control_not_found' | 'not_select'; label: string } {
  const describeTarget = deps.describeTarget;
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g as unknown as { document: DocLike; Event: new (type: string, init: { bubbles: boolean }) => unknown; HTMLSelectElement?: { prototype: unknown } };
  const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=true],[contenteditable=""],'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],'
    + '[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
    + '[role=treeitem],[role=listbox]';
  interface ElLike {
    nodeType?: number; tagName?: string; childNodes?: ArrayLike<ElLike>; parentElement?: ElLike | null; parentNode?: ElLike | null;
    getAttribute?(n: string): string | null; matches?(s: string): boolean; getClientRects?(): ArrayLike<unknown>;
    contentDocument?: DocLike | null; shadowRoot?: { childNodes?: ArrayLike<ElLike> } | null;
    options?: ArrayLike<{ textContent?: string | null; value: string; selected: boolean; index: number }>;
    selectedIndex?: number; value?: string; dispatchEvent?(e: unknown): boolean;
  }
  interface DocLike { body?: ElLike | null; documentElement?: ElLike | null }
  function tagOf(el: ElLike): string { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function attr(el: ElLike, name: string): string {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  const counts: Record<string, number> = {};
  let found: ElLike | null = null;
  function visit(node: ElLike): void {
    if (found || !node || node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript' || tag === 'svg') return;
    if (attr(node, 'aria-hidden') === 'true') return;
    if (tag === 'iframe') {
      let childDoc: DocLike | null = null;
      try { childDoc = node.contentDocument || null; } catch (_) { childDoc = null; }
      if (childDoc && (childDoc.body || childDoc.documentElement)) visit((childDoc.body || childDoc.documentElement) as ElLike);
      return;
    }
    if (node.matches && node.matches(CONTROL_SELECTOR) && node.getClientRects && node.getClientRects().length > 0) {
      const d = describeTarget({ type: 'click', target: node as never, composedPath: function () { return [node as never]; } });
      if (d) {
        const has = (node as { hasAttribute?: (n: string) => boolean }).hasAttribute;
        const editing = (node as { isContentEditable?: boolean }).isContentEditable === true
          || (!!has && has.call(node, 'contenteditable')
            && ['', 'true', 'plaintext-only'].indexOf(attr(node, 'contenteditable').toLowerCase()) !== -1);
        const role = d.role || (editing ? 'textbox' : '');
        const key = role + '\u0000' + d.name;
        const nth = counts[key] || 0;
        counts[key] = nth + 1;
        if (role === id.role && d.name === id.name && nth === id.nth) { found = node; return; }
      }
    }
    if (node.shadowRoot && node.shadowRoot.childNodes) {
      const kids = node.shadowRoot.childNodes;
      for (let i = 0; i < kids.length && !found; i++) visit(kids[i]);
    }
    const children = node.childNodes || [];
    for (let j = 0; j < children.length && !found; j++) visit(children[j]);
  }
  const start = win.document.body || win.document.documentElement;
  if (start) visit(start);
  if (!found) return { outcome: 'control_not_found', label: '' };
  const el = found as ElLike;
  if (tagOf(el) !== 'select' || !el.options) return { outcome: 'not_select', label: '' };
  const wanted = value.replace(/\s+/g, ' ').trim();
  let match: { textContent?: string | null; value: string; selected: boolean; index: number } | null = null;
  for (let k = 0; k < el.options.length && !match; k++) {
    const o = el.options[k];
    if ((o.textContent || '').replace(/\s+/g, ' ').trim() === wanted) match = o;
  }
  for (let m = 0; m < el.options.length && !match; m++) {
    if (el.options[m].value === value) match = el.options[m];
  }
  if (!match) return { outcome: 'option_not_found', label: '' };
  // The native setter, from the prototype, so a page that patched the
  // instance cannot see or swallow the change; then the two events a real
  // choice fires, bubbling.
  const proto = win.HTMLSelectElement ? win.HTMLSelectElement.prototype : null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'selectedIndex') : null;
  if (desc && desc.set) desc.set.call(el, match.index);
  else el.selectedIndex = match.index;
  if (el.dispatchEvent) {
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  return { outcome: 'selected', label: (match.textContent || match.value || '').replace(/\s+/g, ' ').trim() };
}

/**
 * Focus one control in the world, by identity, and say whether it took.
 *
 * The fallback behind a coordinate click. A click is the realistic gesture
 * and stays the first move, but its point is computed a moment before it is
 * dispatched, and a page whose layout moves in between (an ad slot filling,
 * a banner resolving, a font settling) receives the click somewhere else;
 * so does a page that pulls focus to something of its own on load. Focusing
 * the element itself cannot miss, because it names the element rather than
 * a place on the screen.
 *
 * The same walk and the same counting as `hitTestControl`, through
 * same-origin frames and open shadow roots, so `nth` means here what it
 * meant in the listing.
 */
export function focusControlInWorld(
  deps: PageControlsDeps,
  id: ControlIdentity,
): { focused: boolean } {
  const describeTarget = deps.describeTarget;
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g as unknown as { document: DocLike; getComputedStyle: (el: ElLike) => { visibility: string; display: string } };
  const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=true],[contenteditable=""],'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],'
    + '[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
    + '[role=treeitem],[role=listbox]';
  interface ElLike {
    nodeType?: number; tagName?: string; childNodes?: ArrayLike<ElLike>;
    getAttribute?(n: string): string | null; matches?(s: string): boolean; getClientRects?(): ArrayLike<unknown>;
    contentDocument?: DocLike | null; shadowRoot?: { childNodes?: ArrayLike<ElLike> } | null;
    focus?(opts?: unknown): void; scrollIntoView?(o: unknown): void; ownerDocument?: DocLike | null;
  }
  interface DocLike { body?: ElLike | null; documentElement?: ElLike | null; activeElement?: ElLike | null; defaultView?: { getComputedStyle: (el: ElLike) => { visibility: string; display: string } } | null }
  function tagOf(el: ElLike): string { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function attr(el: ElLike, name: string): string {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  function isShown(el: ElLike, doc: DocLike): boolean {
    try {
      const cs = (doc.defaultView || win).getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch (_) { /* no style: treat as shown */ }
    const rects = el.getClientRects ? el.getClientRects() : null;
    return !!rects && rects.length > 0;
  }
  function describe(el: ElLike): TargetDescription | null {
    return describeTarget({ type: 'click', target: el as never, composedPath: function () { return [el as never]; } });
  }
  const counts: Record<string, number> = {};
  let found: { el: ElLike; doc: DocLike } | null = null;
  function visit(node: ElLike, doc: DocLike): void {
    if (found || !node || node.nodeType !== 1) return;
    const tag = tagOf(node);
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript' || tag === 'svg') return;
    if (attr(node, 'aria-hidden') === 'true') return;
    if (tag === 'iframe') {
      let childDoc: DocLike | null = null;
      try { childDoc = node.contentDocument || null; } catch (_) { childDoc = null; }
      if (childDoc && (childDoc.body || childDoc.documentElement)) {
        visit((childDoc.body || childDoc.documentElement) as ElLike, childDoc);
      }
      return;
    }
    if (node.matches && node.matches(CONTROL_SELECTOR) && isShown(node, doc)) {
      const d = describe(node);
      if (d) {
        const has = (node as { hasAttribute?: (n: string) => boolean }).hasAttribute;
        const editing = (node as { isContentEditable?: boolean }).isContentEditable === true
          || (!!has && has.call(node, 'contenteditable')
            && ['', 'true', 'plaintext-only'].indexOf(attr(node, 'contenteditable').toLowerCase()) !== -1);
        const role = d.role || (editing ? 'textbox' : '');
        const key = role + '\u0000' + d.name;
        const nth = counts[key] || 0;
        counts[key] = nth + 1;
        if (role === id.role && d.name === id.name && nth === id.nth) { found = { el: node, doc: doc }; return; }
      }
    }
    if (node.shadowRoot && node.shadowRoot.childNodes) {
      const kids = node.shadowRoot.childNodes;
      for (let i = 0; i < kids.length && !found; i++) visit(kids[i], doc);
    }
    const children = node.childNodes || [];
    for (let j = 0; j < children.length && !found; j++) visit(children[j], doc);
  }
  const start = win.document.body || win.document.documentElement;
  if (start) visit(start, win.document);
  if (!found) return { focused: false };
  const target = found as { el: ElLike; doc: DocLike };
  try { if (target.el.scrollIntoView) target.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { /* not scrollable */ }
  try { if (target.el.focus) target.el.focus({ preventScroll: true }); } catch (_) { return { focused: false }; }
  return { focused: (target.doc.activeElement || null) === target.el };
}


/**
 * Whether the active element, followed through same-origin frames, is the
 * control named; and the protected class of the active element, for a key
 * press that types into whatever has focus.
 */
export function activeElementInWorld(
  deps: PageControlsDeps,
  id: ControlIdentity | null,
): { isTarget: boolean; protectedKind: string; role: string; name: string } {
  const describeTarget = deps.describeTarget;
  const classifyProtectedControl = deps.classifyProtectedControl;
  const g = globalThis as unknown as Record<string, unknown>;
  const win = g as unknown as { document: DocLike; location: { href: string } };
  const CONTROL_SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=true],[contenteditable=""],'
    + '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],'
    + '[role=menuitemradio],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],'
    + '[role=treeitem],[role=listbox]';
  interface ElLike {
    nodeType?: number; tagName?: string; childNodes?: ArrayLike<ElLike>; parentNode?: ElLike | null;
    getAttribute?(n: string): string | null; matches?(s: string): boolean; getClientRects?(): ArrayLike<unknown>;
    contentDocument?: DocLike | null; shadowRoot?: { childNodes?: ArrayLike<ElLike>; activeElement?: ElLike | null } | null;
    form?: ElLike | null; elements?: ArrayLike<ElLike>; closest?(s: string): ElLike | null;
  }
  interface DocLike { body?: ElLike | null; documentElement?: ElLike | null; activeElement?: ElLike | null; defaultView?: { location?: { href: string } } | null }
  function tagOf(el: ElLike): string { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function attr(el: ElLike, name: string): string {
    const v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  function typeOf(el: ElLike): string { return tagOf(el) === 'input' ? (attr(el, 'type').toLowerCase() || 'text') : ''; }
  function isEditingHost(el: ElLike): boolean {
    if ((el as { isContentEditable?: boolean }).isContentEditable === true) return true;
    const has = (el as { hasAttribute?: (n: string) => boolean }).hasAttribute;
    if (!has || !has.call(el, 'contenteditable')) return false;
    const v = attr(el, 'contenteditable').toLowerCase();
    return v === '' || v === 'true' || v === 'plaintext-only';
  }
  // The active element, followed through same-origin frames and open
  // shadow roots.
  let doc: DocLike = win.document;
  let active: ElLike | null = doc.activeElement || null;
  let guard = 0;
  while (active && guard++ < 20) {
    if (tagOf(active) === 'iframe') {
      let childDoc: DocLike | null = null;
      try { childDoc = active.contentDocument || null; } catch (_) { childDoc = null; }
      if (!childDoc || !childDoc.activeElement) break;
      doc = childDoc;
      active = childDoc.activeElement;
      continue;
    }
    if (active.shadowRoot && active.shadowRoot.activeElement) { active = active.shadowRoot.activeElement; continue; }
    break;
  }
  if (!active || tagOf(active) === 'body' || tagOf(active) === 'html') return { isTarget: false, protectedKind: '', role: '', name: '' };
  const d = describeTarget({ type: 'click', target: active as never, composedPath: function () { return [active as never]; } });
  const name = d ? d.name : '';
  const form = active.form ? active.form : (active.closest ? active.closest('form') : null);
  const fields: ProtectedControlEvidence[] = [];
  if (form && form.elements) {
    for (let k = 0; k < form.elements.length && k < 200; k++) {
      const fe = form.elements[k];
      const t2 = tagOf(fe);
      if (t2 !== 'input' && t2 !== 'textarea' && t2 !== 'select') continue;
      const fd = describeTarget({ type: 'change', target: fe as never, composedPath: function () { return [fe as never]; } });
      fields.push({ tag: t2, type: typeOf(fe), name: fd ? fd.name : '', attrName: attr(fe, 'name'), id: attr(fe, 'id'), placeholder: attr(fe, 'placeholder'), autocomplete: attr(fe, 'autocomplete') });
    }
  }
  const kind = classifyProtectedControl({
    tag: tagOf(active), type: typeOf(active), name: name, attrName: attr(active, 'name'), id: attr(active, 'id'),
    placeholder: attr(active, 'placeholder'), autocomplete: attr(active, 'autocomplete'), formFields: fields,
    url: doc === win.document ? win.location.href : (doc.defaultView && doc.defaultView.location ? doc.defaultView.location.href : win.location.href),
  });
  let isTarget = false;
  if (id && d) {
    // Is the active element the nth control of that role and name? Count
    // as the walk counts, over the same spaces.
    const counts: Record<string, number> = {};
    let seen = false;
    const visit = function (node: ElLike, docOf: DocLike): void {
      if (seen || !node || node.nodeType !== 1) return;
      const tag = tagOf(node);
      if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript' || tag === 'svg') return;
      if (attr(node, 'aria-hidden') === 'true') return;
      if (tag === 'iframe') {
        let cd: DocLike | null = null;
        try { cd = node.contentDocument || null; } catch (_) { cd = null; }
        if (cd && (cd.body || cd.documentElement)) visit((cd.body || cd.documentElement) as ElLike, cd);
        return;
      }
      if (node.matches && node.matches(CONTROL_SELECTOR) && node.getClientRects && node.getClientRects().length > 0) {
        const nd = describeTarget({ type: 'click', target: node as never, composedPath: function () { return [node as never]; } });
        if (nd) {
          const nrole = nd.role || (isEditingHost(node) ? 'textbox' : '');
          const key = nrole + '\u0000' + nd.name;
          const nth = counts[key] || 0;
          counts[key] = nth + 1;
          if (nrole === id.role && nd.name === id.name && nth === id.nth) { seen = true; isTarget = node === active; return; }
        }
      }
      if (node.shadowRoot && node.shadowRoot.childNodes) {
        const kids = node.shadowRoot.childNodes;
        for (let i = 0; i < kids.length && !seen; i++) visit(kids[i], docOf);
      }
      const children = node.childNodes || [];
      for (let j = 0; j < children.length && !seen; j++) visit(children[j], docOf);
    };
    const start = win.document.body || win.document.documentElement;
    if (start) visit(start, win.document);
  }
  return { isTarget: isTarget, protectedKind: kind, role: d ? (d.role || (isEditingHost(active) ? 'textbox' : '')) : '', name: name };
}

/**
 * What is under a point in this document, for a person pointing without
 * taking over: the control described (by the same `describeTarget` the
 * recorder uses, so the row reads as a click would); a same-origin frame
 * followed through contentDocument with the point translated; a cross-origin
 * frame handed back by index for its own world; nothing, when the point
 * misses the page.
 */
