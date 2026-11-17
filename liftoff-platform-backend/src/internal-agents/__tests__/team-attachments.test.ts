// Team-scoped build-time attachments (docs/REQUIRED_BACKEND_APIS.md
// "Team Attachments").
//
// Covers: the shared wire schema (attachment-schema.ts), the row-mapper
// read path, fingerprint sensitivity in the distill cache, and the
// mimeType inference used when resolving connector attachments through
// the knowledge extraction machinery.

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// knowledge/service transitive deps — same mock set extraction.test.ts uses
// to keep this a pure unit test.
jest.mock('../../knowledge/repository', () => ({}));
jest.mock('../../knowledge/outbox', () => ({
  publishOutboxRefs: jest.fn(async () => {}),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));
jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'http://localhost',
}));

import {
  teamAttachmentSchema,
  teamAttachmentsArraySchema,
  MAX_ATTACHMENT_CONTENT_CHARS,
  MAX_ATTACHMENTS,
} from '../attachment-schema';
import { mapInternalAgentRow } from '../row-mapper';
import { computeFingerprint } from '../distill-cache';
import type { DistillInput } from '../distill-service';
import type { TeamAttachment } from '../types';
import { inferMimeTypeFromFileName } from '../../knowledge/service';

const UPLOAD: TeamAttachment = {
  kind: 'upload',
  name: 'runbook.md',
  content: '# Escalation runbook\nAlways page the on-call first.',
  addedAt: '2026-08-04T10:00:00.000Z',
  source: 'responsibilities',
};

const CONNECTOR: TeamAttachment = {
  kind: 'connector',
  name: 'Q3 planning.pdf',
  connectorId: '4f8a4f66-2f5b-4a7e-9a83-0d1f6f0a9a11',
  connectorType: 'google_drive',
  externalId: 'drive-file-123',
  sourceUrl: 'https://drive.google.com/file/d/drive-file-123',
  addedAt: '2026-08-04T10:05:00.000Z',
  source: 'guidance',
};

describe('teamAttachmentSchema', () => {
  it('accepts an upload attachment', () => {
    expect(teamAttachmentSchema.safeParse(UPLOAD).success).toBe(true);
  });

  it('accepts a connector attachment', () => {
    expect(teamAttachmentSchema.safeParse(CONNECTOR).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(teamAttachmentSchema.safeParse({ ...UPLOAD, kind: 'url' }).success).toBe(false);
  });

  it('rejects an upload whose content exceeds the cap', () => {
    const over = { ...UPLOAD, content: 'x'.repeat(MAX_ATTACHMENT_CONTENT_CHARS + 1) };
    expect(teamAttachmentSchema.safeParse(over).success).toBe(false);
  });

  it('rejects a connector attachment with a non-uuid connectorId', () => {
    expect(teamAttachmentSchema.safeParse({ ...CONNECTOR, connectorId: 'google_drive' }).success).toBe(false);
  });

  it('rejects a list longer than the cap', () => {
    const list = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => UPLOAD);
    expect(teamAttachmentsArraySchema.safeParse(list).success).toBe(false);
  });
});

describe('row mapper', () => {
  const baseRow = {
    id: 'agent-1',
    tenant_id: 'tenant-1',
    role: 'Customer Success Manager',
    status: 'active',
    temperature: '0.3',
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
  };

  it('maps the attachments column', () => {
    const agent = mapInternalAgentRow({ ...baseRow, attachments: [UPLOAD, CONNECTOR] });
    expect(agent.attachments).toEqual([UPLOAD, CONNECTOR]);
  });

  it('defaults to an empty array on pre-migration rows', () => {
    const agent = mapInternalAgentRow(baseRow);
    expect(agent.attachments).toEqual([]);
  });
});

describe('distill cache fingerprint', () => {
  const BASE_INPUT: DistillInput = {
    tenantId: 'tenant-1',
    role: 'Sales Analyst',
    responsibilities: 'Analyze the pipeline weekly.',
    integrations: [],
  };

  it('changes when an attachment is added', () => {
    const without = computeFingerprint(BASE_INPUT, 'cat-hash', '');
    const withAtt = computeFingerprint({ ...BASE_INPUT, attachments: [UPLOAD] }, 'cat-hash', '');
    expect(withAtt).not.toEqual(without);
  });

  it('changes when upload content changes', () => {
    const a = computeFingerprint({ ...BASE_INPUT, attachments: [UPLOAD] }, 'cat-hash', '');
    const b = computeFingerprint(
      { ...BASE_INPUT, attachments: [{ ...UPLOAD, content: 'different text' }] },
      'cat-hash',
      '',
    );
    expect(a).not.toEqual(b);
  });

  it('is stable across addedAt changes (re-import of the same file)', () => {
    const a = computeFingerprint({ ...BASE_INPUT, attachments: [UPLOAD] }, 'cat-hash', '');
    const b = computeFingerprint(
      { ...BASE_INPUT, attachments: [{ ...UPLOAD, addedAt: '2026-08-05T09:00:00.000Z' }] },
      'cat-hash',
      '',
    );
    expect(a).toEqual(b);
  });

  it('treats no attachments and an empty list identically', () => {
    const a = computeFingerprint(BASE_INPUT, 'cat-hash', '');
    const b = computeFingerprint({ ...BASE_INPUT, attachments: [] }, 'cat-hash', '');
    expect(a).toEqual(b);
  });
});

describe('inferMimeTypeFromFileName', () => {
  it.each([
    ['notes.txt', 'text/plain'],
    ['data.csv', 'text/plain'],
    ['README.md', 'text/markdown'],
    ['deck.pdf', 'application/pdf'],
    ['spec.DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('%s → %s', (name, expected) => {
    expect(inferMimeTypeFromFileName(name)).toBe(expected);
  });

  it('returns undefined for unknown or missing extensions', () => {
    expect(inferMimeTypeFromFileName('binary.xlsx')).toBeUndefined();
    expect(inferMimeTypeFromFileName('Google Doc without extension')).toBeUndefined();
    expect(inferMimeTypeFromFileName(undefined)).toBeUndefined();
  });
});
