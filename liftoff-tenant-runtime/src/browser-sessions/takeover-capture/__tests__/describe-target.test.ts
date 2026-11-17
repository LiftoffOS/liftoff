// The control description, over a real DOM (jsdom).
//
// What matters: the control is the first INTERACTIVE ancestor on the composed
// path, so a click on a button's inner span names the button; the accessible
// name follows a fixed precedence; implicit roles come from tag and type; and
// every field is capped. The last case sends a described control through the
// strict binding schema, because a description that does not survive the
// schema is a description nobody reads.

import { JSDOM } from 'jsdom';
import { describeTarget, type DomEventLike } from '../describe-target';
import { ACTION_FIELD_CAPS, takeoverActionPayloadSchema } from '../action';

function dom(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return window;
}

/** Describe a click DURING dispatch, as the recorder does: composedPath() is
 *  only populated while the event is in flight. */
type Fields = { tag: string; role: string; inputType: string; name: string; nameTruncated: boolean } | null;

/** The wire fields of a description, without the control element. */
function fields(d: ReturnType<typeof describeTarget>): Fields {
  if (!d) return null;
  const { tag, role, inputType, name, nameTruncated } = d;
  return { tag, role, inputType, name, nameTruncated };
}

function describeClick(
  window: ReturnType<typeof dom>,
  selector: string,
  describe: typeof describeTarget = describeTarget,
): Fields {
  const target = window.document.querySelector(selector)!;
  const event = new window.MouseEvent('click', { bubbles: true, composed: true });
  let described: ReturnType<typeof describeTarget> = null;
  const listener = (e: Event) => { described = describe(e as unknown as DomEventLike); };
  window.addEventListener('click', listener, true);
  target.dispatchEvent(event);
  window.removeEventListener('click', listener, true);
  return fields(described);
}

describe('interactive ancestor selection', () => {
  it('names the button, not the span the click landed on, with the caption including descendants', () => {
    const window = dom('<button id="b"><span>Sign</span> <span>in</span></button>');
    const d = describeClick(window, '#b span');
    expect(d).toEqual({ tag: 'button', role: 'button', inputType: '', name: 'Sign in', nameTruncated: false });
  });

  it('treats an anchor with href, a role=button div and a tabindex element as interactive', () => {
    const window = dom(`
      <a id="a" href="/x"><b>Open</b></a>
      <div id="d" role="button"><i>Go</i></div>
      <div id="t" tabindex="0"><em>Focusable</em></div>
      <a id="n"><b>No href</b></a>`);
    expect(describeClick(window, '#a b')).toMatchObject({ tag: 'a', role: 'link', name: 'Open' });
    expect(describeClick(window, '#d i')).toMatchObject({ tag: 'div', role: 'button', name: 'Go' });
    expect(describeClick(window, '#t em')).toMatchObject({ tag: 'div', role: '', name: 'Focusable' });
    // An anchor without href is not a link; the click falls to the target.
    expect(describeClick(window, '#n b')).toMatchObject({ tag: 'b', role: '' });
  });

  it('falls back to the target itself when nothing on the path is interactive', () => {
    const window = dom('<div><p id="p">Just text</p></div>');
    expect(describeClick(window, '#p')).toMatchObject({ tag: 'p', role: '', name: 'Just text' });
  });

  // A point at the blank half of a footer row must not read every word inside
  // it back as the control's name. The caption is the control's own
  // label, and only a control has one: a layout element the click landed on
  // is named by its own text, never by its descendants'.
  it('never borrows a descendant\'s text for an element that is not a control', () => {
    const page = `
      <div id="footer">
        <div class="col"><hr><div id="line">Powered by <a href="/es">Elemental Selenium</a></div></div>
      </div>
      <div id="example"><h2>Secure Area</h2><h4>Welcome to the Secure Area.</h4><a href="/logout">Logout</a></div>
      <div id="banner">You logged into a secure area!<a href="#" class="close">x</a></div>`;
    const window = dom(page);
    // The row and the block hold nothing of their own: no name.
    expect(describeClick(window, '#footer')).toMatchObject({ tag: 'div', role: '', name: '' });
    expect(describeClick(window, '#example')).toMatchObject({ tag: 'div', role: '', name: '' });
    // A line of text is still a line of text with a link in it, and reads whole.
    expect(describeClick(window, '#banner')).toMatchObject({ tag: 'div', name: 'You logged into a secure area!x' });
    expect(describeClick(window, '#line')).toMatchObject({ tag: 'div', name: 'Powered by Elemental Selenium' });
    expect(describeClick(dom('<p id="p">A sentence with <a href="/x">a link</a> in it.</p>'), '#p'))
      .toMatchObject({ tag: 'p', name: 'A sentence with a link in it.' });
    // The control inside it is still named the way a control is.
    expect(describeClick(window, '#line a')).toMatchObject({ tag: 'a', role: 'link', name: 'Elemental Selenium' });
    expect(describeClick(window, '#example h2')).toMatchObject({ tag: 'h2', role: 'heading', name: 'Secure Area' });
  });

  it('describes a submit by its submitter, else by the form without a caption', () => {
    const window = dom('<form id="f" aria-label="Checkout"><input name="q"><button id="s">Pay now</button>Lots of page text</form>');
    const form = window.document.querySelector('#f')!;
    const submitter = window.document.querySelector('#s')!;
    const withSubmitter: DomEventLike = { type: 'submit', target: form as never, submitter: submitter as never, composedPath: () => [form as never] };
    expect(describeTarget(withSubmitter)).toMatchObject({ tag: 'button', role: 'button', name: 'Pay now' });
    const withoutSubmitter: DomEventLike = { type: 'submit', target: form as never, composedPath: () => [form as never] };
    expect(fields(describeTarget(withoutSubmitter))).toEqual({ tag: 'form', role: 'form', inputType: '', name: 'Checkout', nameTruncated: false });
    const unnamedForm = dom('<form id="f"><input name="q">Lots of page text</form>').document.querySelector('#f')!;
    expect(describeTarget({ type: 'submit', target: unnamedForm as never, composedPath: () => [unnamedForm as never] }))
      .toMatchObject({ tag: 'form', name: '' });
  });

  it('returns null for an event with no element', () => {
    expect(describeTarget({ type: 'click', composedPath: () => [] })).toBeNull();
  });
});

