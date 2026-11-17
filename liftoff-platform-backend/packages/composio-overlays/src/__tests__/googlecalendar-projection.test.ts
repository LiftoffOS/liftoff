// Google Calendar's canonical shapes, checked against what Composio actually
// returns.
//
// These entries were registered without a projection to produce them. With no
// translateOutput, the dispatcher parses Composio's raw `data` against the
// registered schema — and the two never matched, because Composio is not
// Google's reference. It returns `calendars` where the reference says `items`,
// nests a created event under `response_data`, and hands back Google's
// two-shaped `start`/`end` objects where the schema wants a string. Three of
// the toolkit's most-used tools would have thrown canonical_shape_violation on
// first use. Nothing had called them, so nothing said so.
//
// The fixtures below are shaped from Composio's published output_parameters for
// each tool and Google's Events resource reference, which is the only reason
// this test can fail for a real reason: asserting a projection against a
// fixture built from the projection would agree with itself forever.

import { GOOGLECALENDAR_OVERLAYS } from '../overlays/googlecalendar';
import { CANONICAL_RESPONSE_SHAPES } from '../canonical-shapes';

const translate = (slug: string, vendor: unknown): unknown => {
  const t = GOOGLECALENDAR_OVERLAYS[slug].translateOutput;
  if (!t) throw new Error(`${slug} has no translateOutput`);
  return t(vendor);
};

// A timed event, an all-day event, and an untitled event with no guests —
// the three variants Google's reference says are possible.
const TIMED_EVENT = {
  id: 'evt_timed',
  summary: 'Sprint review',
  htmlLink: 'https://calendar.google.com/event?eid=evt_timed',
  start: { dateTime: '2026-09-08T15:00:00Z', timeZone: 'Etc/UTC' },
  end: { dateTime: '2026-09-08T16:00:00Z', timeZone: 'Etc/UTC' },
  attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
};
const ALL_DAY_EVENT = {
  id: 'evt_allday',
  summary: 'Company holiday',
  start: { date: '2026-12-25' },
  end: { date: '2026-12-26' },
};
const BARE_EVENT = { id: 'evt_bare' };

describe('list_events', () => {
  const out = () => translate('GOOGLECALENDAR_EVENTS_LIST', {
    kind: 'calendar#events',
    items: [TIMED_EVENT, ALL_DAY_EVENT, BARE_EVENT],
    nextPageToken: 'page2',
  });

  it('satisfies the canonical shape', () => {
    expect(() => CANONICAL_RESPONSE_SHAPES['googlecalendar.list_events'].parse(out())).not.toThrow();
  });

  it('flattens both of Google’s time shapes to a string', () => {
    const items = (out() as { items: Array<{ start: string; end: string }> }).items;
    expect(items[0].start).toBe('2026-09-08T15:00:00Z');
    expect(items[1].start).toBe('2026-12-25');
  });

  it('keeps an untitled, guestless event rather than dropping it', () => {
    // An event with no summary and no attendees is ordinary. Requiring either
    // would fail the whole listing on one such row.
    const items = (out() as { items: Array<{ id: string; summary: string; attendees: unknown[] }> }).items;
    expect(items[2]).toEqual({ id: 'evt_bare', summary: '', start: '', end: '', attendees: [] });
  });

  it('carries the page token through', () => {
    expect((out() as { nextPageToken?: string }).nextPageToken).toBe('page2');
  });
});

describe('list_calendars', () => {
  // Composio returns `calendars`, NOT `items`. This is the difference that
  // made the registered shape unsatisfiable.
  const vendor = {
    calendars: [
      { id: 'primary@example.com', summary: 'Alex', primary: true },
      { id: 'team@example.com', summary: 'Team' },
    ],
  };

  it('satisfies the canonical shape', () => {
    const out = translate('GOOGLECALENDAR_LIST_CALENDARS', vendor);
    expect(() => CANONICAL_RESPONSE_SHAPES['googlecalendar.list_calendars'].parse(out)).not.toThrow();
  });

  it('reads primary as false when Google omits it', () => {
    // Google sets `primary` only on the primary calendar. Absent is a real
    // answer, and the canonical shape requires a boolean.
    const items = (translate('GOOGLECALENDAR_LIST_CALENDARS', vendor) as {
      items: Array<{ id: string; name: string; primary: boolean }>;
    }).items;
    expect(items[0].primary).toBe(true);
    expect(items[1].primary).toBe(false);
    expect(items[1].name).toBe('Team');
  });

  it('would not have satisfied the shape without the projection', () => {
    // Guards the actual defect: the raw vendor payload must FAIL, or this
    // whole file is asserting something that was never broken.
    expect(() => CANONICAL_RESPONSE_SHAPES['googlecalendar.list_calendars'].parse(vendor)).toThrow();
  });
});

