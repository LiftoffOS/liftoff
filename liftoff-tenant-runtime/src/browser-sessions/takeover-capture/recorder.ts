// The recorder that runs inside the session's page, and the names it binds to.
//
// It is installed by Node into a CDP ISOLATED WORLD of every frame — never the
// page's own world — and it reaches Node through a `Runtime.addBinding` scoped
// to that world by name. That is the whole security argument, so it is worth
// stating once: an isolated world shares the DOM with the page but has its
// own globals and prototypes. Page code holds no reference to this function,
// to its listeners, or to the binding, and cannot patch the `JSON`,
// `Event.prototype.isTrusted` or `EventTarget.prototype.addEventListener` the
// recorder uses, because the page's copies are different objects. A
// script-dispatched event still reaches the shared DOM and is dropped here by
// `isTrusted`, which page code cannot influence in this world. No token is
// needed and none is used.
//
// Listeners go on `window` in the CAPTURE phase at document start — before any
// page script, on a new document — so a page's own capture listener cannot
// pre-empt them there. On a document that was ALREADY loaded when the
// recorder attached, a page listener registered earlier can still call
// `stopImmediatePropagation` first and hide an event; that is a documented
// limit (`capture.browser.test.ts` pins it) and the reason `capture_gap =
// false` means "no KNOWN interruption" rather than proof of completeness.
//
// The recorder is idempotent per execution context: a frame may receive the
// init script automatically and be evaluated into once more by the attach
// pass, and it must install once. The guard lives on the isolated world's
// global, which the page cannot see.
//
// WHAT IT RECORDS. The pages the person opened (`navigate`, made in Node from
// the frame events), the controls they used and — since 424 — the value they
// entered, unless `classifyProtectedControl` says the control is
// authentication, payment, high-risk identity or file input, in which case
// no value is read at all and only the omitted class travels. The
// classification runs BEFORE the value read, on the actual containing form,
// which is what lets a sign-in form's username be omitted with its password.
// Non-textual interactions travel too: an allow-listed key chord, a debounced
// scroll to a position, a drag, a context menu, a pointer resting on a
// control, and element-relative coordinates for an unnamed click. A printable
// keystroke is never recorded on its own.
//
// The URL projection, the control description and the protected-control
// classifier are the SAME functions Node uses, embedded by source
// (`Function.prototype.toString()`), which is why all three are written
// self-contained. `recorder-sources.test.ts` holds this file to the order
// those reads may happen in: a value only after the classifier answered
// recordable, a file input never, and every URL through `recordedUrl`.

import { recordedUrl } from './route-template';
import { describeTarget } from './describe-target';
import { classifyProtectedControl } from './protected-control';
import { ACTION_FIELD_CAPS } from './action';
import {
  activeElementInWorld, focusControlInWorld, hitTestControl, selectOptionInWorld, walkPageControls,
} from './page-controls';

/** The name the page readers hang off the isolated world's global, for
 *  Node's `Runtime.evaluate` in that world: the control walk, the hit test,
 *  the in-world select, the active-element check and the point resolver
 *  (page-controls.ts). Page code cannot see the world's global. */
export const PAGE_READERS = '__liftoffPage';

/** The binding name, as `Runtime.addBinding` installs it on the isolated
 *  world's global. Fixed across holds: the world's NAME is what scopes it. */
export const TAKEOVER_BINDING = '__liftoffTakeoverRecord';

/** The isolated world's name, one per hold so a stale world from an earlier
 *  hold on the same page can never feed a newer one. */
export function takeoverWorldNameFor(holdId: string): string {
  return `takeover-${holdId}`;
}

/** A call-scoped task capture's world, one per task. */
export function taskWorldNameFor(captureId: string): string {
  return `task-${captureId}`;
}

/** A session capture's world: the recorder attached for the session's
 *  lifetime (session-capture.ts), one per warm attempt, so a stale world
 *  from an earlier attempt on the same page can never feed a newer one. */
export function sessionWorldNameFor(sessionId: string, attemptId: string): string {
  return `session-${sessionId}-${attemptId}`;
}

/** How long a pointer must rest on an interactive control before that is a
 *  hover, and how long a scroll must be quiet before its position is final. */
export const HOVER_SETTLE_MS = 500;
export const SCROLL_SETTLE_MS = 300;

/** The recorder, as one self-invoking script. Built once per process; the
 *  same source is handed to `Page.addScriptToEvaluateOnNewDocument` (future
 *  documents) and to `Runtime.evaluate` in each already-loaded frame's world. */
