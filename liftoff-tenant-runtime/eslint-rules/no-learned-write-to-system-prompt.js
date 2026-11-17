'use strict';

/**
 * Learned content never writes to the base prompt.
 *
 * `BASELINE_SKILLS` live in code with the stated reason "so reflection-engine
 * cannot mutate them and so no per-agent backfill is required" — the right
 * instinct, applied to one thing. The distilled `instruction.systemPrompt` has
 * no such guard, and `buildSystemPrompt` layers `instructionsMd`,
 * `learnedInstructionsMd` and `learned_role_instructions` ON TOP of it precisely
 * because learned content is supposed to stay separate from what a person
 * authored.
 *
 * Nothing enforced that separation. A learning path that wrote to the base
 * prompt would look like every other write, ship green, and silently make the
 * operator's own words unrecoverable — there is no layer underneath to fall back
 * to. The layered fields exist so learned content can be reviewed, narrowed, or
 * dropped without touching what the operator wrote; a write to the base collapses
 * that distinction permanently.
 *
 * Scope: modules under src/learning/, src/reflection-engine/, and any file whose
 * path names skill feedback. Everywhere else, writing systemPrompt is ordinary
 * — the instruction compiler and the distiller are supposed to.
 *
 * Learned content goes to `learnedInstructionsMd`, `learned_role_instructions`,
 * `agent_skills` or `memories`. Never the base.
 */

/** Path fragments whose modules produce LEARNED content. */
const LEARNING_PATHS = [
  '/src/learning/',
  '/src/reflection-engine/',
  'skill-feedback',
  'skill-provenance',
];

/** Assignment targets that mean "the base prompt". */
const BASE_PROMPT_NAMES = new Set(['systemPrompt', 'system_prompt']);

/** Columns that are the base prompt, in SQL. */
const BASE_PROMPT_SQL = /\bUPDATE\s+(?:agents|internal_agents)\b[\s\S]{0,200}?\bSET\b[\s\S]{0,200}?\bsystem_prompt\s*=/i;

function isLearningModule(filename) {
  const normalized = String(filename).replace(/\\/g, '/');
  return LEARNING_PATHS.some((p) => normalized.includes(p));
}

/** Callee names that mean the object is being PERSISTED rather than read.
 *  Matched case-insensitively on the final identifier, so `repo.updateAgent`,
 *  `service.update` and `saveInstruction` all qualify. */
const WRITE_VERBS = /(?:^|[a-z])(update|save|set|write|upsert|patch|create|insert|persist|apply|store)(?:[A-Z]|$)/;

function isWriteCallee(callee) {
  if (!callee) return false;
  const name = callee.type === 'Identifier'
    ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
      ? callee.property.name
      : null;
  if (!name) return false;
  return WRITE_VERBS.test(name);
}

/** The escape hatch. A learning module that genuinely must touch the base — a
 *  migration helper, a test fixture — says so and says why. */
function hasEscapeHatch(sourceCode, node) {
  const comments = [
    ...sourceCode.getCommentsBefore(node),
    ...(sourceCode.getCommentsInside ? sourceCode.getCommentsInside(node) : []),
  ];
  return comments.some((c) => /BASE_PROMPT_WRITE_OK:\s*\S/.test(c.value));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Learned content (reflection, skill feedback) must not write to the distilled base system prompt',
    },
    messages: {
      learnedWrite:
        'A module under src/learning/ or src/reflection-engine/ is writing to `{{name}}`. '
        + 'The base prompt is what the operator authored and there is no layer underneath it to fall back to. '
        + 'Write learned content to learnedInstructionsMd, learned_role_instructions, agent_skills or memories instead. '
        + 'If this genuinely must touch the base, add `// BASE_PROMPT_WRITE_OK: <reason>`.',
      learnedSqlWrite:
        'A module under src/learning/ or src/reflection-engine/ is UPDATEing `system_prompt`. '
        + 'The base prompt is what the operator authored and there is no layer underneath it to fall back to. '
        + 'If this genuinely must touch the base, add `// BASE_PROMPT_WRITE_OK: <reason>`.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isLearningModule(filename)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** `x.systemPrompt = …`, `systemPrompt = …`, and destructured writes. */
    function checkAssignment(node) {
      const left = node.left;
      if (!left) return;
      let name = null;
      if (left.type === 'Identifier') name = left.name;
      else if (left.type === 'MemberExpression' && !left.computed && left.property.type === 'Identifier') {
        name = left.property.name;
      } else if (left.type === 'MemberExpression' && left.computed
        && left.property.type === 'Literal' && typeof left.property.value === 'string') {
        name = left.property.value;
      }
      if (!name || !BASE_PROMPT_NAMES.has(name)) return;
      if (hasEscapeHatch(sourceCode, node)) return;
      context.report({ node, messageId: 'learnedWrite', data: { name } });
    }

    /** `{ systemPrompt: … }` in an object passed to a WRITE call. An object
     *  literal is how most writes actually reach a service, so an
     *  assignment-only rule would miss nearly all of them.
     *
     *  Narrowed to write-shaped callees deliberately. Learning modules legitimately
     *  READ the base prompt — a baseline snapshot has to, or the lost-update guard
     *  has nothing to hash — and a rule that fires on
     *  `hashInstructionState({ systemPrompt })` is a rule someone disables, which
     *  costs the real protection to keep a false one. */
    function checkProperty(node) {
      if (node.computed) return;
      const key = node.key;
      const name = key.type === 'Identifier' ? key.name
        : key.type === 'Literal' && typeof key.value === 'string' ? key.value
          : null;
      if (!name || !BASE_PROMPT_NAMES.has(name)) return;
      const parent = node.parent;                 // ObjectExpression
      const grandparent = parent && parent.parent;
      const isCallArgument = grandparent
        && (grandparent.type === 'CallExpression' || grandparent.type === 'NewExpression')
        && grandparent.arguments.includes(parent);
      if (!isCallArgument) return;
      if (!isWriteCallee(grandparent.callee)) return;
      if (hasEscapeHatch(sourceCode, node) || hasEscapeHatch(sourceCode, parent)) return;
      context.report({ node, messageId: 'learnedWrite', data: { name } });
    }

    /** `UPDATE agents SET system_prompt = …` — the write that bypasses every
     *  service seam. */
    function checkSql(node) {
      const raw = node.type === 'TemplateLiteral'
        ? node.quasis.map((q) => q.value.raw).join(' ')
        : typeof node.value === 'string' ? node.value : '';
      if (!raw || !BASE_PROMPT_SQL.test(raw)) return;
      if (hasEscapeHatch(sourceCode, node)) return;
      context.report({ node, messageId: 'learnedSqlWrite' });
    }

    return {
      AssignmentExpression: checkAssignment,
      Property: checkProperty,
      TemplateLiteral: checkSql,
      Literal: checkSql,
    };
  },
};
