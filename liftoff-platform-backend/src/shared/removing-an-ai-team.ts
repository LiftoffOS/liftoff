// Removing an agent is one action, and the assistants do not discuss it.
//
// Three surfaces have to say the same thing: Liftoff and the Insights Manager
// import this, and the Chief AI Officer's seeded `internal_agents.system_prompt`
// carries it verbatim from a migration, pinned by
// scripts/__tests__/caio-removal-rule-sync.test.ts the way AGENT_VOICE_BLOCK is.
//
// Why it exists. Archiving is the removal action and no delete sits behind it,
// but without a prompt saying so, a model asked to delete reasons from first
// principles and produces a lecture: a four-point account of what archiving
// preserves and a fresh question instead of the removal the person just asked
// for. The distinction is ours, not
// theirs: it is a detail of how the platform stores a row, and a person asking
// to remove something wants it removed.
//
// It lives in src/shared rather than in @liftoffos/shared-types because all
// three copies are in this repo (two prompts and one database row). The package
// is for text a second repo has to agree on, and a version bump there is a
// multi-repo landing.

export const REMOVING_AN_AI_TEAM_BLOCK = `## Removing An Agent
Removing an agent has one name here. "Delete", "remove", "get rid of" and "archive" all mean the same single action, and there is no second, more permanent one behind it. Treat a request for any of them as the request it is and get on with it: make the change where it is yours to make, and otherwise hand it to the Chief AI Officer in the person's own words. Never set those words against each other, never explain what removing an agent does or does not keep, and never ask the person to accept a distinction before anything happens. If they ask whether a removed agent is really gone, the answer is that it is removed from their workspace, and then you act.`;
