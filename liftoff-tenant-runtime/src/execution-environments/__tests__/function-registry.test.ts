import {
  getSandboxFunctions,
  getSandboxFunction,
  getSandboxFunctionNames,
  isSandboxTool,
} from '../function-registry';

describe('sandbox-function-registry', () => {
  describe('getSandboxFunctions', () => {
    it('returns the original 8 baseline sandbox tools plus the sandbox-parity surface', () => {
      const functions = getSandboxFunctions();
      // 8 baseline (shell_exec, file_*, content_search, git_*) + sandbox-parity
      // extensions (shell PTY sessions, browser/file/bash/nodejs/code, MCP-from-
      // sandbox, util, sandbox-meta, proxy, etc.) — see
      // sandbox-function-registry.parity.test.ts for the exhaustive parity-surface check.
      expect(functions.length).toBeGreaterThanOrEqual(80);
    });

    it('includes the 8 original baseline tool names', () => {
      const names = getSandboxFunctions().map(f => f.name);
      const baseline = [
        'shell_exec',
        'file_read',
        'file_write',
        'file_edit',
        'file_search',
        'content_search',
        'git_clone',
        'git_commit_and_push',
      ];
      for (const name of baseline) expect(names).toContain(name);
    });

    it('every function has a valid inputSchema', () => {
      for (const fn of getSandboxFunctions()) {
        expect(fn.inputSchema.type).toBe('object');
        expect(fn.inputSchema.properties).toBeDefined();
        expect(typeof fn.inputSchema.properties).toBe('object');
        // required must be a non-empty array if present
        if (fn.inputSchema.required) {
          expect(Array.isArray(fn.inputSchema.required)).toBe(true);
          expect(fn.inputSchema.required.length).toBeGreaterThan(0);
          // Every required field must exist in properties
          for (const req of fn.inputSchema.required) {
            expect(fn.inputSchema.properties).toHaveProperty(req);
          }
        }
      }
    });

    it('every function has at least one category, except sandboxInternal dispatchers', () => {
      // `mcp_dispatch` is intentionally uncategorized (`categories: []`) so the
      // sandbox-side dispatch pipeline's per-tool gate fires on the INNER tool's
      // categories, not on `mcp_dispatch` itself (see sandbox-function-registry.ts
      // around line 309). Any other uncategorized function would be a bug.
      for (const fn of getSandboxFunctions()) {
        if (fn.categories.length === 0) {
          expect(fn.sandboxInternal).toBe(true);
          expect(fn.name).toBe('mcp_dispatch');
        } else {
          expect(fn.categories.length).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it('shell_exec is categorized as destructive', () => {
      const fn = getSandboxFunction('shell_exec');
      expect(fn?.categories).toContain('destructive');
    });

    it('git_commit_and_push is categorized as outbound', () => {
      const fn = getSandboxFunction('git_commit_and_push');
      expect(fn?.categories).toContain('outbound');
    });

    it('read-only tools have only read category', () => {
      for (const name of ['file_read', 'file_search', 'content_search', 'git_clone']) {
        const fn = getSandboxFunction(name);
        expect(fn?.categories).toEqual(['read']);
      }
    });

    it('write tools have write category', () => {
      for (const name of ['file_write', 'file_edit']) {
        const fn = getSandboxFunction(name);
        expect(fn?.categories).toEqual(['write']);
      }
    });

    // Resolved: TE-004 — schema validation for array fields with items
    it('array fields in schemas have items defined', () => {
      for (const fn of getSandboxFunctions()) {
        for (const [_propName, prop] of Object.entries(fn.inputSchema.properties)) {
          if (prop.type === 'array') {
            expect(prop.items).toBeDefined();
            expect(typeof prop.items).toBe('object');
          }
        }
      }
    });
  });

  describe('getSandboxFunction', () => {
    it('returns function by name', () => {
      const fn = getSandboxFunction('shell_exec');
      expect(fn).toBeDefined();
      expect(fn?.name).toBe('shell_exec');
    });

    it('returns undefined for unknown names', () => {
      expect(getSandboxFunction('nonexistent')).toBeUndefined();
    });
  });

  describe('getSandboxFunctionNames', () => {
    it('returns array of all tool names including the baseline + parity surface', () => {
      const names = getSandboxFunctionNames();
      expect(names).toContain('shell_exec');
      expect(names).toContain('file_read');
      expect(names).toContain('git_commit_and_push');
      expect(names.length).toBeGreaterThanOrEqual(80);
    });
  });

  describe('isSandboxTool', () => {
    it('returns true for sandbox tools', () => {
      expect(isSandboxTool('shell_exec')).toBe(true);
      expect(isSandboxTool('file_read')).toBe(true);
      expect(isSandboxTool('git_commit_and_push')).toBe(true);
    });

    it('returns false for non-sandbox tools', () => {
      expect(isSandboxTool('send_email')).toBe(false);
      expect(isSandboxTool('read_record')).toBe(false);
      expect(isSandboxTool('')).toBe(false);
    });
  });
});