export function takeoverRecorderSource(): string {
  return `(function () {
  var g = globalThis;
  if (g.__liftoffTakeoverInstalled) return;
  g.__liftoffTakeoverInstalled = true;
  var recordedUrl = ${recordedUrl.toString()};
  var describeTarget = ${describeTarget.toString()};
  var classifyProtectedControl = ${classifyProtectedControl.toString()};
  var walkPageControls = ${walkPageControls.toString()};
  var hitTestControl = ${hitTestControl.toString()};
  var selectOptionInWorld = ${selectOptionInWorld.toString()};
  var activeElementInWorld = ${activeElementInWorld.toString()};
  var focusControlInWorld = ${focusControlInWorld.toString()};
  var pageDeps = { describeTarget: describeTarget, classifyProtectedControl: classifyProtectedControl, recordedUrl: recordedUrl };
  // The page readers, for Node to call in this world (page-controls.ts).
  g[${JSON.stringify(PAGE_READERS)}] = {
    controls: function (opts) { return walkPageControls(pageDeps, opts); },
    hit: function (id, opts) { return hitTestControl(pageDeps, id, opts); },
    select: function (id, value) { return selectOptionInWorld(pageDeps, id, value); },
    active: function (id) { return activeElementInWorld(pageDeps, id); },
    focus: function (id) { return focusControlInWorld(pageDeps, id); },
    frameElement: function (i) { var fs = g.__liftoffFrameElements; return Array.isArray(fs) ? fs[i] || null : null; },
  };
  var CAPS = ${JSON.stringify(ACTION_FIELD_CAPS)};
  var HOVER_SETTLE_MS = ${HOVER_SETTLE_MS};
  var SCROLL_SETTLE_MS = ${SCROLL_SETTLE_MS};
  var nonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + String(Math.random()).slice(2);
  var seq = 0;
  function bounded(text, cap) {
    var whole = (typeof text === 'string' ? text : '').replace(/\\s+/g, ' ').trim();
    return { text: whole.slice(0, cap), truncated: whole.length > cap };
  }
  function pageUrl() {
    // The whole href goes to the policy; nothing is dropped before it runs.
    return recordedUrl(location.href);
  }
  function attr(el, name) {
    var v = el && el.getAttribute ? el.getAttribute(name) : null;
    return typeof v === 'string' ? v : '';
  }
  function tagOf(el) { return el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''; }
  function typeOf(el) { return tagOf(el) === 'input' ? (attr(el, 'type').toLowerCase() || 'text') : ''; }
  function evidenceOf(el, name) {
    return {
      tag: tagOf(el),
      type: typeOf(el),
      name: name || '',
      attrName: attr(el, 'name'),
      id: attr(el, 'id'),
      placeholder: attr(el, 'placeholder'),
      autocomplete: attr(el, 'autocomplete'),
    };
  }
  function formOf(el) {
    var f = el && el.form ? el.form : (el && el.closest ? el.closest('form') : null);
    return f && tagOf(f) === 'form' ? f : null;
  }
  function formFieldsOf(form) {
    var out = [];
    if (!form || !form.elements) return out;
    var els = form.elements;
    for (var i = 0; i < els.length && i < 200; i++) {
      var f = els[i];
      var t = tagOf(f);
      if (t !== 'input' && t !== 'textarea' && t !== 'select') continue;
      var d = describeTarget({ type: 'change', target: f, composedPath: function () { return [f]; } });
      out.push(evidenceOf(f, d ? d.name : ''));
    }
    return out;
  }
  function isEditable(el) {
    var t = tagOf(el);
    if (t === 'textarea' || t === 'select') return true;
    if (t === 'input') {
      var ty = typeOf(el);
      return ty !== 'hidden' && ty !== 'submit' && ty !== 'button' && ty !== 'reset' && ty !== 'image';
    }
    return el && el.isContentEditable === true;
  }
  function classify(el, name) {
    var evidence = evidenceOf(el, name);
    evidence.formFields = formFieldsOf(formOf(el));
    evidence.url = location.href;
    return classifyProtectedControl(evidence);
  }
  // The value read: ONLY here, ONLY after classify() answered '', and never
  // on a file input, which is refused by the classifier before this runs.
  function readValue(el) {
    var t = tagOf(el);
    if (t === 'select') {
      var chosen = [];
      var opts = el.selectedOptions || [];
      for (var i = 0; i < opts.length && i < 50; i++) {
        chosen.push((opts[i].textContent || opts[i].value || '').replace(/\\s+/g, ' ').trim());
      }
      return chosen.join(', ');
    }
    if (t === 'input') {
      var ty = typeOf(el);
      if (ty === 'checkbox' || ty === 'radio') return el.checked ? 'checked' : 'unchecked';
      return typeof el.value === 'string' ? el.value : '';
    }
    if (t === 'textarea') return typeof el.value === 'string' ? el.value : '';
    if (el && el.isContentEditable === true) return typeof el.textContent === 'string' ? el.textContent : '';
    return '';
  }
  function valueOf(el, name) {
    var cls = classify(el, name);
    if (cls === 'authentication') return { value: '', truncated: false, disposition: 'authentication_omitted' };
    if (cls === 'payment') return { value: '', truncated: false, disposition: 'payment_omitted' };
    if (cls === 'sensitive_identity') return { value: '', truncated: false, disposition: 'sensitive_identity_omitted' };
    if (cls === 'file') return { value: '', truncated: false, disposition: 'file_omitted' };
    var b = bounded(readValue(el), CAPS.value);
    return { value: b.text, truncated: b.truncated, disposition: 'recorded' };
  }
  function send(kind, described, extra) {
    var deliver = g[${JSON.stringify(TAKEOVER_BINDING)}];
    if (typeof deliver !== 'function') return;
    var url = pageUrl();
    var detail = bounded(extra && extra.detail, CAPS.detail);
    var payload = {
      nonce: nonce,
      seq: seq++,
      kind: kind,
      url: url.text,
      urlTruncated: url.truncated,
      urlProtectedDataOmitted: url.protectedDataOmitted,
      tag: described ? described.tag : '',
      role: described ? described.role : '',
      name: described ? described.name : '',
      nameTruncated: described ? described.nameTruncated === true : false,
      inputType: described ? described.inputType : '',
      value: extra && typeof extra.value === 'string' ? extra.value : '',
      valueTruncated: extra ? extra.valueTruncated === true : false,
      valueDisposition: extra && extra.valueDisposition ? extra.valueDisposition : 'none',
      detail: detail.text,
      detailTruncated: detail.truncated,
      at: Date.now(),
    };
    try { deliver(JSON.stringify(payload)); } catch (_) { /* a lost action, not a lost page */ }
  }
  function trusted(event) { return !!event && event.isTrusted === true; }
  function chordOf(event) {
    var parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.metaKey) parts.push('Meta');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.key === ' ' ? 'Space' : event.key);
    return parts.join('+');
  }
  var KEY_ALLOWLIST = { Tab: true, Escape: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
    Home: true, End: true, PageUp: true, PageDown: true, ' ': true, Enter: true };
  // The last value-bearing action per control, so a change or focusout that
  // repeats the Enter value already sent is not recorded twice.
  var lastEntered = typeof WeakMap === 'function' ? new WeakMap() : null;
  function alreadySent(el, kind, value) {
    if (!lastEntered || !el) return false;
    var last = lastEntered.get(el);
    return !!last && last.kind === 'enter' && kind !== 'enter' && last.value === value;
  }
  function remember(el, kind, value) {
    if (lastEntered && el) lastEntered.set(el, { kind: kind, value: value });
  }
  function recordValue(kind, event, extraDetail) {
    var d = describeTarget(event);
    if (!d || !d.control) return;
    var v = valueOf(d.control, d.name);
    if (v.disposition === 'recorded' && alreadySent(d.control, kind, v.value)) return;
    remember(d.control, kind, v.value);
    send(kind, d, { value: v.value, valueTruncated: v.truncated, valueDisposition: v.disposition, detail: extraDetail || '' });
  }
  function clickDetail(event, d) {
    var parts = [];
    if (typeof event.detail === 'number' && event.detail > 1) parts.push('click ' + event.detail);
    var t = d ? d.tag : '';
    var unnamed = !d || !d.name;
    if ((unnamed || t === 'canvas' || t === 'svg') && d && d.control && d.control.getBoundingClientRect) {
      var r = d.control.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0 && typeof event.clientX === 'number') {
        var x = Math.round(((event.clientX - r.left) / r.width) * 100);
        var y = Math.round(((event.clientY - r.top) / r.height) * 100);
        parts.push('at ' + x + '%,' + y + '%');
      }
    }
    return parts.join(' ');
  }
  window.addEventListener('click', function (event) {
    if (!trusted(event)) return;
    var d = describeTarget(event);
    send('click', d, { detail: clickDetail(event, d) });
  }, true);
  window.addEventListener('contextmenu', function (event) {
    if (!trusted(event)) return;
    send('contextmenu', describeTarget(event), null);
  }, true);
  window.addEventListener('submit', function (event) {
    if (!trusted(event)) return;
    send('submit', describeTarget(event), null);
  }, true);
  window.addEventListener('change', function (event) {
    if (!trusted(event)) return;
    recordValue('change', event, '');
  }, true);
  window.addEventListener('focusout', function (event) {
    if (!trusted(event)) return;
    var el = event.target;
    if (!el || el.isContentEditable !== true) return;
    recordValue('change', event, '');
  }, true);
  window.addEventListener('keydown', function (event) {
    if (!trusted(event) || typeof event.key !== 'string') return;
    var d = describeTarget(event);
    var el = d ? d.control : null;
    if (event.key === 'Enter' && el && isEditable(el)) {
      // The value at this moment: the page can unload before change fires.
      recordValue('enter', event, event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ? chordOf(event) : '');
      return;
    }
    if (!KEY_ALLOWLIST[event.key]) return;
    send('key', d, { detail: chordOf(event) });
  }, true);
  window.addEventListener('dragstart', function (event) {
    if (!trusted(event)) return;
    var d = describeTarget(event);
    g.__liftoffDragSource = d ? (d.tag + (d.role ? ' ' + d.role : '') + (d.name ? ' "' + d.name + '"' : '')) : '';
  }, true);
  window.addEventListener('drop', function (event) {
    if (!trusted(event)) return;
    var source = typeof g.__liftoffDragSource === 'string' ? g.__liftoffDragSource : '';
    g.__liftoffDragSource = '';
    send('drag', describeTarget(event), { detail: source ? 'from ' + source : 'from an unnamed source' });
  }, true);
  var scrollTimer = null;
  var scrollState = { target: null, lastX: 0, lastY: 0, startX: 0, startY: 0 };
  function scrollPos(target) {
    var doc = document.scrollingElement || document.documentElement;
    var el = target && target !== document && target !== window && target.scrollHeight != null ? target : doc;
    var maxX = Math.max(0, el.scrollWidth - el.clientWidth);
    var maxY = Math.max(0, el.scrollHeight - el.clientHeight);
    return {
      el: el === doc ? null : el,
      x: el.scrollLeft, y: el.scrollTop,
      px: maxX > 0 ? Math.round((el.scrollLeft / maxX) * 100) : 0,
      py: maxY > 0 ? Math.round((el.scrollTop / maxY) * 100) : 0,
    };
  }
  window.addEventListener('scroll', function (event) {
    if (!trusted(event)) return;
    var pos = scrollPos(event.target);
    if (scrollState.target !== event.target) {
      scrollState.target = event.target;
      scrollState.startX = scrollState.lastX = pos.x;
      scrollState.startY = scrollState.lastY = pos.y;
    }
    scrollState.lastX = pos.x;
    scrollState.lastY = pos.y;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      var target = scrollState.target;
      var dy = scrollState.lastY - scrollState.startY;
      var dx = scrollState.lastX - scrollState.startX;
      var direction = Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? 'down' : 'up') : (dx >= 0 ? 'right' : 'left');
      var final = scrollPos(target);
      var described = final.el
        ? describeTarget({ type: 'scroll', target: final.el, composedPath: function () { return [final.el]; } })
        : null;
      scrollState.target = null;
      send('scroll', described, { detail: 'scroll ' + direction + ' to ' + final.px + '%,' + final.py + '%' });
    }, SCROLL_SETTLE_MS);
  }, true);
  var hoverTimer = null;
  var hoverControl = null;
  var lastHovered = null;
  var HOVER_ROLES = { button: true, link: true, checkbox: true, radio: true, switch: true, tab: true,
    menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true, combobox: true,
    textbox: true, searchbox: true, slider: true, spinbutton: true, treeitem: true, listbox: true };
  window.addEventListener('pointerover', function (event) {
    if (!trusted(event)) return;
    var d = describeTarget(event);
    var el = d ? d.control : null;
    var interactive = !!d && HOVER_ROLES[d.role] === true;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverControl = interactive ? el : null;
    if (!hoverControl) return;
    hoverTimer = setTimeout(function () {
      hoverTimer = null;
      if (!hoverControl || hoverControl === lastHovered) return;
      lastHovered = hoverControl;
      send('hover', d, null);
    }, HOVER_SETTLE_MS);
  }, true);
  window.addEventListener('pointerout', function (event) {
    if (!trusted(event)) return;
    if (hoverTimer && event.target === hoverControl) { clearTimeout(hoverTimer); hoverTimer = null; hoverControl = null; }
  }, true);
})();`;
}
