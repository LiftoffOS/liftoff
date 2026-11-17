// The distiller may only equip an agent with tools that will exist, and it must
// be told what those tools are called before it authors against them. A tier is
// resolvable from the distiller's own output, so the catalog cannot be gated on
// signals known before the call.

// Same transitive-import mocks as distill-prompt.test.ts: this file reads pure
// constants and one pure function, and the real modules drag in proto-gen,
// which does not resolve inside a worktree.
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  findCapabilityViolations,
  buildWorkspaceToolsText,
  __internalGetPromptText,
} from '../distill-service';

describe('the distiller is told what the workspace tools are called', () => {
  const text = buildWorkspaceToolsText();

  it('names each tool the runtime registry actually exposes', () => {
    // These must stay the runtime's names. SDK-style names (Bash, Read, Write)
    // exist only inside a nested code_session, so a workflow authored against
    // them fails graph validation at run start.
    //
    // This list previously read file_glob / file_grep. Neither exists: the
    // registry calls them file_search and content_search, and git_clone /
    // git_commit_and_push were missing from it entirely. So the test named
    // "capability truth" was pinning the untruth, which is how the drift
    // survived — a step could be authored against a tool that cannot dispatch,
    // and the one check meant to catch that agreed with it.
    for (const name of [
      'shell_exec', 'file_read', 'file_write', 'file_edit',
      'file_search', 'content_search', 'git_clone', 'git_commit_and_push',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('does not name a tool the runtime has never had', () => {
    // Matched as tool ENTRIES, not substrings: the descriptions legitimately
    // contain the words "Read" and "Write", and asserting on those would fail
    // on prose rather than on a tool that cannot dispatch.
    for (const ghost of ['file_glob', 'file_grep', 'Bash', 'Read', 'Write', 'Glob', 'Grep']) {
      expect(text).not.toMatch(new RegExp(`^- ${ghost}\\(`, 'm'));
    }
    // These two never existed under any spelling.
    expect(text).not.toContain('file_glob');
    expect(text).not.toContain('file_grep');
  });

  // The omission that produces `{"command":"echo ..."}` against a tool whose
  // first parameter is an args ARRAY. Connector tools list their parameters;
  // without the same here, the model has to guess.
  it('lists each tool\'s parameters, marking the required ones', () => {
    expect(text).toContain('shell_exec(args*, workDir, timeout)');
    expect(text).toContain('file_edit(path*, oldText*, newText*)');
    expect(text).toContain('git_commit_and_push(files*, message*, branch*)');
  });

  it('says outright that shell_exec takes an array, not a shell string', () => {
    expect(text).toMatch(/separate strings in the args array/);
    expect(text).toMatch(/do NOT pass a single shell string/);
  });

  // The ask_user rule read "information the agent genuinely cannot infer" and a
  // distillation still asked which repository to use, for an agent whose text
  // enumerates four of them and defaults the branch. An adjective is not a
  // test, so the prompt now carries one.
  it('makes the ask_user rule a test rather than an adjective', () => {
    const prompt = __internalGetPromptText();
    expect(prompt).toMatch(/AUTHORED INPUTS enumerate the answer/);
    // Every block the model is handed, not the responsibilities alone —
    // ADDITIONAL_CONTEXT is where operational detail like a repository list
    // most often lives, and a value there passed the first version of this test.
    expect(prompt).toMatch(/ROLE, RESPONSIBILITIES and ADDITIONAL_CONTEXT/);
    expect(prompt).toMatch(/not the same as "not supplied"/);
    expect(prompt).toMatch(/Does the request carry it/);
    expect(prompt).toMatch(/stated DEFAULT or an inference rule/);
  });

  it('requires a condition on an ask_user reached only in a specific case', () => {
    const prompt = __internalGetPromptText();
    expect(prompt).toMatch(/MUST carry a \\`condition\\`|MUST carry a `condition`/);
    expect(prompt).toMatch(/reads \\`condition\\` and never reads \\`description\\`|reads `condition` and never reads `description`/);
  });

  it('ties availability to the field that actually grants it', () => {
    expect(text).toContain('capabilityNeeds.workspace: true');
  });

  it('forbids naming a command-line program or a scratch path as a given', () => {
    // A program named without a workspace tool to carry it does not run, and a
    // path outside the run's workspace cannot be read back.
    expect(text).toMatch(/curl/);
    expect(text).toMatch(/python/);
    expect(text).toMatch(/\/tmp\/something\.json/);
    expect(text).toMatch(/shell_exec/);
  });

  it('routes web reading to the platform research tools, not shell_exec', () => {
    // v45: reading a page or researching is NOT workspace work. The old text
    // told the model "fetching a URL is workspace work — use shell_exec", which
    // made every research agent curl pages in the sandbox (unsourced, and for
    // the first CI-Analyst a hallucinated answer). The rule now points web work
    // at the platform research tools and reserves shell_exec for local compute.
    expect(text).toMatch(/NOT workspace work/i);
    expect(text).toMatch(/web_research/);
    expect(text).toMatch(/local computation/i);
    expect(text).not.toMatch(/Fetching a URL, calling an HTTP API, or parsing a response is workspace work/);
  });

  it('says a modest in-run list needs no workspace, so the tier stays honest', () => {
    expect(text).toMatch(/needs no workspace/i);
  });
});

describe('the workspace toolset is offered on every distillation', () => {
  // Source-level, because the seeding sits inside the distill flow after a
  // manifest fetch and an LLM call. The property: seeding must not be nested
  // under the pre-call detection signals, since capabilityTier is decided partly
  // from the LLM's own output, which arrives after this point.
  const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

  it('seeds the catalog outside the sandboxDetected branch', () => {
    const seeding = SRC.indexOf('const sandboxTools = getSandboxToolDefinitionsForDistill();');
    const branch = SRC.indexOf('if (sandboxDetected) {');
    expect(seeding).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(-1);
    expect(seeding).toBeLessThan(branch);
  });

  it('renders the section into the prompt unconditionally', () => {
    expect(SRC).toContain('const workspaceToolsText = buildWorkspaceToolsText();');
    expect(SRC).toMatch(/\$\{workspaceToolsText\}/);
  });

  it('does not let a never-empty catalog blank the integrations section', () => {
    // This function renders integrations and groups catalog tools under them, so
    // emptiness is a property of the integrations alone. The catalog always holds
    // the workspace toolset and is never a proxy for having nothing to say.
    expect(SRC).toContain('if (integrations.length === 0) {');
    expect(SRC).not.toContain('if (integrations.length === 0 && catalog.size === 0) {');
  });
});

describe('a distillation may not reach for a workspace it did not ask for', () => {
  const prose = (text: string) => ({
    workspaceGranted: false,
    fields: [{ where: 'instructionsMd', text }],
  });

  it('rejects a workspace tool named while the need is declared false', () => {
    const violations = findCapabilityViolations(prose(
      'Read the existing rows with file_read before appending anything.',
    ));
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('workspace_tool_without_need');
    // The feedback has to offer both ways out, or the model can only guess.
    expect(violations[0].detail).toContain('capabilityNeeds.workspace: true');
    expect(violations[0].detail).toContain('connector tools');
  });

  it('accepts the same reference once the need is declared', () => {
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Read the existing rows with file_read.' }],
    })).toHaveLength(0);
  });

  it('rejects a workflow step that calls a workspace tool without the need', () => {
    const violations = findCapabilityViolations({
      workspaceGranted: false,
      fields: [],
      workflowSteps: [
        { stepId: 'fetch', description: 'Fetch the page', toolName: 'shell_exec' },
        { stepId: 'note', description: 'Write it down', toolName: 'sheets__append_values' },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].where).toBe('workflowSteps["fetch"]');
  });

  it('does not treat the word workspace as a signal', () => {
    // "workspace" means the tenant across most of this product's own copy;
    // matching ordinary vocabulary would classify on phrasing rather than need.
    expect(findCapabilityViolations(prose(
      'Share the summary with everyone in the workspace, and note the workspace timezone.',
    ))).toHaveLength(0);
  });
});

describe('a distillation may not hand the agent a path it cannot reach', () => {
  it.each([
    ['/tmp/existing_urls.json', 'Save the list of seen URLs to /tmp/existing_urls.json and re-read it.'],
    ['~/state.json', 'Keep running state in ~/state.json between pages.'],
  ])('rejects %s', (_label, text) => {
    const violations = findCapabilityViolations({
      // Granted, so this is not a workspace-need failure — the path is wrong
      // even for an agent that HAS a workspace, because the file tools resolve
      // against the run's own workspace root.
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe('unreachable_path');
  });

  it('leaves system paths alone, which are legitimate read targets in a repository', () => {
    // Narrowed deliberately: reading a config file is ordinary work for an agent
    // in a cloned repository. Only scratch-state shapes (/tmp, ~) are reported.
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Check the server block in /etc/nginx/nginx.conf.' }],
    })).toHaveLength(0);
  });

  it('does not fire on ordinary prose that merely contains the letters tmp or a slash', () => {
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Attempt the fetch, then record goal/raised amounts.' }],
    })).toHaveLength(0);
  });

  it('reports one path per field rather than every occurrence', () => {
    const violations = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Write /tmp/a.json then /tmp/b.json then /tmp/c.json.' }],
    });
    expect(violations).toHaveLength(1);
  });

  it('scans every authored field, not just one', () => {
    const violations = findCapabilityViolations({
      workspaceGranted: true,
      fields: [
        { where: 'the system prompt', text: 'State in /tmp/a.json.' },
        { where: 'the user instructions', text: 'Cache to /tmp/b.json.' },
      ],
    });
    expect(violations.map(v => v.where)).toEqual(['the system prompt', 'the user instructions']);
  });
});

