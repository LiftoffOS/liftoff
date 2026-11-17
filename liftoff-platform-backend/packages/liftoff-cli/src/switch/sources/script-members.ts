// A skill whose script reaches an outside service is not a skill. It is a team
// member.
//
// This is the shape of the problem. Somebody's skill ships `scripts/post.py`,
// and the script needs `GIPHY_API_KEY` to work. There are three things we could
// do with that, and only one of them is honest:
//
//   * Copy the key across. We do not take credentials off someone's machine,
//     and a key held by a script is a way to reach a service that the tool
//     governance, the connector audit and the meter never see. It is a side
//     door around the thing the platform exists to provide.
//   * Import the skill and say nothing. The team member then describes a script
//     it cannot run, and finds out mid-task.
//   * Turn the script into a team member of its own, bound to the CONNECTION
//     for that service, invoked only by the member that used to call the
//     script. Governed, audited, metered, like everything else here.
//
// The third is what this does. The script's own text becomes the distiller's
// evidence of what the work IS — it is never executed, and never shipped as a
// file for the new member to run. The new member does the work through a
// connector instead.
//
// A script that touches nothing outside — a document formatter, a text
// transform — is NOT converted. It stays a skill with its files, and runs in
// the sandbox exactly as before. Converting those would replace something
// deterministic with something that is not, for no gain.
//
// Where there is no Liftoff connection for the service, nothing is invented:
// the skill imports, and the gap is reported by name.

import type { ImportedSkillFile, RawIdentity, RawSkill, UnsupportedItem } from '../contract';
import { mapToCatalogConnector } from './connector-map';

/** Suffixes a credential's variable name carries, longest first so
 *  `_ACCESS_TOKEN` is stripped before `_TOKEN` turns it into `..._ACCESS`. */
const CREDENTIAL_SUFFIXES = [
  '_ACCESS_TOKEN',
  '_BOT_TOKEN',
  '_API_TOKEN',
  '_API_KEY',
  '_AUTH_TOKEN',
  '_SECRET_KEY',
  '_APP_TOKEN',
  '_TOKEN',
  '_APIKEY',
  '_SECRET',
  '_KEY',
  '_PAT',
];

/** The service a credential variable names, in the vocabulary
 *  `connector-map.ts` speaks. `GITHUB_TOKEN` is GitHub; `GIPHY_API_KEY` is
 *  giphy, which is nothing we connect to, and that is a fact worth reporting
 *  rather than a name worth guessing at. */
export function serviceHintFor(envName: string): string {
  let base = envName.toUpperCase();
  for (const suffix of CREDENTIAL_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.toLowerCase().replace(/_/g, '-');
}

export interface ScriptMemberSplit {
  /** Skills that stay skills. */
  skills: RawSkill[];
  /** Scripts that became team members, to be delegated to by their parent. */
  members: RawIdentity[];
  unsupported: UnsupportedItem[];
}

/** Partition an identity's skills into the ones that stay and the ones that
 *  become team members.
 *
 *  Deliberately unbounded. Conversion is rate-limited and resumes itself, so a
 *  large import takes several waves rather than being refused — there is no
 *  member count to stay under. */
export function splitScriptMembers(skills: RawSkill[]): ScriptMemberSplit {
  const staying: RawSkill[] = [];
  const members: RawIdentity[] = [];
  const unsupported: UnsupportedItem[] = [];

  for (const skill of skills) {
    const credentials = skill.referencedSecretNames ?? [];

    // Touches nothing outside: stays a skill, keeps its files, runs in the
    // sandbox. This is the majority.
    if (credentials.length === 0) {
      staying.push(skill);
      continue;
    }

    const connectorTypes: string[] = [];
    const unmatched: string[] = [];
    for (const envName of credentials) {
      const mapped = mapToCatalogConnector(serviceHintFor(envName));
      if (mapped && !connectorTypes.includes(mapped.connectorType)) {
        connectorTypes.push(mapped.connectorType);
      } else if (!mapped) {
        unmatched.push(envName);
      }
    }

    // Nothing we connect to. The skill still imports — its text is the person's
    // own work — but the script cannot reach that service from here, and saying
    // so is the whole point.
    if (connectorTypes.length === 0) {
      staying.push(skill);
      unsupported.push({
        sourceRef: `${skill.sourceRef}:credentials`,
        reason: 'policy_without_liftoff_equivalent',
        detail:
          `The ${skill.name} skill runs a script that needs ${credentials.join(', ')}. ` +
          'Liftoff reaches other services through connections rather than stored keys, and there ' +
          'is no connection for this one, so the script will not run here.',
        sourcePath: skill.sourcePath,
      });
      continue;
    }

    members.push(memberFor(skill, connectorTypes));

    // A credential this member's connection does not cover. Reported so the
    // person is not left believing the whole script came across.
    if (unmatched.length > 0) {
      unsupported.push({
        sourceRef: `${skill.sourceRef}:partial-credentials`,
        reason: 'policy_without_liftoff_equivalent',
        detail:
          `${skill.name} also expects ${unmatched.join(', ')}, which matches no Liftoff ` +
          'connection. That part of its work will not be available.',
        sourcePath: skill.sourcePath,
      });
    }
  }

  return { skills: staying, members, unsupported };
}

/** Build the team member a script becomes.
 *
 *  It carries no files. The script's text goes in as EVIDENCE of what the work
 *  is, for the distiller to describe — the new member does that work through a
 *  connector, so shipping the script for it to run would be handing it back the
 *  thing we just replaced. */
function memberFor(skill: RawSkill, connectorTypes: string[]): RawIdentity {
  const scriptEvidence = (skill.files ?? [])
    .filter((f) => isScript(f))
    .map((f) => `----- source: ${f.path} -----\n${f.text}`)
    .join('\n\n');

  return {
    sourceRef: `script-member:${skill.name}`,
    displayName: skill.name,
    artifacts: [
      {
        sourcePath: skill.sourcePath,
        text: scriptEvidence
          ? `${skill.text}\n\nThis team member replaces a script that did the following work:\n\n${scriptEvidence}`
          : skill.text,
        category: 'instructions',
      },
    ],
    memories: [],
    skills: [],
    // Becomes a connection requirement through the adapters' existing
    // integrationRefs handling, so the member is bound to a governed connector
    // rather than to a key.
    integrationRefs: connectorTypes,
    mcpServerRefs: [],
    routineRefs: [],
    delegatesTo: [],
  };
}

/** Executable-looking files. A `references/` markdown file is not evidence of
 *  what a script does; a `.py` or a `.sh` is. */
function isScript(file: ImportedSkillFile): boolean {
  return /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|lua|php)$/i.test(file.path);
}
