// An imported skill's FILES have to become something.
//
// This is the seam where they would go missing, and it is invisible from either
// end: the CLI collects the files, the wire schema validates them, the bundle
// stores them — and distillation never sees them, because a classifier reads
// material to SORT and a `scripts/run.py` is not material to sort. Everything
// would report success while the scripts a skill describes were never there.

import { sourceMigrationService } from '../service';
import { sourceMigrationRepository as repo } from '../repository';
import * as provisioning from '../../internal-agents/provisioning-helper';
import * as connections from '../connections';
import * as admission from '../admission';
import * as skillImport from '../../internal-agents/skill-import-service';
import type { SourceMigration, SourceMigrationItem } from '../types';

jest.mock('../repository');
jest.mock('../../internal-agents/provisioning-helper');
jest.mock('../connections');
jest.mock('../../internal-agents/skill-import-service');
jest.mock('../../internal-agents/service', () => ({
  InternalAgentService: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn().mockResolvedValue({ id: 'agent-1' }),
  })),
}));

const mockRepo = repo as jest.Mocked<typeof repo>;
const mockProvision = provisioning as jest.Mocked<typeof provisioning>;
const mockConnections = connections as jest.Mocked<typeof connections>;
const mockSkillImport = skillImport as jest.Mocked<typeof skillImport>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

const SKILL_FILE = { path: 'scripts/run.py', text: 'print("hi")' };

function migration(): SourceMigration {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    source: 'claude-code',
    state: 'converting',
    libraryApprovals: [],
    bundle: {
      skills: [
        {
          sourceRef: 'skill:deploy',
          identitySourceRef: 'assistant:primary',
          name: 'deploy',
          content: '# Deploy\nRun the checks first.',
          sourcePath: '~/.claude/skills/deploy/SKILL.md',
          files: [SKILL_FILE],
        },
        {
          sourceRef: 'skill:notes',
          identitySourceRef: 'assistant:primary',
          name: 'notes',
          content: '# Notes',
          sourcePath: '~/.claude/skills/notes.md',
        },
      ],
    },
  } as unknown as SourceMigration;
}

function item(): SourceMigrationItem {
  return {
    id: 'item-1',
    sourceRef: 'assistant:primary',
    state: 'pending',
    attempts: 0,
    destinationAgentId: null,
    distillOutput: null,
    normalizedInputHash: 'hash',
    distillInput: {
      role: 'Assistant',
      responsibilities: 'Do the work',
      attachments: [],
      integrationRefs: [],
      mcpServerRefs: [],
      routineRefs: [],
    },
  } as unknown as SourceMigrationItem;
}

beforeEach(() => {
  jest.clearAllMocks();

  mockConnections.resolveAgentBindings.mockResolvedValue({
    integrations: [],
    pendingIntegrations: [],
  });
  mockRepo.listRoutines.mockResolvedValue([]);
  mockProvision.provisionAgentFromDistill.mockResolvedValue({
    agent: { id: 'agent-1' } as never,
    distillOutput: { summary: 's' } as never,
    reusedDistill: false,
  });
  jest.spyOn(admission, 'reserveDistillSlot').mockResolvedValue({ allowed: true });

  mockSkillImport.applyImportedSkills.mockResolvedValue({
    imported: 1,
    skippedAsDuplicate: 0,
    refusedByScreening: 0,
    quarantined: [],
  });
});

describe('imported skill files reach the team member', () => {
  it('applies the skills that ship files, with their files', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());

    expect(mockSkillImport.applyImportedSkills).toHaveBeenCalledTimes(1);
    const [tenantArg, agentArg, skillsArg] = mockSkillImport.applyImportedSkills.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(agentArg).toBe('agent-1');
    expect(skillsArg).toEqual([
      expect.objectContaining({ name: 'deploy', files: [SKILL_FILE] }),
    ]);
  });

  it('leaves a text-only skill alone, because distillation already owns it', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());

    const [, , skillsArg] = mockSkillImport.applyImportedSkills.mock.calls[0];
    expect((skillsArg as Array<{ name: string }>).map((s) => s.name)).not.toContain('notes');
  });

  it('does nothing when no imported skill ships a file', async () => {
    const withoutFiles = migration();
    (withoutFiles.bundle as { skills: Array<{ files?: unknown }> }).skills.forEach((s) => {
      delete s.files;
    });

    await sourceMigrationService.convertItem(TENANT, ACCOUNT, withoutFiles, item());

    expect(mockSkillImport.applyImportedSkills).not.toHaveBeenCalled();
  });

  it('still records the team member when the files cannot be applied', async () => {
    // A file that did not land must not fail a member that did.
    mockSkillImport.applyImportedSkills.mockRejectedValue(new Error('storage down'));

    await expect(
      sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item()),
    ).resolves.toBeUndefined();

    expect(mockRepo.saveDestinationAgent).toHaveBeenCalledWith(TENANT, 'item-1', 'agent-1');
  });
});
