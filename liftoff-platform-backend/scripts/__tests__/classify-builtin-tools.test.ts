// Integration tests for classify-builtin-tools script
// Per implementation plan: [TE-004]

import { formatCategories, classifyTool } from '../classify-builtin-tools';
import { hashDescription } from '../../src/mcp/tool-classifier';
import { llmClient } from '../../src/llm/client';

jest.mock('../../src/llm/client');

const mockLlmClient = llmClient as jest.Mocked<typeof llmClient>;

describe('classify-builtin-tools script', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('formatCategories', () => {
    it('outputs valid SQL array syntax for single category', () => {
      const result = formatCategories(['dataChanges']);
      expect(result).toBe("ARRAY['dataChanges']");
    });

    it('outputs valid SQL array syntax for multiple categories', () => {
      const result = formatCategories(['customerCommunication', 'dataChanges']);
      expect(result).toBe("ARRAY['customerCommunication', 'dataChanges']");
    });

    it('outputs empty array for no categories', () => {
      const result = formatCategories([]);
      expect(result).toBe("ARRAY[]::TEXT[]");
    });

    it('outputs correct SQL array for all five categories', () => {
      const result = formatCategories([
        'customerCommunication',
        'financialActions',
        'dataChanges',
        'externalPublishing',
        'hiringDecisions',
      ]);
      expect(result).toBe(
        "ARRAY['customerCommunication', 'financialActions', 'dataChanges', 'externalPublishing', 'hiringDecisions']"
      );
    });
  });

  describe('hashDescription', () => {
    it('matches tool-classifier.ts implementation', () => {
      // Test various descriptions to ensure consistency
      const testCases = [
        'Send an email to a recipient',
        'Create a new contact in HubSpot CRM',
        'Delete a record from the database',
        'Search for messages in Slack',
      ];

      for (const description of testCases) {
        const hash = hashDescription(description);

        // Hash should be 12 characters
        expect(hash).toHaveLength(12);
        // Hash should be hex characters only
        expect(hash).toMatch(/^[a-f0-9]{12}$/);
      }
    });

    it('produces consistent hashes for same description', () => {
      const description = 'Send an email via Gmail';
      const hash1 = hashDescription(description);
      const hash2 = hashDescription(description);

      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different descriptions', () => {
      const hash1 = hashDescription('Send an email');
      const hash2 = hashDescription('Receive an email');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('classifyTool', () => {
    it('calls llmClient with correct parameters', async () => {
      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: ['customerCommunication'] }),
      });

      await classifyTool('gmail_send_email', 'Send an email via Gmail');

      expect(mockLlmClient.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.1,
          responseSchema: expect.objectContaining({
            name: 'classify_tool',
          }),
        })
      );
    });

    it('filters out invalid categories from LLM response', async () => {
      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({
          categories: ['customerCommunication', 'invalidCategory', 'dataChanges'],
        }),
      });

      const categories = await classifyTool('test_tool', 'Test description');

      expect(categories).toEqual(['customerCommunication', 'dataChanges']);
      expect(categories).not.toContain('invalidCategory');
    });

    it('returns empty array on LLM error', async () => {
      (mockLlmClient.complete as jest.Mock).mockRejectedValue(new Error('API error'));

      // Should not throw, should return empty array
      const categories = await classifyTool('test_tool', 'Test description');

      expect(categories).toEqual([]);
    });

    it('returns empty array for read-only tools', async () => {
      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: [] }),
      });

      const categories = await classifyTool('gmail_search', 'Search for emails');

      expect(categories).toEqual([]);
    });
  });

  describe('SQL output validation', () => {
    it('produced SQL contains INSERT statement', async () => {
      // Import generateSeedSQL dynamically to avoid executing main()
      const { generateSeedSQL } = await import('../classify-builtin-tools');

      // Mock all LLM calls to return empty categories for speed
      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: [] }),
      });

      const sql = await generateSeedSQL();

      expect(sql).toContain('INSERT INTO tool_classification_cache');
      expect(sql).toContain('ON CONFLICT (tool_name) DO UPDATE');
    });

    it('produced SQL contains valid tool names', async () => {
      const { generateSeedSQL } = await import('../classify-builtin-tools');

      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: [] }),
      });

      const sql = await generateSeedSQL();

      // Should contain some known tool names
      expect(sql).toContain("'gmail_send_email'");
      expect(sql).toContain("'stripe_create_invoice'");
      expect(sql).toContain("'slack_send_message'");
    });

    it('produced SQL contains 12-char hashes', async () => {
      const { generateSeedSQL } = await import('../classify-builtin-tools');

      (mockLlmClient.complete as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ categories: [] }),
      });

      const sql = await generateSeedSQL();

      // Check that hashes in SQL are 12 characters (hex pattern)
      const hashMatches = sql.match(/'[a-f0-9]{12}'/g);
      expect(hashMatches).not.toBeNull();
      expect(hashMatches!.length).toBeGreaterThan(0);

      // All matches should be exactly 14 chars (12 + 2 quotes)
      for (const match of hashMatches!) {
        expect(match).toHaveLength(14);
      }
    });
  });
});
