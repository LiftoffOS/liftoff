import { getSandboxFunctions, isSandboxTool, filterSandboxFunctionsByCapabilities } from '../function-registry';

describe('sandbox parity function registry', () => {
  it('includes all 91+ parity tool names', () => {
    const names = new Set(getSandboxFunctions().map(f => f.name));
    const expected = [
      // shell PTY (Phase 2/14.E)
      'shell_exec',
      'shell_session_create', 'shell_session_write', 'shell_session_view',
      'shell_session_wait', 'shell_session_kill', 'shell_session_resize',
      'shell_session_cleanup', 'shell_session_cleanup_all', 'shell_session_stats',
      'shell_session_list',
      // file (Phase 2)
      'file_read', 'file_write',
      'file_str_replace_editor', 'file_grep', 'file_glob', 'file_find',
      'file_watch_create', 'file_watch_poll', 'file_watch_stop',
      // bash (14.A)
      'bash_session_create', 'bash_session_exec', 'bash_session_kill', 'bash_session_list',
      // nodejs (14.B)
      'nodejs_session_create', 'nodejs_execute', 'nodejs_session_delete',
      // code (14.C)
      'code_execute', 'code_get_info',
      // util (14.D)
      'util_convert_to_markdown',
      // browser core
      'browser_navigate', 'browser_click', 'browser_fill', 'browser_press_key',
      'browser_screenshot', 'browser_evaluate', 'browser_extract_text',
      'browser_extract_markdown', 'browser_list_tabs', 'browser_new_tab', 'browser_close_tab',
      // browser additional (14.F)
      'browser_back', 'browser_forward', 'browser_reload', 'browser_hot_key',
      'browser_upload_file', 'browser_get_elements', 'browser_get_console',
      'browser_export_console', 'browser_find_text', 'browser_scroll_to', 'browser_scroll_to_element',
      // browser state (14.G)
      'browser_state_save', 'browser_state_load', 'browser_state_list', 'browser_state_delete',
      // browser network (14.H)
      'browser_route_add', 'browser_route_remove', 'browser_route_list',
      'browser_headers_set', 'browser_headers_scoped', 'browser_headers_clear',
      'browser_requests_list',
      // browser captcha (14.K)
      'browser_captcha_detect', 'browser_captcha_wait',
      // sandbox meta (14.J)
      'sandbox_context', 'sandbox_list_python_packages',
      'sandbox_list_nodejs_packages', 'sandbox_restart',
      // proxy (14.L)
      'proxy_mapping_add', 'proxy_mapping_remove', 'proxy_mapping_list',
      'proxy_exclude_add', 'proxy_exclude_remove', 'proxy_exclude_list',
      'proxy_upstream_set', 'proxy_upstream_remove', 'proxy_upstream_get',
      'proxy_health', 'proxy_diagnose',
      // mcp (14.Q)
      'mcp_list_tools', 'mcp_dispatch', 'mcp_await_approval',
      // vscode
      'vscode_get_url',
    ];
    for (const e of expected) {
      expect(names.has(e)).toBe(true);
    }
  });

  it('isSandboxTool returns true for parity tools and false for nonsense', () => {
    expect(isSandboxTool('browser_navigate')).toBe(true);
    expect(isSandboxTool('mcp_dispatch')).toBe(true);
    expect(isSandboxTool('garbage__tool')).toBe(false);
  });

  it('filterSandboxFunctionsByCapabilities respects shell-only', () => {
    const out = filterSandboxFunctionsByCapabilities(['shell']);
    const names = out.map(f => f.name);
    expect(names.some(n => n.startsWith('shell_'))).toBe(true);
    expect(names.some(n => n.startsWith('bash_'))).toBe(true);
    expect(names.some(n => n.startsWith('browser_'))).toBe(false);
    expect(names.some(n => n.startsWith('vscode_'))).toBe(false);
  });

  it('filterSandboxFunctionsByCapabilities respects browser-only', () => {
    const out = filterSandboxFunctionsByCapabilities(['browser']);
    const names = out.map(f => f.name);
    expect(names.some(n => n.startsWith('browser_'))).toBe(true);
    expect(names.some(n => n.startsWith('proxy_'))).toBe(true);
    expect(names.some(n => n.startsWith('shell_'))).toBe(false);
    expect(names.some(n => n.startsWith('file_'))).toBe(false);
  });

  it('mcp_* and sandbox_* are sandboxInternal — never returned to the LLM-facing filter', () => {
    // These used to be unconditionally included. Now they're tagged
    // sandboxInternal: true and filtered out — see sandbox-function-registry.ts
    // around the filterSandboxFunctionsByCapabilities comment.
    for (const caps of [[], ['shell'] as const, ['file'] as const, ['browser'] as const, ['shell', 'file', 'browser', 'vscode'] as const]) {
      const names = filterSandboxFunctionsByCapabilities(caps as never).map(f => f.name);
      expect(names.some(n => n.startsWith('mcp_'))).toBe(false);
      expect(names.some(n => n.startsWith('sandbox_'))).toBe(false);
    }
  });

  it('util_* and code_* are gated on having ANY sandbox capability', () => {
    // No capabilities → util/code excluded (no sandbox to run them in).
    const empty = filterSandboxFunctionsByCapabilities([]).map(f => f.name);
    expect(empty.some(n => n.startsWith('util_'))).toBe(false);
    expect(empty.some(n => n.startsWith('code_'))).toBe(false);

    // Any single capability → util/code included.
    const withShell = filterSandboxFunctionsByCapabilities(['shell']).map(f => f.name);
    expect(withShell.some(n => n.startsWith('util_'))).toBe(true);
    expect(withShell.some(n => n.startsWith('code_'))).toBe(true);
  });
});
