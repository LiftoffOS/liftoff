// What the recorder is allowed to read from the page, held as a property of
// its SOURCE.
//
// The recorder runs inside a person's browser during a takeover, which skews
// toward sign-ins and other private steps. Since 424 it reads the value the
// person entered, and the contract is about ORDER and ROUTE rather than a
// blanket ban: a value may be read only after `classifyProtectedControl`
// answered recordable, a file input never reads `.value` or `.files`, and a
// URL flows only through `recordedUrl`, never constructed from
// `origin + pathname` first (which would drop the query and fragment before
// the policy ran). Those are enforced here against the source that is
// actually shipped to the page, and the schema on the Node side is pinned
// strict.

import { takeoverRecorderSource, TAKEOVER_BINDING, PAGE_READERS, takeoverWorldNameFor, taskWorldNameFor, sessionWorldNameFor } from '../recorder';
import { describeTarget } from '../describe-target';
import { recordedUrl } from '../route-template';
import { classifyProtectedControl } from '../protected-control';
import { takeoverActionPayloadSchema } from '../action';
import {
  activeElementInWorld, hitTestControl, selectOptionInWorld, walkPageControls, focusControlInWorld,
} from '../page-controls';

const source = takeoverRecorderSource();

/** The page readers Node calls on demand in the world (page-controls.ts).
 *  They read a classified control's value by design, so the recorder's own
 *  contract below is held with them stripped out, and their own order
 *  contract is held separately. */
const PAGE_READER_FUNCTIONS = [walkPageControls, hitTestControl, selectOptionInWorld, activeElementInWorld, focusControlInWorld];

/** The recorder's own body, without the embedded functions, so the
 *  contract is held against what the recorder itself does. */
function recorderBody(): string {
  let body = source
    .replace(recordedUrl.toString(), '/*recordedUrl*/')
    .replace(describeTarget.toString(), '/*describeTarget*/')
    .replace(classifyProtectedControl.toString(), '/*classifyProtectedControl*/');
  for (const fn of PAGE_READER_FUNCTIONS) body = body.replace(fn.toString(), `/*${fn.name}*/`);
  return body;
}