describe('every field that instructs the agent is scanned, not only the prose blocks', () => {
  // A skill's instruction is what the runtime injects at an llm_reason step and
  // during recovery, and a step description IS the prompt for such a step, so a
  // tool the agent lacks does as much damage there as in the system prompt.
  const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

  it('includes each skill instruction', () => {
    expect(SRC).toMatch(/where: `the skill "\$\{skill\.name\}"`, text: skill\.instruction/);
  });

  it('includes each workflow step description', () => {
    expect(SRC).toMatch(/where: `workflowSteps\["\$\{step\.stepId\}"\]`, text: step\.description/);
  });

  it('passes the assembled list rather than the three literals', () => {
    expect(SRC).toContain('fields: authoredFields,');
  });

  it('clears retry feedback once delivered, so attempts do not accumulate stale complaints', () => {
    // Two validators write to one feedback channel, so an attempt must report
    // only its own failures; a carried-over complaint asks the model to correct
    // something that is no longer wrong.
    const delivered = SRC.indexOf('Your previous response had validation errors');
    expect(delivered).toBeGreaterThan(-1);
    const after = SRC.slice(delivered, delivered + 600);
    expect(after).toContain('validationFeedback = null;');
  });

  it('still catches a violation carried in a skill', () => {
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{
        where: 'the skill "Recording new fundraisers"',
        text: 'Keep the list of URLs already recorded in /tmp/existing_urls.json.',
      }],
    })).toEqual([expect.objectContaining({ kind: 'unreachable_path' })]);
  });
});