describe('the write tools unwrap Composio’s envelope', () => {
  it.each([
    ['GOOGLECALENDAR_CREATE_EVENT', 'googlecalendar.create_event', { response_data: TIMED_EVENT }],
    ['GOOGLECALENDAR_UPDATE_EVENT', 'googlecalendar.update_event', { response_data: TIMED_EVENT }],
    ['GOOGLECALENDAR_QUICK_ADD', 'googlecalendar.quick_add_event', { event: TIMED_EVENT }],
  ] as const)('%s', (slug, key, vendor) => {
    const out = translate(slug, vendor);
    expect(out).toEqual({ id: 'evt_timed', htmlLink: TIMED_EVENT.htmlLink });
    expect(() => CANONICAL_RESPONSE_SHAPES[key].parse(out)).not.toThrow();
    // The envelope is the whole point: unwrapped, the raw payload does not fit.
    expect(() => CANONICAL_RESPONSE_SHAPES[key].parse(vendor)).toThrow();
  });
});

describe('find_event', () => {
  it('reaches through Composio’s doubly nested event_data', () => {
    const out = translate('GOOGLECALENDAR_FIND_EVENT', {
      event_data: { event_data: [TIMED_EVENT], nextPageToken: 'p2' },
    });
    expect((out as { items: Array<{ id: string }> }).items.map((e) => e.id)).toEqual(['evt_timed']);
    expect(() => CANONICAL_RESPONSE_SHAPES['googlecalendar.find_event'].parse(out)).not.toThrow();
  });

  it('returns an empty list rather than throwing when nothing matched', () => {
    const out = translate('GOOGLECALENDAR_FIND_EVENT', { event_data: {} });
    expect((out as { items: unknown[] }).items).toEqual([]);
  });
});

describe('get_calendar', () => {
  it('satisfies the canonical shape', () => {
    const out = translate('GOOGLECALENDAR_GET_CALENDAR', {
      calendar_data: { id: 'team@example.com', summary: 'Team', timeZone: 'Etc/UTC' },
    });
    expect(out).toEqual({ id: 'team@example.com', name: 'Team', timeZone: 'Etc/UTC' });
    expect(() => CANONICAL_RESPONSE_SHAPES['googlecalendar.get_calendar'].parse(out)).not.toThrow();
  });
});

describe('every declared returnsIds path resolves in the canonical shape', () => {
  // The declaration and the projection are written together and can drift
  // apart silently: a path naming the vendor shape compiles, matches nothing,
  // and reads as a tool that declares no provenance.
  const sample: Record<string, unknown> = {
    GOOGLECALENDAR_EVENTS_LIST: { items: [TIMED_EVENT] },
    GOOGLECALENDAR_FIND_EVENT: { event_data: { event_data: [TIMED_EVENT] } },
    GOOGLECALENDAR_LIST_CALENDARS: { calendars: [{ id: 'c1', summary: 'C', primary: true }] },
    GOOGLECALENDAR_GET_CALENDAR: { calendar_data: { id: 'c1', summary: 'C' } },
    GOOGLECALENDAR_CREATE_EVENT: { response_data: TIMED_EVENT },
    GOOGLECALENDAR_UPDATE_EVENT: { response_data: TIMED_EVENT },
    GOOGLECALENDAR_QUICK_ADD: { event: TIMED_EVENT },
  };

  const readPath = (value: unknown, path: string): unknown[] => {
    let cursor: unknown[] = [value];
    for (const segment of path.split('.')) {
      const key = segment.replace('[]', '');
      const next = cursor
        .map((v) => (v as Record<string, unknown> | null)?.[key])
        .filter((v) => v !== undefined && v !== null);
      cursor = segment.endsWith('[]') ? next.flatMap((v) => (Array.isArray(v) ? v : [])) : next;
    }
    return cursor;
  };

  it.each(Object.keys(sample))('%s', (slug) => {
    const overlay = GOOGLECALENDAR_OVERLAYS[slug];
    const canonical = translate(slug, sample[slug]);
    for (const decl of overlay.returnsIds ?? []) {
      const found = readPath(canonical, decl.path);
      expect(found.length).toBeGreaterThan(0);
      for (const id of found) expect(typeof id).toBe('string');
    }
  });
});