describe('the recorder source', () => {
  it('is one self-invoking script that binds by the fixed name and installs once per world', () => {
    expect(source.startsWith('(function () {')).toBe(true);
    expect(source).toContain(JSON.stringify(TAKEOVER_BINDING));
    expect(source).toContain('__liftoffTakeoverInstalled');
    for (const event of ['click', 'contextmenu', 'submit', 'change', 'focusout', 'keydown', 'dragstart', 'drop', 'scroll', 'pointerover', 'pointerout']) {
      expect(source).toContain(`addEventListener('${event}'`);
    }
    // Capture phase, on window: every registration ends in `, true)`.
    const registrations = source.match(/window\.addEventListener\(/g) ?? [];
    expect(registrations).toHaveLength(11);
    expect(source.match(/, true\);/g)).toHaveLength(11);
    // Trusted events only.
    expect(source).toContain('event.isTrusted === true');
  });

  it('parses as JavaScript on its own', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('embeds the same projection, description and classifier Node uses', () => {
    expect(source).toContain(recordedUrl.toString());
    expect(source).toContain(describeTarget.toString());
    expect(source).toContain(classifyProtectedControl.toString());
  });

  it('names one world per hold, one per task capture, and one per warm attempt on a session', () => {
    expect(takeoverWorldNameFor('abc')).toBe('takeover-abc');
    expect(takeoverWorldNameFor('abc')).not.toBe(takeoverWorldNameFor('abd'));
    expect(taskWorldNameFor('abc')).toBe('task-abc');
    expect(sessionWorldNameFor('sid', 'a1')).toBe('session-sid-a1');
    expect(sessionWorldNameFor('sid', 'a1')).not.toBe(sessionWorldNameFor('sid', 'a2'));
  });

  it('embeds the page readers on the world global, under one name, self-contained', () => {
    expect(source).toContain(`g[${JSON.stringify(PAGE_READERS)}] = {`);
    for (const fn of PAGE_READER_FUNCTIONS) {
      expect(source).toContain(fn.toString());
      const text = fn.toString();
      expect(text).not.toMatch(/require\(|import\(|exports\./);
      expect(() => new Function(`return (${text});`)()).not.toThrow();
    }
    // The walk classifies BEFORE it reads a value: the classify call comes
    // before the value read in addControl, and the value read is the one
    // function, reached only through valueStateOf after the kind is known.
    const walk = walkPageControls.toString();
    const addControl = walk.slice(walk.indexOf('function addControl('), walk.indexOf('function emitText('));
    expect(addControl.indexOf('classify(el, d.name, doc)')).toBeLessThan(addControl.indexOf('valueStateOf(el, kind)'));
    const valueStateOf = walk.slice(walk.indexOf('function valueStateOf('), walk.indexOf('function describe('));
    expect(valueStateOf.indexOf("if (kind) return 'protected'")).toBeLessThan(valueStateOf.indexOf('readValueState(el)'));
    expect(walk).not.toMatch(/\.files\b/);
    expect(walk).not.toMatch(/\bFormData\b/);
  });

  it('reads a value ONLY inside readValue, which runs only after classify() answered recordable', () => {
    const body = recorderBody();
    // Every `.value` / `.checked` / `.selectedOptions` read sits inside the one
    // readValue function.
    const readValueStart = body.indexOf('function readValue(el)');
    const readValueEnd = body.indexOf('function valueOf(el, name)');
    expect(readValueStart).toBeGreaterThan(0);
    expect(readValueEnd).toBeGreaterThan(readValueStart);
    const inside = body.slice(readValueStart, readValueEnd);
    const outside = body.slice(0, readValueStart) + body.slice(readValueEnd);
    for (const read of [/\.checked\b/, /\.selectedOptions\b/, /\.valueAsNumber\b/, /\.valueAsDate\b/]) {
      expect(outside).not.toMatch(read);
    }
    // Outside readValue, `.value` is only ever the recorder's OWN objects (the
    // caps table, the valueOf result, the send extras, the dedupe memo),
    // never an element.
    const ownValueReads = outside.match(/[A-Za-z_$][\w$]*\.value\b/g) ?? [];
    expect(ownValueReads.length).toBeGreaterThan(0);
    for (const read of ownValueReads) {
      expect(['CAPS.value', 'v.value', 'extra.value', 'last.value']).toContain(read);
    }
    expect(inside).toMatch(/\bel\.value\b/);
    // valueOf classifies first and returns an omitted disposition without
    // ever reaching readValue for a protected control.
    const valueOf = body.slice(readValueEnd, body.indexOf('function send('));
    expect(valueOf.indexOf('classify(el, name)')).toBeLessThan(valueOf.indexOf('readValue(el)'));
    for (const cls of ['authentication', 'payment', 'sensitive_identity', 'file']) {
      expect(valueOf.indexOf(`cls === '${cls}'`)).toBeLessThan(valueOf.indexOf('readValue(el)'));
    }
  });

  it('never reads a file input: no .files, no FormData, and the classifier refuses type=file before any read', () => {
    expect(recorderBody()).not.toMatch(/\.files\b/);
    expect(recorderBody()).not.toMatch(/\bFormData\b/);
    expect(classifyProtectedControl({ tag: 'input', type: 'file' })).toBe('file');
  });

  it('reads the URL through recordedUrl only: location.href goes to the policy whole, never origin + pathname first', () => {
    const body = recorderBody();
    expect(body).toContain('recordedUrl(location.href)');
    expect(body).not.toMatch(/location\.origin\s*\+/);
    expect(body).not.toMatch(/location\.pathname/);
    expect(body).not.toMatch(/location\.search/);
    expect(body).not.toMatch(/location\.hash/);
    // The classifier is given the raw href so a route can be recognised; it
    // reads only the route from it.
    expect(body).toContain('evidence.url = location.href');
  });

  it('never reads whole-page text', () => {
    for (const read of [/document\.body\b/, /\.innerText\b/, /\.innerHTML\b/, /\.outerHTML\b/, /document\.title/]) {
      expect(recorderBody()).not.toMatch(read);
    }
  });

  it('never records a printable keystroke on its own: keys are allow-listed', () => {
    const body = recorderBody();
    expect(body).toContain('KEY_ALLOWLIST');
    expect(body).toContain("if (!KEY_ALLOWLIST[event.key]) return;");
    expect(body).not.toMatch(/addEventListener\('keypress'/);
    expect(body).not.toMatch(/addEventListener\('input'/);
  });

  it('is self-contained: every embedded function evaluates in a bare realm', () => {
    for (const fn of [recordedUrl, describeTarget, classifyProtectedControl]) {
      const text = fn.toString();
      expect(text).not.toMatch(/require\(|import\(|exports\./);
      expect(() => new Function(`return (${text});`)()).not.toThrow();
    }
    const evaluated = new Function(`return (${classifyProtectedControl.toString()});`)() as typeof classifyProtectedControl;
    expect(evaluated({ tag: 'input', type: 'password' })).toBe('authentication');
    expect(evaluated({ tag: 'input', type: 'text', name: 'Search all issues' })).toBe('');
  });
});

describe('the binding schema', () => {
  const ok = {
    nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
    tag: 'button', role: 'button', name: 'Go', nameTruncated: false, inputType: '',
    value: '', valueTruncated: false, valueDisposition: 'none', detail: '', detailTruncated: false, at: 1,
  };

  it('is strict: an extra key is a rejection, not a passenger', () => {
    expect(takeoverActionPayloadSchema.safeParse(ok).success).toBe(true);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, files: ['a.pdf'] }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, kind: 'navigate' }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, name: 'x'.repeat(201) }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, value: 'x'.repeat(2001) }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, detail: 'x'.repeat(401) }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, url: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('admits every binding kind and disposition, and refuses legacy_unavailable from the page', () => {
    for (const kind of ['click', 'submit', 'change', 'enter', 'key', 'scroll', 'drag', 'contextmenu', 'hover']) {
      expect(takeoverActionPayloadSchema.safeParse({ ...ok, kind }).success).toBe(true);
    }
    for (const d of ['none', 'recorded', 'authentication_omitted', 'payment_omitted', 'sensitive_identity_omitted', 'file_omitted', 'sensitive_text_omitted']) {
      expect(takeoverActionPayloadSchema.safeParse({ ...ok, valueDisposition: d }).success).toBe(true);
    }
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, valueDisposition: 'legacy_unavailable' }).success).toBe(false);
    expect(takeoverActionPayloadSchema.safeParse({ ...ok, valueDisposition: 'credential' }).success).toBe(false);
  });
});
