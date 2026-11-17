// Execution Environment Function Registry
// Separate from the connector tool-schema cache — execution environments are NOT connectors.
// These tool definitions are used by the tool catalog to present sandbox tools to the LLM.

import { ExecutionEnvironmentFunction } from './types';

// ─── Sandbox Tool Definitions ───────────────────────────────────────────────

const SANDBOX_FUNCTIONS: ExecutionEnvironmentFunction[] = [
  {
    name: 'shell_exec',
    description: 'Execute a command in the sandbox. Pass the command and arguments as separate strings in the args array — do NOT pass a single shell string.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command and arguments as separate strings, e.g. ["npm", "test"] or ["ls", "-la", "/workspace"]',
        },
        workDir: {
          type: 'string',
          description: 'Working directory relative to /workspace (default: /workspace)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (max 300000, default 60000)',
        },
      },
      required: ['args'],
    },
    categories: ['destructive'],
  },
  {
    name: 'file_read',
    description: 'Read a file from the sandbox workspace, whole or in slices. Returns { content, offset, returned, totalChars, hasMore }. For a file too large to read at once, pass offset/limit and repeat while hasMore is true — do NOT reach for a shell to slice it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to /workspace',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start from (default 0). Use the `offset+returned` of the previous call to continue.',
        },
        limit: {
          type: 'number',
          description: 'Maximum characters to return. Omit for the whole file.',
        },
      },
      required: ['path'],
    },
    categories: ['read'],
  },
  {
    name: 'file_write',
    description: 'Write content to a file in the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to /workspace',
        },
        content: {
          type: 'string',
          description: 'File content to write',
        },
      },
      required: ['path', 'content'],
    },
    categories: ['write'],
  },
  {
    name: 'file_edit',
    description: 'Edit a file in the sandbox workspace using search-and-replace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to /workspace',
        },
        oldText: {
          type: 'string',
          description: 'Text to search for (must be unique in the file)',
        },
        newText: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
    categories: ['write'],
  },
  {
    name: 'file_search',
    description: 'Search for files by name pattern (glob) in the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.test.js"',
        },
        path: {
          type: 'string',
          description: 'Search root relative to /workspace (default: /workspace)',
        },
      },
      required: ['pattern'],
    },
    categories: ['read'],
  },
  {
    name: 'content_search',
    description: 'Search file contents by regex pattern in the sandbox workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Search root relative to /workspace (default: /workspace)',
        },
        glob: {
          type: 'string',
          description: 'Glob filter for files to search, e.g. "*.ts"',
        },
      },
      required: ['pattern'],
    },
    categories: ['read'],
  },
  {
    name: 'git_clone',
    description: 'Clone a repository into the sandbox workspace, or fetch it if it is already there. Returns { path, action, stdout, stderr, exitCode }: `path` is the checkout directory and is the ONLY correct working directory for later git commands on this repo — do not construct one from the repo name. `action` is "cloned" or "fetched". Each repository gets its own directory, so a workspace can hold several, and re-running against an existing checkout fetches instead of failing.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository to clone. Either an HTTPS URL (https://github.com/owner/name.git) or a bare "owner/name", which is resolved against github.com. A GitLab repository given as a bare "owner/name" will not authenticate — pass its full HTTPS URL.',
        },
        branch: {
          type: 'string',
          description: 'Branch to clone (default: default branch)',
        },
        depth: {
          type: 'number',
          description: 'Shallow clone depth (default: full clone)',
        },
      },
      required: ['repo'],
    },
    categories: ['read'],
  },
  {
    name: 'git_commit_and_push',
    description: 'Stage specific files, commit with a message, and push to a branch. Files are staged individually (not git add -A). Branch names must match [a-zA-Z0-9/_.-]+.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to stage for commit (relative to repo root). Must specify files explicitly.',
        },
        message: {
          type: 'string',
          description: 'Commit message (max 500 characters)',
        },
        branch: {
          type: 'string',
          description: 'Branch name to push to. Must match pattern: [a-zA-Z0-9/_.-]+',
        },
      },
      required: ['files', 'message', 'branch'],
    },
    categories: ['outbound'],
  },
];

