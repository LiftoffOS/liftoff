-- Migration 519: a supplier's own charge is resold at one premium.
--
-- Two kinds of cost reach a workspace's Operating Units, and until now they
-- priced identically. PLATFORM work is the platform's own -- model inference,
-- embeddings, the sandbox -- and keeps its markup: an OU is a cent of cost
-- (`ou_definition_rate_usd`) and the workspace pays its own rate per OU.
-- PASS-THROUGH work is a supplier's charge resold unchanged: a data capability
-- (`connector_call`) or a web tool (`web_tool`). Reselling those at the
-- platform's markup priced the same data several times above what it costs
-- elsewhere.
--
-- `pass_through_premium` governs that one class: the supplier's charge times
-- this is what the workspace pays, at any rate per OU. The OUs the event
-- consumes are derived from that price at the workspace's own rate, which is
-- what holds the premium equal for every workspace -- deriving them at a fixed
-- rate instead would sell below cost to whoever has the cheaper rate. A cheaper
-- rate per OU simply spends more OUs on the same supplier dollar, which is what
-- a cheaper rate per OU means.
--
-- 1.10 is a ten per cent premium. Deleting the row prices pass-through cost
-- exactly as it was priced before this migration; the reader treats an absent,
-- unreadable or non-positive value that way.
--
-- A keyless source charges nothing, so it consumes no OUs and is unaffected.
--
-- Not retrospective: events already written keep the price they were charged at.

INSERT INTO billing_system_settings (key, value)
VALUES ('pass_through_premium', 1.100000)
ON CONFLICT (key) DO NOTHING;
