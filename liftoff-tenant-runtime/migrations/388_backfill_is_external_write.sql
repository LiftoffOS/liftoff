-- Give `is_external_write` a value, for the rows written before anything set it.
--
-- The column was added by migration 033 with DEFAULT false, for a caller
-- (`admission/service.ts getConnectorWritesInLastMinute()`) that no longer
-- exists. Nothing else sets it, so existing rows read false even for an agent
-- that created and updated Google Docs.
--
-- Two features read it and are inert without a real value. `acts-this-run` puts
-- what a run actually dispatched in front of the model so its REPLY cannot
-- misreport the work; on all-false rows it renders nothing. `prior-work` has
-- the same dependency.
--
-- Forward, the flag is derived in `ActionLedgerService.recordIntent` from the
-- same effect classifier the governance gate uses. That is authoritative and it
-- is where the value comes from from now on.
--
-- THIS BACKFILL IS AN APPROXIMATION AND ONLY THAT. It re-expresses the
-- classifier's mutating-verb list in SQL because a migration cannot call
-- TypeScript. It cannot split camelCase, so a `createIssue` written by some
-- older path stays false. It is a one-time pass over history to stop every
-- existing agent starting blind — not a second implementation to keep in step,
-- and nothing reads it after this runs.
--
-- Conservative in the safe direction: it only ever sets true, only where a
-- target was derived, and never touches sandbox rows, which `backstopLedger`
-- excludes from the ledger's idea of an outward act in the first place.
UPDATE actions
   SET is_external_write = true
 WHERE is_external_write IS NOT TRUE
   AND target_ref <> ''
   AND connector <> 'execution_environment'
   AND action_type ~* '(^|[^a-z])(create|update|delete|remove|add|set|write|send|merge|insert|upsert|patch|put|edit|modify|replace|move|rename|archive|restore|publish|unpublish|deploy|cancel|approve|reject|assign|unassign|invite|revoke|grant|enable|disable|submit|execute|trigger|import|export|upload|lock|unlock|subscribe|unsubscribe|transfer|convert|clear|reset|dismiss|refund|charge|pay|apply)([^a-z]|$)';