describe('the distiller is told the obligations a goal carries', () => {
  const prompt = __internalGetPromptText();

  it('states that the person will not name the obligations themselves', () => {
    expect(prompt).toContain('Reliability obligations the goal implies');
    expect(prompt).toMatch(/must not need them to/i);
  });

  it('requires adopting the store\'s existing layout rather than inventing one', () => {
    // A store that already exists owns its layout; a layout named here is the
    // one that will not match it.
    expect(prompt).toMatch(/the store's own shape is the specification/i);
    expect(prompt).toMatch(/never rename a field/i);
    expect(prompt).toMatch(/never impose a shape on a store that already has one/i);
  });

  it('forbids the distiller from specifying its own field layout', () => {
    // The person does not list their columns because they expect the agent to
    // read them, so a layout the distiller invents is the one that will not match.
    expect(prompt).toMatch(/do NOT specify a field layout of your own/i);
    expect(prompt).toMatch(/expect the agent to read them/i);
  });

  it('states how to fill a column the source has no value for', () => {
    // first-seen vs last-updated semantics, generically rather than per agent.
    expect(prompt).toMatch(/first-seen or created date is set once/i);
    expect(prompt).toMatch(/last-updated or last-checked date is rewritten/i);
    expect(prompt).toMatch(/maintains by hand is never overwritten/i);
  });

  it('stops rather than guessing when the header cannot be read', () => {
    expect(prompt).toMatch(/shape cannot be read.{0,140}stop and report/i);
  });

  it('names the key as the store names it', () => {
    expect(prompt).toMatch(/name it as the store names it/i);
  });

  it('requires reading existing keys before fetching or writing', () => {
    expect(prompt).toMatch(/Read the existing keys FIRST/);
  });

  it('requires a failed read to stop the run rather than read as empty', () => {
    expect(prompt).toMatch(/failed or unreadable read stops the run/i);
    expect(prompt).toMatch(/Never treat it as proof the store is empty/i);
  });

  it('forbids inferring the store contents from where a write landed', () => {
    expect(prompt).toMatch(/Never infer the store's contents from a write's result/);
  });

  it('requires per-page persistence rather than one write at the end', () => {
    expect(prompt).toMatch(/complete one page end to end/i);
    expect(prompt).toMatch(/Do not gather every page and write once at the end/i);
  });

  it('requires a rerun to converge instead of duplicating', () => {
    expect(prompt).toMatch(/rerun converges/i);
  });

  it('tells it to write the obligations in rather than ask the person for detail', () => {
    expect(prompt).toMatch(/never as a note telling the person to be more specific/i);
  });
});

describe('the obligations are stated for any store, not one shape of store', () => {
  const prompt = __internalGetPromptText();

  it('names stores beyond a spreadsheet', () => {
    // A CRM object and an issue have fields, not a header row. The obligations
    // are identical; only the target system's vocabulary differs.
    for (const store of ['spreadsheet', 'database table', 'CRM object', 'issue tracker']) {
      expect(prompt).toContain(store);
    }
  });

  it('maps its own vocabulary onto the target system', () => {
    expect(prompt).toMatch(/Read "record" for row\/object\/issue\/page/i);
    expect(prompt).toMatch(/"field" for column\/property\/attribute/i);
  });

  it('prefers the target system\'s own upsert over a hand-rolled compare', () => {
    expect(prompt).toMatch(/upsert semantics/i);
  });

  it('covers work that arrives as well as work that is stored', () => {
    // Acting twice cannot be undone, so exactly-once matters more here than for
    // a record that can be de-duplicated afterwards.
    expect(prompt).toMatch(/Acting on each inbound thing exactly once/i);
    expect(prompt).toMatch(/duplicate is an ACTION rather than a record/i);
    expect(prompt).toMatch(/Check that record before acting, not after/i);
  });

  it('prefers vendor idempotency and stops when it cannot tell', () => {
    expect(prompt).toMatch(/target system's own idempotency/i);
    expect(prompt).toMatch(/cannot tell whether it already acted, it stops/i);
  });
});

describe('prose may not name a connector tool that does not exist', () => {
  const catalog = new Map<string, { name: string; description: string }>([
    ['google-sheets-d14f7fd5__batch_get_values', { name: 'google-sheets-d14f7fd5__batch_get_values', description: 'read' }],
    ['google-sheets-d14f7fd5__batch_update_values', { name: 'google-sheets-d14f7fd5__batch_update_values', description: 'write' }],
    ['google-sheets-d14f7fd5__append_values', { name: 'google-sheets-d14f7fd5__append_values', description: 'append' }],
  ]) as never;

  it('flags a near-miss on a real tool name', () => {
    // Step toolNames are validated against the catalog; the prose telling the
    // agent HOW to work was not, so a plausible-looking name reached the agent.
    const v = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'the skill "Writing rows"', text: 'Update the row with google-sheets-d14f7fd5__update_values.' }],
      catalog,
    });
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('unknown_tool_reference');
    expect(v[0].detail).toContain('google-sheets-d14f7fd5__update_values');
    // The feedback must name the replacement, not merely reject the name.
    expect(v[0].detail).toContain('use "google-sheets-d14f7fd5__batch_update_values"');
    // And it must not license dropping the tool reference to satisfy the check.
    expect(v[0].detail).toMatch(/do not drop the tool reference/i);
  });

  it('accepts every name the catalog does expose', () => {
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Read with google-sheets-d14f7fd5__batch_get_values then append with google-sheets-d14f7fd5__append_values.' }],
      catalog,
    })).toHaveLength(0);
  });

  it('ignores aliases the catalog does not know', () => {
    // Runtime-only platform tools (memory, web, delegation) never appear in the
    // distill catalog, so their absence here is not evidence of invention.
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Delegate via internal__software_engineer__execute when needed.' }],
      catalog,
    })).toHaveLength(0);
  });

  it('does nothing when no catalog is supplied', () => {
    expect(findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Call google-sheets-d14f7fd5__made_up_tool.' }],
    })).toHaveLength(0);
  });

  it('reports each distinct invented name once', () => {
    const v = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'instructionsMd', text: 'Use google-sheets-d14f7fd5__update_values, then google-sheets-d14f7fd5__update_values again, then google-sheets-d14f7fd5__delete_row.' }],
      catalog,
    });
    expect(v).toHaveLength(1);
    expect(v[0].detail).toContain('update_values');
    expect(v[0].detail).toContain('delete_row');
  });
});