describe('accessible-name precedence', () => {
  it('aria-label beats everything', () => {
    const window = dom('<label for="i">Email</label><input id="i" aria-label="Work email" placeholder="you@" title="t" name="email">');
    expect(describeClick(window, '#i').name).toBe('Work email');
  });

  it('then the associated label: for=, wrapping, aria-labelledby', () => {
    const window = dom(`
      <label for="a">Email address</label><input id="a" placeholder="you@">
      <label>Password <input id="b" placeholder="pw"></label>
      <span id="lbl">Company</span><input id="c" aria-labelledby="lbl" placeholder="co">`);
    expect(describeClick(window, '#a').name).toBe('Email address');
    expect(describeClick(window, '#b').name).toBe('Password');
    expect(describeClick(window, '#c').name).toBe('Company');
  });

  it('then placeholder, title, alt, name, and finally the caption', () => {
    expect(describeClick(dom('<input id="i" placeholder="Search" title="t" name="q">'), '#i').name).toBe('Search');
    expect(describeClick(dom('<input id="i" title="Tip" name="q">'), '#i').name).toBe('Tip');
    expect(describeClick(dom('<input id="i" type="image" alt="Go" name="q">'), '#i').name).toBe('Go');
    expect(describeClick(dom('<input id="i" name="q">'), '#i').name).toBe('q');
    expect(describeClick(dom('<button id="i">  Approve\n  invoice </button>'), '#i').name).toBe('Approve invoice');
  });

  it('never reads the value: a filled password field is named by its label only', () => {
    const window = dom('<label for="p">Password</label><input id="p" type="password" value="hunter2">');
    const d = describeClick(window, '#p');
    expect(d).toEqual({ tag: 'input', role: 'textbox', inputType: 'password', name: 'Password', nameTruncated: false });
    expect(JSON.stringify(d)).not.toContain('hunter2');
  });
});