// ─── Phase 2-5 parity tools — appended after existing entries ─────────────

const PARITY_FUNCTIONS: ExecutionEnvironmentFunction[] = [
  // Shell PTY sessions (Phase 2)
  { name: 'shell_session_create', description: 'Open a persistent PTY session in the sandbox. Returns a sessionId that can be written to, viewed, waited on, and killed.', inputSchema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' }, description: 'Initial command (default: ["bash"])' }, cwd: { type: 'string', description: 'Working directory under /workspace' }, cols: { type: 'number' }, rows: { type: 'number' } } }, categories: ['destructive'] },
  { name: 'shell_session_write', description: 'Write data to an open PTY session\'s stdin.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, data: { type: 'string' } }, required: ['sessionId', 'data'] }, categories: ['destructive'] },
  { name: 'shell_session_view', description: 'View accumulated output from a PTY session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, offset: { type: 'number' } }, required: ['sessionId'] }, categories: ['read'] },
  { name: 'shell_session_wait', description: 'Wait for a PTY session to exit (returns null exitCode on timeout).', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['sessionId', 'timeout_ms'] }, categories: ['read'] },
  { name: 'shell_session_kill', description: 'Send SIGTERM to a PTY session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, categories: ['destructive'] },
  { name: 'shell_session_resize', description: 'Resize the PTY (cols, rows).', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } }, required: ['sessionId'] }, categories: ['write'] },
  { name: 'shell_session_cleanup', description: 'Terminate and remove a session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, categories: ['destructive'] },
  { name: 'shell_session_cleanup_all', description: 'Terminate every PTY session in the sandbox.', inputSchema: { type: 'object', properties: {} }, categories: ['destructive'] },
  { name: 'shell_session_stats', description: 'Stats for a single session (bytesIn/bytesOut/exitCode/ageMs/status).', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] }, categories: ['read'] },
  { name: 'shell_session_list', description: 'List active PTY sessions.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },

  // File richer ops (Phase 2)
  { name: 'file_str_replace_editor', description: 'Anthropic-compatible text editor (view, create, str_replace, insert, undo_edit).', inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'] }, path: { type: 'string' }, file_text: { type: 'string' }, view_range: { type: 'array', items: { type: 'number' } }, old_str: { type: 'string' }, new_str: { type: 'string' }, insert_line: { type: 'number' } }, required: ['command', 'path'] }, categories: ['write'] },
  { name: 'file_grep', description: 'Recursive ripgrep over /workspace; returns line-level matches.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] }, categories: ['read'] },
  { name: 'file_glob', description: 'fast-glob over /workspace; returns absolute paths matching pattern.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, root: { type: 'string' } }, required: ['pattern'] }, categories: ['read'] },
  { name: 'file_find', description: 'fd-based file/directory search.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, type: { type: 'string', enum: ['f', 'd'] } }, required: ['pattern'] }, categories: ['read'] },
  { name: 'file_watch_create', description: 'Start a chokidar watcher for paths under /workspace; returns watcher_id.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, events: { type: 'array', items: { type: 'string', enum: ['add', 'change', 'unlink'] } } }, required: ['paths'] }, categories: ['read'] },
  { name: 'file_watch_poll', description: 'Drain pending watcher events since a cursor timestamp.', inputSchema: { type: 'object', properties: { watcher_id: { type: 'string' }, since: { type: 'number' } }, required: ['watcher_id'] }, categories: ['read'] },
  { name: 'file_watch_stop', description: 'Stop and remove a file watcher.', inputSchema: { type: 'object', properties: { watcher_id: { type: 'string' } }, required: ['watcher_id'] }, categories: ['read'] },

  // Bash sessions (14.A)
  { name: 'bash_session_create', description: 'Create a non-PTY bash session with persistent cwd + env across exec calls. Returns the sessionId that bash_session_exec needs.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, env: { type: 'object' } } }, categories: ['destructive'] },
  { name: 'bash_session_exec', description: 'Execute an args array in a bash session; persists cwd across calls. Call bash_session_create first and pass the sessionId it returns; there is no default session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'A sessionId returned by bash_session_create.' }, args: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'number' } }, required: ['sessionId', 'args'] }, categories: ['destructive'] },
  { name: 'bash_session_kill', description: 'Mark a bash session closed.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'A sessionId returned by bash_session_create.' } }, required: ['sessionId'] }, categories: ['destructive'] },
  { name: 'bash_session_list', description: 'List active bash sessions.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },

  // Node.js sessions (14.B)
  { name: 'nodejs_session_create', description: 'Create a Node REPL session (accumulating script file). Returns the sessionId that nodejs_execute needs.', inputSchema: { type: 'object', properties: {} }, categories: ['destructive'] },
  { name: 'nodejs_execute', description: 'Execute Node code in an accumulating session. Call nodejs_session_create first and pass the sessionId it returns; there is no default session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'A sessionId returned by nodejs_session_create.' }, code: { type: 'string' } }, required: ['sessionId', 'code'] }, categories: ['destructive'] },
  { name: 'nodejs_session_delete', description: 'Delete a Node REPL session and its script file.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'A sessionId returned by nodejs_session_create.' } }, required: ['sessionId'] }, categories: ['destructive'] },

  // code router (14.C)
  { name: 'code_execute', description: 'Execute code in javascript|python|bash; auto-creates a session if omitted.', inputSchema: { type: 'object', properties: { language: { type: 'string', enum: ['javascript', 'python', 'bash'] }, code: { type: 'string' }, session_id: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['language', 'code'] }, categories: ['destructive'] },
  { name: 'code_get_info', description: 'Supported languages list.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },

  // util (14.D)
  { name: 'util_convert_to_markdown', description: 'Convert html/pdf/docx/audio/etc. to markdown via markitdown.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, mime: { type: 'string' } } }, categories: ['read'] },

  // Browser core (Phase 3)
  { name: 'browser_navigate', description: 'Navigate a browser tab to a URL.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, url: { type: 'string' }, wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] }, timeout_ms: { type: 'number' } }, required: ['url'] }, categories: ['outbound'] },
  { name: 'browser_click', description: 'Click an element selected by Playwright selector.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['destructive'] },
  { name: 'browser_fill', description: 'Fill an input element.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['tabId', 'selector', 'value'] }, categories: ['destructive'] },
  { name: 'browser_type', description: 'Type characters into an input element (slower than fill).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['tabId', 'selector', 'value'] }, categories: ['destructive'] },
  { name: 'browser_press_key', description: 'Press a keyboard key on the page.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, key: { type: 'string' } }, required: ['tabId', 'key'] }, categories: ['destructive'] },
  { name: 'browser_hover', description: 'Hover over an element.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['destructive'] },
  { name: 'browser_select_option', description: 'Select an <option> by value.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['tabId', 'selector', 'value'] }, categories: ['destructive'] },
  { name: 'browser_check', description: 'Check a checkbox.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['destructive'] },
  { name: 'browser_uncheck', description: 'Uncheck a checkbox.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['destructive'] },
  { name: 'browser_scroll', description: 'Scroll the viewport by (dx, dy) pixels.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' } }, required: ['tabId', 'dx', 'dy'] }, categories: ['destructive'] },
  { name: 'browser_wait_for', description: 'Wait for a selector to appear.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['tabId', 'selector', 'timeout_ms'] }, categories: ['read'] },
  { name: 'browser_evaluate', description: 'Run JavaScript on the page (page.evaluate).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, script: { type: 'string' } }, required: ['tabId', 'script'] }, categories: ['destructive'] },
  { name: 'browser_screenshot', description: 'Take a PNG screenshot (optionally of a selector).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_extract_text', description: 'Extract visible text from a tab (optionally scoped to a selector).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_extract_markdown', description: 'Extract a lightweight markdown representation of the page.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_extract_html', description: 'Return the full HTML of the page.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_list_tabs', description: 'List all open browser tabs.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'browser_new_tab', description: 'Open a new browser tab; returns tabId.', inputSchema: { type: 'object', properties: {} }, categories: ['destructive'] },
  { name: 'browser_close_tab', description: 'Close a browser tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['destructive'] },

  // Browser additional page methods (14.F)
  { name: 'browser_back', description: 'Navigate the tab back in history.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['outbound'] },
  { name: 'browser_forward', description: 'Navigate the tab forward in history.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['outbound'] },
  { name: 'browser_reload', description: 'Reload the page.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] } }, required: ['tabId'] }, categories: ['outbound'] },
  { name: 'browser_hot_key', description: 'Press a keyboard chord (e.g. "Ctrl+Shift+P").', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, keys: { type: 'string' } }, required: ['tabId', 'keys'] }, categories: ['destructive'] },
  { name: 'browser_upload_file', description: 'Upload one or more files to a file input.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' }, filePaths: { type: 'array', items: { type: 'string' } } }, required: ['tabId', 'selector', 'filePaths'] }, categories: ['destructive'] },
  { name: 'browser_get_elements', description: 'List elements matching a selector (tag, text, attrs).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['read'] },
  { name: 'browser_get_console', description: 'Drain console messages buffered since a timestamp.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, since: { type: 'number' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_export_console', description: 'Write the console buffer to /workspace/.browser-logs/{tabId}.log.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['write'] },
  { name: 'browser_find_text', description: 'Locate an element by visible text.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, text: { type: 'string' } }, required: ['tabId', 'text'] }, categories: ['read'] },
  { name: 'browser_scroll_to', description: 'Scroll to (x, y).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['tabId', 'x', 'y'] }, categories: ['destructive'] },
  { name: 'browser_scroll_to_element', description: 'Scroll a selector into view.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, selector: { type: 'string' } }, required: ['tabId', 'selector'] }, categories: ['destructive'] },

  // Browser state (14.G)
  { name: 'browser_state_save', description: 'Save the tab\'s cookies + localStorage to a state file.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, stateId: { type: 'string' } }, required: ['tabId'] }, categories: ['write'] },
  { name: 'browser_state_load', description: 'Open a new tab pre-loaded with a saved state.', inputSchema: { type: 'object', properties: { stateId: { type: 'string' } }, required: ['stateId'] }, categories: ['destructive'] },
  { name: 'browser_state_list', description: 'List available browser state files.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'browser_state_delete', description: 'Delete a saved browser state.', inputSchema: { type: 'object', properties: { stateId: { type: 'string' } }, required: ['stateId'] }, categories: ['destructive'] },

  // Browser network interception (14.H)
  { name: 'browser_route_add', description: 'Add a network route (block | fulfill | continue).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, urlPattern: { type: 'string' }, action: { type: 'string', enum: ['block', 'fulfill', 'continue'] }, fulfill: { type: 'object' } }, required: ['tabId', 'urlPattern', 'action'] }, categories: ['outbound'] },
  { name: 'browser_route_remove', description: 'Remove a network route.', inputSchema: { type: 'object', properties: { routeId: { type: 'string' } }, required: ['routeId'] }, categories: ['outbound'] },
  { name: 'browser_route_list', description: 'List active network routes.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'browser_headers_set', description: 'Set extra HTTP headers on the page (all requests).', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, headers: { type: 'object' } }, required: ['tabId', 'headers'] }, categories: ['outbound'] },
  { name: 'browser_headers_scoped', description: 'Inject headers on requests matching a URL pattern.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, urlPattern: { type: 'string' }, headers: { type: 'object' } }, required: ['tabId', 'urlPattern', 'headers'] }, categories: ['outbound'] },
  { name: 'browser_headers_clear', description: 'Clear extra HTTP headers.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['write'] },
  { name: 'browser_requests_list', description: 'List captured HTTP requests for a tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, since: { type: 'number' } }, required: ['tabId'] }, categories: ['read'] },

  // Browser captcha (14.K)
  { name: 'browser_captcha_detect', description: 'Detect a captcha challenge in the page.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }, categories: ['read'] },
  { name: 'browser_captcha_wait', description: 'Long-poll until a captcha challenge disappears.', inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['tabId'] }, categories: ['read'] },

  // Sandbox meta (14.J) — sandboxInternal: only the sandbox-side SDK calls
  // these; the LLM has no reason to introspect its own sandbox runtime.
  { name: 'sandbox_context', description: 'Return sandbox context (capabilities, workspace size, env_summary).', inputSchema: { type: 'object', properties: {} }, categories: ['read'], sandboxInternal: true },
  { name: 'sandbox_list_python_packages', description: 'List installed Python packages via pip.', inputSchema: { type: 'object', properties: {} }, categories: ['read'], sandboxInternal: true },
  { name: 'sandbox_list_nodejs_packages', description: 'List globally installed Node.js packages.', inputSchema: { type: 'object', properties: {} }, categories: ['read'], sandboxInternal: true },
  { name: 'sandbox_restart', description: 'Drain and reset all long-lived sandbox resources.', inputSchema: { type: 'object', properties: {} }, categories: ['destructive'], sandboxInternal: true },

  // Proxy (14.L)
  { name: 'proxy_mapping_add', description: 'Add a forward-proxy mapping (regex → upstream).', inputSchema: { type: 'object', properties: { matchPattern: { type: 'string' }, upstreamUrl: { type: 'string' } }, required: ['matchPattern', 'upstreamUrl'] }, categories: ['outbound'] },
  { name: 'proxy_mapping_remove', description: 'Remove a proxy mapping.', inputSchema: { type: 'object', properties: { mappingId: { type: 'string' } }, required: ['mappingId'] }, categories: ['outbound'] },
  { name: 'proxy_mapping_list', description: 'List proxy mappings.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'proxy_exclude_add', description: 'Add a proxy exclude pattern (bypass).', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }, categories: ['outbound'] },
  { name: 'proxy_exclude_remove', description: 'Remove a proxy exclude.', inputSchema: { type: 'object', properties: { excludeId: { type: 'string' } }, required: ['excludeId'] }, categories: ['outbound'] },
  { name: 'proxy_exclude_list', description: 'List proxy excludes.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'proxy_upstream_set', description: 'Set the default upstream proxy (chain through corporate proxy etc.).', inputSchema: { type: 'object', properties: { upstreamUrl: { type: 'string' } }, required: ['upstreamUrl'] }, categories: ['outbound'] },
  { name: 'proxy_upstream_remove', description: 'Clear the default upstream proxy.', inputSchema: { type: 'object', properties: {} }, categories: ['outbound'] },
  { name: 'proxy_upstream_get', description: 'Get the current default upstream proxy.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'proxy_health', description: 'Forward proxy health snapshot.', inputSchema: { type: 'object', properties: {} }, categories: ['read'] },
  { name: 'proxy_diagnose', description: 'Probe a URL through the current proxy config.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, categories: ['outbound'] },

  // MCP from sandbox (14.Q) — sandboxInternal. These are SANDBOX-side
  // bridges: code running in the sandbox container calls them via
  // /v1/mcp/dispatch to broker MCP tool calls back through the runtime's
  // governance pipeline. The LLM has its OWN copy of every connector
  // tool already in its top-level catalog (gmail__send_email, etc.) and
  // never needs to indirect through `mcp_dispatch`. Exposing these to
  // the LLM causes a stub-fallback retry storm: the LLM can pick
  // `mcp_dispatch` as the most appropriate tool for "send an email" (the
  // description literally says "Dispatch an MCP tool call"), the hybrid
  // loop's `executeStandardTool` has no handler for it, and the invocation
  // burns its step budget before producing a real call.
  //
  // `mcp_dispatch` also stays uncategorized (`categories: []`) so the
  // sandbox-side dispatch pipeline's per-tool gate fires on the INNER
  // tool's categories, not on `mcp_dispatch` itself.
  { name: 'mcp_list_tools', description: 'List the agent\'s bound MCP tools available from sandbox code.', inputSchema: { type: 'object', properties: {} }, categories: ['read'], sandboxInternal: true },
  { name: 'mcp_dispatch', description: 'Dispatch an MCP tool call through the runtime governance pipeline.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, args: { type: 'object' }, idempotency_key: { type: 'string' } }, required: ['tool_name', 'args'] }, categories: [], sandboxInternal: true },
  { name: 'mcp_await_approval', description: 'Block until a HITL-pending MCP dispatch resolves.', inputSchema: { type: 'object', properties: { idempotencyKey: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['idempotencyKey', 'timeout_ms'] }, categories: ['read'], sandboxInternal: true },

  // VSCode discovery
  { name: 'vscode_get_url', description: 'Return a single-use ticketed URL to the openvscode-server IDE for human inspection.', inputSchema: { type: 'object', properties: {} }, categories: ['sensitive'] },
];

SANDBOX_FUNCTIONS.push(...PARITY_FUNCTIONS);

// ─── Registry Access ────────────────────────────────────────────────────────

/**
 * Returns all sandbox tool function definitions.
 * Used by tool catalog to present sandbox tools to the LLM.
 */
export function getSandboxFunctions(): ExecutionEnvironmentFunction[] {
  return SANDBOX_FUNCTIONS;
}

/**
 * Returns a single sandbox function definition by name.
 */
export function getSandboxFunction(name: string): ExecutionEnvironmentFunction | undefined {
  return SANDBOX_FUNCTIONS.find(f => f.name === name);
}

/**
 * Returns all sandbox function names.
 */
export function getSandboxFunctionNames(): string[] {
  return SANDBOX_FUNCTIONS.map(f => f.name);
}

/**
 * Checks if a tool name is a sandbox tool.
 */
export function isSandboxTool(toolName: string): boolean {
  return SANDBOX_FUNCTIONS.some(f => f.name === toolName);
}

export type SandboxCapability = 'shell' | 'file' | 'browser' | 'vscode';

/**
 * Filter sandbox functions for the LLM's tool catalog by per-agent
 * capabilities. The rules:
 *
 *   shell_* / bash_* / nodejs_*  → 'shell'
 *   file_*  / git_*              → 'file'
 *   browser_* / proxy_*          → 'browser'
 *   vscode_*                     → 'vscode'
 *   util_* / code_*              → any sandbox capability (these need a
 *                                  live sandbox to run; ungating them when
 *                                  the agent has no sandbox just gives the
 *                                  LLM a guaranteed-to-fail tool)
 *
 * `sandboxInternal` functions (`mcp_*`, `sandbox_*`) are NEVER returned —
 * they're internal bridges between sandbox-side code and the runtime, not
 * tools the LLM should be aware of. The unfiltered list is still available
 * to the sandbox-SDK builder via `getSandboxFunctions()`.
 *
 * This function used to have an `mcp_*`/`sandbox_*`/`util_*`/`code_*`
 * always-on branch that returned true regardless of caps. That put
 * `mcp_dispatch` into every agent's LLM catalog, and the
 * LLM picked it for the Gmail reply step because the description "Dispatch
 * an MCP tool call through the runtime governance pipeline" sounded
 * appealing. The hybrid loop's `executeStandardTool` had no handler for
 * `mcp_dispatch`, so it returned null on every call and the invocation
 * burned its step budget on `stub_fallback_fired` log lines. Fixed by
 * tagging the `mcp_*`/`sandbox_*` tools `sandboxInternal: true` and gating
 * `util_*`/`code_*` on the presence of ANY sandbox capability.
 */
export function filterSandboxFunctionsByCapabilities(
  capabilities: readonly SandboxCapability[],
): ExecutionEnvironmentFunction[] {
  const caps = new Set<SandboxCapability>(capabilities);
  const hasAnySandbox = caps.size > 0;
  return SANDBOX_FUNCTIONS.filter(f => {
    if (f.sandboxInternal) return false;
    if (f.name.startsWith('util_') || f.name.startsWith('code_')) {
      return hasAnySandbox;
    }
    if (f.name.startsWith('shell_') || f.name.startsWith('bash_') || f.name.startsWith('nodejs_')) {
      return caps.has('shell');
    }
    // `content_search` searches file CONTENTS and belongs with file_grep, but it
    // is the one tool whose name matches no prefix here. It is not
    // sandboxInternal, so it fell through to `return false` and no agent could
    // ever call it — the tool has been defined, described and unreachable.
    if (f.name.startsWith('file_') || f.name.startsWith('git_') || f.name.startsWith('content_')) {
      return caps.has('file');
    }
    if (f.name.startsWith('browser_') || f.name.startsWith('proxy_')) {
      return caps.has('browser');
    }
    if (f.name.startsWith('vscode_')) {
      return caps.has('vscode');
    }
    return false;
  });
}