describe('a wrong tool name is reported with the closest real one', () => {
  const cat = (names: string[]) => new Map(names.map(n => {
    const full = `sheets-a1__${n}`;
    return [full, { name: full, description: 'x' }];
  })) as never;

  it('suggests the near-miss it was probably reaching for', () => {
    const v = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'md', text: 'Call sheets-a1__update_values now.' }],
      catalog: cat(['batch_update_values', 'append_values', 'get_sheet_names']),
    });
    expect(v[0].detail).toContain('use "sheets-a1__batch_update_values"');
  });

  it('says so plainly when nothing in the catalog is close', () => {
    const v = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'md', text: 'Call sheets-a1__send_carrier_pigeon now.' }],
      catalog: cat(['batch_get_values', 'append_values']),
    });
    expect(v[0].detail).toContain('no equivalent exists');
  });

  it('never suggests an unrelated tool', () => {
    const v = findCapabilityViolations({
      workspaceGranted: true,
      fields: [{ where: 'md', text: 'Call sheets-a1__zzz now.' }],
      catalog: cat(['append_values']),
    });
    expect(v[0].detail).not.toContain('use "sheets-a1__append_values"');
  });
});

describe('a value is written in the format its field already uses', () => {
  const prompt = __internalGetPromptText();

  it('converts the source into the field\'s form, not the reverse', () => {
    expect(prompt).toMatch(/written the way that field already writes it/i);
    expect(prompt).toMatch(/convert the source's representation into the field's, rather than the reverse/i);
  });

  it('covers dates, amounts and identifiers, not just numbers', () => {
    expect(prompt).toMatch(/epoch integer/i);
    expect(prompt).toMatch(/currency symbol/i);
    expect(prompt).toMatch(/identifier field already has a canonical form/i);
  });

  it('names the self-match failure a mismatched key form causes', () => {
    // A key read as a bare id and written as a full URL stops matching itself,
    // which reads as "everything is new" on the next run.
    expect(prompt).toMatch(/will not match itself on the next run/i);
  });

  it('forbids changing a format a field already uses', () => {
    expect(prompt).toMatch(/Never change the format a field already uses/i);
  });
});