describe('implicit roles', () => {
  it('by tag and input type', () => {
    const cases: Array<[string, string, string]> = [
      ['<button id="x">b</button>', 'button', ''],
      ['<input id="x" type="checkbox">', 'checkbox', 'checkbox'],
      ['<input id="x" type="radio">', 'radio', 'radio'],
      ['<input id="x" type="submit" value="Go">', 'button', 'submit'],
      ['<input id="x" type="range">', 'slider', 'range'],
      ['<input id="x" type="number">', 'spinbutton', 'number'],
      ['<input id="x" type="search">', 'searchbox', 'search'],
      ['<input id="x" type="email">', 'textbox', 'email'],
      ['<input id="x">', 'textbox', 'text'],
      ['<select id="x"><option>a</option></select>', 'combobox', ''],
      ['<select id="x" multiple><option>a</option></select>', 'listbox', ''],
      ['<textarea id="x"></textarea>', 'textbox', ''],
      ['<summary id="x">More</summary>', 'button', ''],
    ];
    for (const [html, role, inputType] of cases) {
      const d = describeClick(dom(html), '#x');
      expect({ html, role: d.role, inputType: d.inputType }).toEqual({ html, role, inputType });
    }
  });

  it('an explicit role wins over the implicit one', () => {
    expect(describeClick(dom('<button id="x" role="switch">On</button>'), '#x').role).toBe('switch');
  });
});

describe('field caps', () => {
  it('caps the name at 200 and says so, the tag at 32, the role at 64 and the input type at 32', () => {
    const window = dom(`<button id="x" role="${'r'.repeat(100)}">${'n'.repeat(300)}</button>`);
    const d = describeClick(window, '#x')!;
    expect(d.name).toHaveLength(ACTION_FIELD_CAPS.name);
    expect(d.nameTruncated).toBe(true);
    expect(d.role).toHaveLength(ACTION_FIELD_CAPS.role);
    expect(describeClick(dom('<button id="y">short</button>'), '#y')!.nameTruncated).toBe(false);
    const custom = dom(`<${'x'.repeat(50)} id="x" tabindex="0">t</${'x'.repeat(50)}>`);
    expect(describeClick(custom, '#x')!.tag).toHaveLength(ACTION_FIELD_CAPS.tag);
    const typed = dom(`<input id="x" type="${'t'.repeat(50)}">`);
    expect(describeClick(typed, '#x')!.inputType).toHaveLength(ACTION_FIELD_CAPS.inputType);
  });

  it('a named control crosses the strict payload schema with its useful text intact', () => {
    const window = dom('<label for="p">Continue as jane@example.com</label><button id="p"><span>Approve invoice #4471 for Acme Holdings Ltd</span></button>');
    const d = describeClick(window, '#p span');
    const payload = takeoverActionPayloadSchema.parse({
      nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/orders/4471', urlTruncated: false, urlProtectedDataOmitted: false,
      value: '', valueTruncated: false, valueDisposition: 'none', detail: '', detailTruncated: false, at: 1, ...d,
    });
    expect(payload.name).toBe('Continue as jane@example.com');
    expect(payload.tag).toBe('button');
  });

  it('hands the control back, for the recorder\'s value read and form evidence', () => {
    const window = dom('<form><input id="q" name="q" placeholder="Search"></form>');
    const target = window.document.querySelector('#q')!;
    const d = describeTarget({ type: 'change', target: target as never, composedPath: () => [target as never] });
    expect(d!.control).toBe(target);
    expect(fields(d)).toEqual({ tag: 'input', role: 'textbox', inputType: 'text', name: 'Search', nameTruncated: false });
  });

  it('is self-contained: its source evaluates in a bare realm', () => {
    const source = describeTarget.toString();
    expect(source).not.toMatch(/require\(|import\(|exports\./);
    const evaluated = new Function(`return (${source});`)() as typeof describeTarget;
    const window = dom('<button id="b"><span>Sign in</span></button>');
    expect(describeClick(window, '#b span', evaluated)).toEqual(describeClick(window, '#b span'));
  });
});
