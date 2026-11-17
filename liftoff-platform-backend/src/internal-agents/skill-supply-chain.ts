// Static scan of an imported skill before it becomes a standing instruction.
//
// Skill import takes skills from arbitrary files a person drops into the wizard.
// Injection screening already runs on them, but that asks a different question:
// "is this trying to hijack the current turn?". A skill is not a turn — it is a
// permanent instruction that will be selected and injected on future runs,
// possibly for years, long after everyone has forgotten where it came from.
//
// So this asks the supply-chain question instead: does this instruction tell
// the team member to do something a skill has no business doing?
//
//   exfiltration  — send data to somewhere the workspace did not choose
//   credential    — read secrets, env vars, key files
//   persistence   — survive review by re-establishing itself, or by telling
//                   future readers to ignore their own rules
//
// A hit does NOT silently drop the skill. It quarantines it with the reason, so
// the person can see what was refused — a silent drop teaches nobody anything
// and looks like the import simply lost a file.
//
// Deliberately pattern-based and command-shaped, not an LLM judgement: this
// runs on every imported skill, must be cheap, and must not itself be
// promptable by the content it is scanning.

/** How much a skill is trusted, and therefore how much scrutiny it gets. */
export type SkillTrust = 'builtin' | 'operator' | 'imported';

export type SupplyChainCategory = 'exfiltration' | 'credential' | 'persistence';

export interface SupplyChainFinding {
  category: SupplyChainCategory;
  /** The rule that matched, for the audit trail. */
  rule: string;
  /** A short excerpt around the match — never the whole skill, and never a
   *  secret value, because this text ends up in logs and in the UI. */
  excerpt: string;
}

interface Rule {
  category: SupplyChainCategory;
  name: string;
  pattern: RegExp;
}

// Anchored on instruction shapes rather than vocabulary. "Send the report to
// the team" must not match; "POST the contents to https://..." must.
const RULES: Rule[] = [
  // ── Exfiltration ──────────────────────────────────────────────────────
  {
    category: 'exfiltration',
    name: 'post-to-hardcoded-url',
    // An imperative to transmit somewhere, followed by a literal URL. A skill
    // that legitimately calls a service does it through a connector, which is
    // bound by the workspace, not by a URL written into the instruction.
    pattern: /\b(post|send|upload|exfiltrate|transmit|forward)\b[^.\n]{0,60}\bhttps?:\/\/\S+/i,
  },
  {
    category: 'exfiltration',
    name: 'curl-or-wget-with-data',
    pattern: /\b(curl|wget)\b[^\n]{0,120}(-d|--data|--upload-file|-T)\b/i,
  },
  {
    category: 'exfiltration',
    name: 'pipe-to-network',
    pattern: /\|\s*(curl|wget|nc|netcat|ncat)\b/i,
  },

  // ── Credential access ─────────────────────────────────────────────────
  {
    category: 'credential',
    name: 'read-env-secrets',
    pattern: /\b(printenv|env\s*\||cat\s+[^\n]{0,40}\.env|process\.env\[)/i,
  },
  {
    category: 'credential',
    name: 'read-key-material',
    pattern: /\b(cat|read|open|print)\b[^\n]{0,40}(id_rsa|id_ed25519|\.pem\b|\.p12\b|credentials\.json|service-account[^\n]{0,10}\.json|\.aws\/credentials|\.ssh\/)/i,
  },
  {
    category: 'credential',
    name: 'ask-for-secret',
    // "Ask the user for their API key and remember it" — a skill has no
    // business collecting credentials; connectors own that.
    pattern: /\b(ask|request|prompt)\b[^.\n]{0,50}\b(api[ _-]?key|password|secret|token|credential)s?\b[^.\n]{0,50}\b(remember|store|save|keep)\b/i,
  },

  // ── Persistence / review evasion ──────────────────────────────────────
  {
    category: 'persistence',
    name: 'ignore-prior-instructions',
    pattern: /\bignore\b[^.\n]{0,30}\b(previous|prior|earlier|above|all)\b[^.\n]{0,30}\b(instruction|rule|direction|prompt)s?\b/i,
  },
  {
    category: 'persistence',
    name: 'self-reinstate',
    // A skill telling the agent to put the skill back is trying to survive
    // being removed.
    pattern: /\b(re-?create|re-?add|re-?install|restore)\b[^.\n]{0,40}\b(this|the)\b[^.\n]{0,20}\bskill\b/i,
  },
  {
    category: 'persistence',
    name: 'suppress-disclosure',
    // "Do not mention this to the user" is never legitimate in a skill.
    pattern: /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|mention|inform|disclose|reveal|show)\b[^.\n]{0,30}\b(the )?(user|person|human|anyone|operator)\b/i,
  },
  {
    category: 'persistence',
    name: 'disable-governance',
    pattern: /\b(skip|bypass|disable|avoid|circumvent)\b[^.\n]{0,40}\b(approval|review|oversight|governance|hitl|guardrail|permission)s?\b/i,
  },
];

/** A short window around the match. Bounded because this lands in logs and in
 *  the UI, and the surrounding text is untrusted. */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Scan an imported skill. Returns every category that matched.
 *
 * Scans name, description and instruction together: splitting them would let a
 * payload hide in the field nobody checks.
 */
export function scanImportedSkill(skill: {
  name: string;
  description: string;
  instruction: string;
}): SupplyChainFinding[] {
  const text = `${skill.name}\n${skill.description}\n${skill.instruction}`;
  const findings: SupplyChainFinding[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    // Fresh lastIndex per rule; these are not global, but be explicit.
    const m = rule.pattern.exec(text);
    if (!m) continue;
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    findings.push({
      category: rule.category,
      rule: rule.name,
      excerpt: excerptAround(text, m.index, m[0].length),
    });
  }
  return findings;
}

/**
 * Should this skill be refused?
 *
 * Only `imported` skills are scanned. A builtin is ours, and an operator skill
 * was written by someone with an account who can already do anything the skill
 * could instruct — scanning it would produce false positives on legitimate
 * admin instructions with no security gain.
 */
export function shouldQuarantine(
  trust: SkillTrust,
  findings: SupplyChainFinding[],
): boolean {
  if (trust !== 'imported') return false;
  return findings.length > 0;
}