describe('the connector type is read under every name a caller supplies it by', () => {
  // A manifest is matched on the connector type, and the type arrives as `type`
  // from the distill routers, `integrationId` from a stored agent row, and
  // `connectorType` from the registry. Reading only `type` builds an empty
  // catalog, and an empty catalog makes every tool-name check vacuously pass.
  const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

  it('falls back to integrationId and connectorType', () => {
    expect(SRC).toMatch(/i\.type \|\| withAliases\.integrationId \|\| withAliases\.connectorType/);
  });

  it('matches manifests on the resolved type, not on the raw field', () => {
    // `connectorTypeOfIntegration` is the shared module-level resolver. It was
    // three local copies (catalog builder, prompt formatter, trigger-coverage
    // check) until the formatter's copy turned out to be no copy at all — it
    // read `i.type` directly and threw on a stored row that had none.
    expect(SRC).toMatch(/integrations\.map\(connectorTypeOfIntegration\)\.filter\(Boolean\)/);
    expect(SRC).not.toMatch(/integrations\.map\(i => i\.type\)\.filter\(Boolean\)/);
  });

  it('warns when integrations are bound but nothing matched', () => {
    // Silence here is what let a blind distillation look identical to an agent
    // that has no connectors.
    expect(SRC).toContain("metric: 'distill.catalog.no_manifest_match'");
    expect(SRC).toMatch(/integrations\.length > 0 && uniqueManifests\.length === 0/);
    // Both sides of the comparison, or the warning cannot be acted on.
    expect(SRC).toMatch(/integrationTypes: \[\.\.\.integrationTypes\]/);
    expect(SRC).toMatch(/availableConnectorTypes/);
  });
});
