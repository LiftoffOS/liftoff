-- Step 1: backfill ou_consumed everywhere (definition rate is global, ordering-free).
UPDATE billing_spend_events
   SET ou_consumed = GREATEST(0, cost_usd) / 0.01
 WHERE ou_consumed = 0 AND cost_usd <> 0;

UPDATE cost_attribution_events
   SET ou_consumed = GREATEST(0, cost_usd) / 0.01
 WHERE ou_consumed = 0 AND cost_usd <> 0;

-- Step 2: customer_cost_usd + cost_bucket replay for billing_spend_events.
--
-- Walks the FULL historical event stream per tenant in time order — NOT just
-- the current period — so /insights for any historical range renders bucketed
-- numbers (plan §"Migration A.5 — backfill historical rows" — "/insights for
-- that historical period renders agent rows with non-zero ous and amount").
--
-- Bucket assignment uses the CURRENT rates+allotments on billing_controls
-- because we don't preserve historical rate snapshots. For any tenant whose
-- historical OU consumption was well below the current allotment ceiling
-- 100% of
-- history lands in the `included` bucket — which matches the customer's
-- contractual experience.
--
-- After the per-event replay, we sync billing_controls.ous_consumed_this_period
-- to the *current period only* (events with occurred_at >= billing_period_start)
-- because that counter represents in-period consumption, not lifetime.
DO $$
DECLARE
  rec RECORD;
  ev RECORD;
  pre_consumed NUMERIC(18,3);
  current_period_consumed NUMERIC(18,3);
  included_end NUMERIC(18,3);
  precommit_end NUMERIC(18,3);
  included_portion NUMERIC(18,3);
  precommit_portion NUMERIC(18,3);
  reload_portion NUMERIC(18,3);
  inc_rate NUMERIC(10,6);
  pre_rate NUMERIC(10,6);
  rel_rate NUMERIC(10,6);
BEGIN
  FOR rec IN
    SELECT bc.account_id, bc.billing_period_start,
           bc.plan_included_ous, bc.precommit_extra_ous,
           bc.included_rate_usd_per_ou, bc.precommit_rate_usd_per_ou, bc.reload_rate_usd_per_ou
      FROM billing_controls bc
  LOOP
    pre_consumed            := 0;
    current_period_consumed := 0;
    included_end  := rec.plan_included_ous;
    precommit_end := rec.plan_included_ous + rec.precommit_extra_ous;
    inc_rate := rec.included_rate_usd_per_ou;
    pre_rate := rec.precommit_rate_usd_per_ou;
    rel_rate := rec.reload_rate_usd_per_ou;

    -- Process ALL events for this tenant ever, in time order.
    -- billing_spend_events uses invocation_id as PK (no separate `id` column).
    FOR ev IN
      SELECT invocation_id, ou_consumed, occurred_at
        FROM billing_spend_events
       WHERE account_id  = rec.account_id
         AND ou_consumed > 0
       ORDER BY occurred_at, invocation_id
       FOR UPDATE
    LOOP
      included_portion  := GREATEST(0, LEAST(pre_consumed + ev.ou_consumed, included_end)  - pre_consumed);
      precommit_portion := GREATEST(0, LEAST(pre_consumed + ev.ou_consumed, precommit_end) - GREATEST(pre_consumed, included_end));
      reload_portion    := GREATEST(0, pre_consumed + ev.ou_consumed                        - GREATEST(pre_consumed, precommit_end));

      -- Single-bucket: UPDATE customer_cost_usd + cost_bucket only.
      -- Multi-bucket: UPDATE original to the first non-zero portion, INSERT
      -- siblings for the rest. Sibling rows carry the same invocation_id with
      -- a /<bucket> suffix; idempotency holds via the PRIMARY KEY on invocation_id.
      IF included_portion > 0 AND precommit_portion = 0 AND reload_portion = 0 THEN
        UPDATE billing_spend_events
           SET customer_cost_usd = included_portion * inc_rate,
               cost_bucket       = 'included'
         WHERE invocation_id = ev.invocation_id;
      ELSIF precommit_portion > 0 AND included_portion = 0 AND reload_portion = 0 THEN
        UPDATE billing_spend_events
           SET customer_cost_usd = precommit_portion * pre_rate,
               cost_bucket       = 'precommit'
         WHERE invocation_id = ev.invocation_id;
      ELSIF reload_portion > 0 AND included_portion = 0 AND precommit_portion = 0 THEN
        UPDATE billing_spend_events
           SET customer_cost_usd = reload_portion * rel_rate,
               cost_bucket       = 'reload'
         WHERE invocation_id = ev.invocation_id;
      ELSE
        IF included_portion > 0 THEN
          UPDATE billing_spend_events
             SET ou_consumed       = included_portion,
                 customer_cost_usd = included_portion * inc_rate,
                 cost_bucket       = 'included'
           WHERE invocation_id = ev.invocation_id;
          IF precommit_portion > 0 THEN
            INSERT INTO billing_spend_events (invocation_id, tenant_id, account_id, cost_usd, ou_spend_usd, ou_consumed,
                                              customer_cost_usd, cost_bucket, agent_id, occurred_at)
            SELECT invocation_id || '/precommit', tenant_id, account_id, 0, 0, precommit_portion,
                   precommit_portion * pre_rate, 'precommit', agent_id, occurred_at
              FROM billing_spend_events WHERE invocation_id = ev.invocation_id;
          END IF;
          IF reload_portion > 0 THEN
            INSERT INTO billing_spend_events (invocation_id, tenant_id, account_id, cost_usd, ou_spend_usd, ou_consumed,
                                              customer_cost_usd, cost_bucket, agent_id, occurred_at)
            SELECT invocation_id || '/reload', tenant_id, account_id, 0, 0, reload_portion,
                   reload_portion * rel_rate, 'reload', agent_id, occurred_at
              FROM billing_spend_events WHERE invocation_id = ev.invocation_id;
          END IF;
        ELSIF precommit_portion > 0 THEN
          UPDATE billing_spend_events
             SET ou_consumed       = precommit_portion,
                 customer_cost_usd = precommit_portion * pre_rate,
                 cost_bucket       = 'precommit'
           WHERE invocation_id = ev.invocation_id;
          IF reload_portion > 0 THEN
            INSERT INTO billing_spend_events (invocation_id, tenant_id, account_id, cost_usd, ou_spend_usd, ou_consumed,
                                              customer_cost_usd, cost_bucket, agent_id, occurred_at)
            SELECT invocation_id || '/reload', tenant_id, account_id, 0, 0, reload_portion,
                   reload_portion * rel_rate, 'reload', agent_id, occurred_at
              FROM billing_spend_events WHERE invocation_id = ev.invocation_id;
          END IF;
        END IF;
      END IF;

      pre_consumed := pre_consumed + ev.ou_consumed;
      IF rec.billing_period_start IS NOT NULL AND ev.occurred_at >= rec.billing_period_start THEN
        current_period_consumed := current_period_consumed + ev.ou_consumed;
      END IF;
    END LOOP;

    -- Sync billing_controls.ous_consumed_this_period to the in-period total.
    -- Pre-period events were bucketed for /insights purposes but don't count
    -- against the current period's allotment.
    UPDATE billing_controls SET ous_consumed_this_period = current_period_consumed
     WHERE account_id = rec.account_id;
  END LOOP;
END $$;

-- Step 3: mirror the same replay into cost_attribution_events. Walks full
-- tenant history, same bucket-assignment logic, sibling-row INSERTs for
-- multi-bucket spans.
DO $$
DECLARE
  rec RECORD;
  ev RECORD;
  pre_consumed NUMERIC(18,3);
  included_end NUMERIC(18,3);
  precommit_end NUMERIC(18,3);
  included_portion NUMERIC(18,3);
  precommit_portion NUMERIC(18,3);
  reload_portion NUMERIC(18,3);
  inc_rate NUMERIC(10,6);
  pre_rate NUMERIC(10,6);
  rel_rate NUMERIC(10,6);
BEGIN
  FOR rec IN
    SELECT bc.account_id, bc.billing_period_start,
           bc.plan_included_ous, bc.precommit_extra_ous,
           bc.included_rate_usd_per_ou, bc.precommit_rate_usd_per_ou, bc.reload_rate_usd_per_ou,
           -- cost_attribution_events.tenant_id is TEXT (migration 133), but
           -- tenants.id is UUID — cast here so the WHERE below compares
           -- the same type (Postgres doesn't implicitly coerce uuid=text).
           t.id::text AS tenant_id
      FROM billing_controls bc
      JOIN tenants t ON t.account_id = bc.account_id
  LOOP
    pre_consumed  := 0;
    included_end  := rec.plan_included_ous;
    precommit_end := rec.plan_included_ous + rec.precommit_extra_ous;
    inc_rate := rec.included_rate_usd_per_ou;
    pre_rate := rec.precommit_rate_usd_per_ou;
    rel_rate := rec.reload_rate_usd_per_ou;

    FOR ev IN
      SELECT id, ou_consumed
        FROM cost_attribution_events
       WHERE tenant_id   = rec.tenant_id
         AND ou_consumed > 0
       ORDER BY occurred_at, id
       FOR UPDATE
    LOOP
      included_portion  := GREATEST(0, LEAST(pre_consumed + ev.ou_consumed, included_end)  - pre_consumed);
      precommit_portion := GREATEST(0, LEAST(pre_consumed + ev.ou_consumed, precommit_end) - GREATEST(pre_consumed, included_end));
      reload_portion    := GREATEST(0, pre_consumed + ev.ou_consumed                        - GREATEST(pre_consumed, precommit_end));

      IF included_portion > 0 AND precommit_portion = 0 AND reload_portion = 0 THEN
        UPDATE cost_attribution_events
           SET customer_cost_usd = included_portion * inc_rate,
               cost_bucket       = 'included'
         WHERE id = ev.id;
      ELSIF precommit_portion > 0 AND included_portion = 0 AND reload_portion = 0 THEN
        UPDATE cost_attribution_events
           SET customer_cost_usd = precommit_portion * pre_rate,
               cost_bucket       = 'precommit'
         WHERE id = ev.id;
      ELSIF reload_portion > 0 AND included_portion = 0 AND precommit_portion = 0 THEN
        UPDATE cost_attribution_events
           SET customer_cost_usd = reload_portion * rel_rate,
               cost_bucket       = 'reload'
         WHERE id = ev.id;
      ELSE
        -- Multi-bucket span: UPDATE original to first non-zero bucket; INSERT siblings
        -- for the remaining bucket(s). Sibling rows use source_id || '/<bucket>' so the
        -- existing partial UNIQUE (source, source_id, event_type, occurred_at)
        -- WHERE source_id IS NOT NULL idempotency index continues to enforce de-dup.
        IF included_portion > 0 THEN
          UPDATE cost_attribution_events
             SET ou_consumed       = included_portion,
                 customer_cost_usd = included_portion * inc_rate,
                 cost_bucket       = 'included'
           WHERE id = ev.id;
          IF precommit_portion > 0 THEN
            INSERT INTO cost_attribution_events
              (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
               parent_invocation_id, connector, entity_type, action_type, purpose,
               event_type, source, source_id, provider, model,
               input_tokens, output_tokens, cached_tokens, cost_usd,
               hosting_mode, correlation_confidence, occurred_at,
               ou_consumed, customer_cost_usd, cost_bucket)
            SELECT tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
                   parent_invocation_id, connector, entity_type, action_type, purpose,
                   event_type, source, source_id || '/precommit', provider, model,
                   input_tokens, output_tokens, cached_tokens, 0,
                   hosting_mode, correlation_confidence, occurred_at,
                   precommit_portion, precommit_portion * pre_rate, 'precommit'
              FROM cost_attribution_events WHERE id = ev.id
            ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL DO NOTHING;
          END IF;
          IF reload_portion > 0 THEN
            INSERT INTO cost_attribution_events
              (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
               parent_invocation_id, connector, entity_type, action_type, purpose,
               event_type, source, source_id, provider, model,
               input_tokens, output_tokens, cached_tokens, cost_usd,
               hosting_mode, correlation_confidence, occurred_at,
               ou_consumed, customer_cost_usd, cost_bucket)
            SELECT tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
                   parent_invocation_id, connector, entity_type, action_type, purpose,
                   event_type, source, source_id || '/reload', provider, model,
                   input_tokens, output_tokens, cached_tokens, 0,
                   hosting_mode, correlation_confidence, occurred_at,
                   reload_portion, reload_portion * rel_rate, 'reload'
              FROM cost_attribution_events WHERE id = ev.id
            ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL DO NOTHING;
          END IF;
        ELSIF precommit_portion > 0 THEN
          UPDATE cost_attribution_events
             SET ou_consumed       = precommit_portion,
                 customer_cost_usd = precommit_portion * pre_rate,
                 cost_bucket       = 'precommit'
           WHERE id = ev.id;
          IF reload_portion > 0 THEN
            INSERT INTO cost_attribution_events
              (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
               parent_invocation_id, connector, entity_type, action_type, purpose,
               event_type, source, source_id, provider, model,
               input_tokens, output_tokens, cached_tokens, cost_usd,
               hosting_mode, correlation_confidence, occurred_at,
               ou_consumed, customer_cost_usd, cost_bucket)
            SELECT tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
                   parent_invocation_id, connector, entity_type, action_type, purpose,
                   event_type, source, source_id || '/reload', provider, model,
                   input_tokens, output_tokens, cached_tokens, 0,
                   hosting_mode, correlation_confidence, occurred_at,
                   reload_portion, reload_portion * rel_rate, 'reload'
              FROM cost_attribution_events WHERE id = ev.id
            ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL DO NOTHING;
          END IF;
        END IF;
      END IF;

      pre_consumed := pre_consumed + ev.ou_consumed;
    END LOOP;
  END LOOP;
END $$;
