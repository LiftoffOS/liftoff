// files/: layout, de-duplication, links, missing objects, and the size
// precheck that answers 413 before any bucket read.

jest.mock('../../generated-files/gcs-client', () => ({
  generatedFilesBucket: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { generatedFilesBucket } from '../../generated-files/gcs-client';
import { ExportBudget, ExportTooLargeError } from '../budget';
import { chargeFileSizes, planFiles, downloadFiles, fileResolver, slugify } from '../files';
import type { GeneratedFileRow } from '../queries';

const CONV = '11111111-1111-4111-8111-111111111111';
const folders = new Map([[CONV, { createdAt: new Date('2026-09-12T14:02:00Z'), title: 'Review of PR 482' }]]);

const file = (o: Partial<GeneratedFileRow>): GeneratedFileRow => ({
  id: 'f1', sort_cursor: 'x', conversation_id: CONV, agent_id: 'team-1', agent_name: 'Code Reviewer',
  filename: 'Report_v1.xlsx', output_type: 'xlsx', gcs_path: 'tenants/t/agents/a/1/Report_v1.xlsx',
  web_view_url: null, size_bytes: '1024', created_at: new Date('2026-09-12T14:03:00Z'), ...o,
});

describe('slugify', () => {
  it('lower-cases, collapses to hyphens, trims, caps at 40, and falls back', () => {
    expect(slugify('Northwind Traders, Inc.', 'workspace')).toBe('northwind-traders-inc');
    expect(slugify('Ünïcode ❤ name', 'workspace')).toBe('n-code-name');
    expect(slugify('../../etc/passwd', 'workspace')).toBe('etc-passwd');
    expect(slugify('x'.repeat(60), 'workspace')).toHaveLength(40);
    expect(slugify('日本語', 'workspace')).toBe('workspace');
    expect(slugify(null, 'team')).toBe('team');
  });
});

describe('planFiles', () => {
  it('lays each file under its conversation\'s dated folder, and a conversation-less one under its team', () => {
    const plan = planFiles([
      file({}),
      file({ id: 'f2', conversation_id: null, filename: 'weekly.docx', gcs_path: 'p2' }),
      file({ id: 'f3', conversation_id: 'not-exported', filename: 'x.pdf', gcs_path: 'p3' }),
    ], folders);
    expect(plan.files.map((f) => f.path)).toEqual([
      'files/2026-09-12-review-of-pr-482/Report_v1.xlsx',
      'files/code-reviewer/weekly.docx',
      'files/code-reviewer/x.pdf',
    ]);
  });

  it('numbers two identical names in one conversation', () => {
    const plan = planFiles([file({}), file({ id: 'f2', gcs_path: 'p2' }), file({ id: 'f3', gcs_path: 'p3' })], folders);
    expect(plan.files.map((f) => f.path)).toEqual([
      'files/2026-09-12-review-of-pr-482/Report_v1.xlsx',
      'files/2026-09-12-review-of-pr-482/Report_v1 (2).xlsx',
      'files/2026-09-12-review-of-pr-482/Report_v1 (3).xlsx',
    ]);
  });

  it('gives a connector-native row a Link and no Path', () => {
    const plan = planFiles([file({ id: 'g1', output_type: 'gdoc', gcs_path: null, web_view_url: 'https://docs.google.com/document/d/abc', filename: 'Q3 plan' })], folders);
    expect(plan.files[0]).toMatchObject({ path: null, link: 'https://docs.google.com/document/d/abc' });
    expect(fileResolver(plan)({ fileId: 'g1', filename: 'Q3 plan', webViewUrl: null })).toEqual({ Name: 'Q3 plan', Link: 'https://docs.google.com/document/d/abc' });
  });

  it('includes a media output the same as a document', () => {
    const plan = planFiles([file({ id: 'm1', output_type: 'media', filename: 'chart.png', gcs_path: 'pm' })], folders);
    expect(plan.files[0].path).toBe('files/2026-09-12-review-of-pr-482/chart.png');
  });
});

describe('chargeFileSizes', () => {
  it('returns 413 before any bucket read when the sizes exceed the remaining budget', async () => {
    const budget = new ExportBudget(1000, 2000);
    const rows = [file({ size_bytes: '1500' }), file({ id: 'f2', gcs_path: 'p2', size_bytes: 600 })];
    expect(() => chargeFileSizes(rows, budget)).toThrow(ExportTooLargeError);
    expect(generatedFilesBucket).not.toHaveBeenCalled();
  });

  it('charges only rows with a stored object', () => {
    const budget = new ExportBudget(1000, 2000);
    expect(chargeFileSizes([file({ size_bytes: 500 }), file({ id: 'g', gcs_path: null, size_bytes: 9999 })], budget)).toBe(500);
    expect(budget.bytesLeft).toBe(1500);
  });
});

describe('downloadFiles', () => {
  it('fetches every planned object, at most ten at a time, and binds bytes to paths', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => file({ id: `f${i}`, filename: `r${i}.xlsx`, gcs_path: `p${i}` }));
    const plan = planFiles(rows, folders);
    let inFlight = 0;
    let peak = 0;
    const download = jest.fn(async (gcsPath: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return Buffer.from(`bytes:${gcsPath}`);
    });
    const bytes = await downloadFiles(plan, download);
    expect(download).toHaveBeenCalledTimes(25);
    expect(peak).toBeLessThanOrEqual(10);
    expect(bytes.get('files/2026-09-12-review-of-pr-482/r7.xlsx')?.toString()).toBe('bytes:p7');
  });

  it('turns a missing object into a name with no path, and lets any other failure propagate', async () => {
    const plan = planFiles([file({}), file({ id: 'f2', filename: 'gone.docx', gcs_path: 'gone' })], folders);
    const missing = Object.assign(new Error('No such object'), { code: 404 });
    const bytes = await downloadFiles(plan, async (p) => { if (p === 'gone') throw missing; return Buffer.from('ok'); });
    expect(bytes.size).toBe(1);
    expect(fileResolver(plan)({ fileId: 'f2', filename: 'gone.docx', webViewUrl: null })).toEqual({ Name: 'gone.docx' });
    // A missing object whose card carries a link still points somewhere.
    expect(fileResolver(plan)({ fileId: 'f2', filename: 'gone.docx', webViewUrl: 'https://docs.example/gone' })).toEqual({ Name: 'gone.docx', Link: 'https://docs.example/gone' });
    expect(fileResolver(plan)({ fileId: 'f1', filename: 'Report_v1.xlsx', webViewUrl: null })).toEqual({ Name: 'Report_v1.xlsx', Path: 'files/2026-09-12-review-of-pr-482/Report_v1.xlsx' });
    await expect(downloadFiles(planFiles([file({})], folders), async () => { throw new Error('bucket down'); })).rejects.toThrow('bucket down');
  });

  it("carries whatever link the card holds, whichever cloud it points at", () => {
    // run-artifacts.ts reads the link off the connector's own result with a
    // provider-neutral match; the export must not narrow that to one vendor.
    const resolve = fileResolver(planFiles([], folders));
    for (const url of [
      'https://www.dropbox.com/scl/fi/abc123/Q3-plan.docx?dl=0',
      'https://my.sharepoint.com/:w:/g/personal/h_liftoffos_com/EaBcD',
      'https://onedrive.live.com/edit.aspx?resid=ABC!123',
      'https://app.box.com/file/1234567890',
      'https://www.notion.so/Q3-plan-0123456789abcdef',
      'https://liftoff.atlassian.net/wiki/spaces/OPS/pages/42/Q3+plan',
    ]) {
      expect(resolve({ fileId: 'no-row', filename: 'Q3 plan', webViewUrl: url })).toEqual({ Name: 'Q3 plan', Link: url });
    }
  });

  it('names a reference to a row the export does not hold, and links it when the card carries a link', () => {
    expect(fileResolver(planFiles([], folders))({ fileId: 'nope', filename: 'later.xlsx', webViewUrl: null })).toEqual({ Name: 'later.xlsx' });
    // A document written through a connector has no generated_files row at
    // all: the card is the record, and its link is what the page shows.
    expect(fileResolver(planFiles([], folders))({ fileId: 'nope', filename: 'Updated document', webViewUrl: 'https://docs.google.com/document/d/x/edit' }))
      .toEqual({ Name: 'Updated document', Link: 'https://docs.google.com/document/d/x/edit' });
  });
});
