// Tests for the IntegrationPermission Zod schema — focused on per-binding
// `config` validation. The schema enforces:
//   - shape stays open (Record<string, unknown>) for non-Gmail types
//   - if config keys are gmail-shaped, validate them strictly
//   - sendAs must be a valid email address

import { integrationPermissionSchema } from '../permission-schemas';

describe('integrationPermissionSchema — config field', () => {
  const id = '00000000-0000-0000-0000-0000000000aa';

  it('accepts a permission with no config', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a permission with gmail config (gmailQuery + sendAs)', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: {
        gmailQuery: 'label:support-agent',
        sendAs: 'support@example.com',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a permission with only gmailQuery', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: { gmailQuery: 'to:support@example.com' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects sendAs that is not an email', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: { sendAs: 'not-an-email' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map(i => i.path.join('.'));
      expect(issuePaths).toContain('config.sendAs');
    }
  });

  it('rejects an unknown gmail field via the strict() schema', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: { gmailQuery: 'label:x', extraField: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('passes non-gmail-shaped config through (treated as opaque)', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: { someOtherKey: 'value' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts outlook config (outlookFilter + sendAs)', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: {
        outlookFilter: "from/emailAddress/address eq 'support@example.com'",
        sendAs: 'support@example.com',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects mixing gmailQuery and outlookFilter in one config', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: {
        gmailQuery: 'label:x',
        outlookFilter: "from/emailAddress/address eq 'a@b.com'",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('config cannot mix gmail and outlook fields');
    }
  });

  it('rejects outlookFilter longer than 1000 chars', () => {
    const result = integrationPermissionSchema.safeParse({
      id,
      selectedObjects: [],
      config: { outlookFilter: 'a'.repeat(1001) },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((i) => i.path.join('.'));
      expect(issuePaths).toContain('config.outlookFilter');
    }
  });
});
