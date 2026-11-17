-- On confirmation, the Chief AI Officer commits and approves. It does not
-- redraft.
--
-- The prompt describes the sequence as draft, then commit "to finalise the
-- draft", then approve. Read as an instruction to re-issue the draft when
-- finalising — and the draft tool's own description says every call must carry
-- the full spec set — a bare "yes" re-emitted the entire plan as tool
-- arguments.
--
-- That was survivable while the spec was a short paraphrase. It is not now that
-- a spec carries the whole brief across its prose sections: a redraft costs
-- thousands of output tokens, and on one turn it exceeded the per-turn ceiling,
-- truncated mid-tool-call, and ended having called nothing at all.
--
-- Neither commit nor approve takes any arguments, so a confirmation should be
-- one of the cheapest turns in the conversation. This makes that explicit
-- rather than leaving it to be inferred from a sequence description.

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

UPDATE internal_agents
SET system_prompt = replace(
      system_prompt,
      'Once the user confirms (e.g. "yes", "go ahead", "looks good"), call `workforce_plan__approve` to kick off provisioning.',
      'Once the user confirms (e.g. "yes", "go ahead", "looks good"), call `workforce_plan__commit` if you have not already, then `workforce_plan__approve`. Neither takes arguments. Do NOT call `workforce_plan__draft` again on a confirmation: the plan is already stored, and re-sending it wastes the turn. Only redraft when the user asks for a change to the plan itself.'
    ),
    updated_at = NOW()
WHERE system_role = 'caio'
  AND system_prompt LIKE '%call `workforce_plan__approve` to kick off provisioning.%';

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
