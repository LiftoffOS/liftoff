-- Migration 353: the observations already written down become readable again.
--
-- An observation block declares its sentence in `content`, and `content` is the
-- only field the renderer reads. The insights chat prompt exemplified metric_card
-- and bar_chart and nothing else, so for this block the field name was left to
-- the model, and the model wrote `text` every single time: every observation
-- block persisted on either chat surface stores its
-- sentence under a key nothing reads. The reader got the "Key Observations"
-- heading with nothing under it.
--
-- The parser now normalises the two prose blocks onto `content` as they are
-- admitted, so nothing written from here on can land this way. That fixes new
-- replies only. These rows are transcripts: people link to them, reopen them and
-- read them months later, and the sentence is sitting right there in the column
-- under the wrong name. Moving it is not rewriting what the assistant said, it
-- is putting the same sentence where the contract always said it would be.
--
-- Written to be re-runnable and to touch nothing else: a block that already has
-- `content` is left exactly as it is, key order inside a jsonb value is not
-- meaningful, and rows whose blocks are unchanged are not updated at all.

-- Insights chat: the surface that produced every one of these.
UPDATE insights_chat_messages m
SET visualization_blocks = rebuilt.blocks
FROM (
  SELECT
    m2.id,
    jsonb_agg(
      CASE
        WHEN b->>'type' = 'observation'
         AND NOT (b ? 'content')
         AND jsonb_typeof(b->'text') = 'string'
        THEN (b - 'text') || jsonb_build_object('content', b->'text')
        ELSE b
      END
      ORDER BY ord
    ) AS blocks
  FROM insights_chat_messages m2,
       LATERAL jsonb_array_elements(m2.visualization_blocks) WITH ORDINALITY AS e(b, ord)
  WHERE jsonb_typeof(m2.visualization_blocks) = 'array'
  GROUP BY m2.id
) rebuilt
WHERE m.id = rebuilt.id
  AND m.visualization_blocks IS DISTINCT FROM rebuilt.blocks;

-- Liftoff chat: the same blocks again, copied here whole when Liftoff handed a
-- turn to the Insights Manager. This is the surface the report came from.
UPDATE liftoff_chat_messages m
SET visualization_blocks = rebuilt.blocks
FROM (
  SELECT
    m2.id,
    jsonb_agg(
      CASE
        WHEN b->>'type' = 'observation'
         AND NOT (b ? 'content')
         AND jsonb_typeof(b->'text') = 'string'
        THEN (b - 'text') || jsonb_build_object('content', b->'text')
        ELSE b
      END
      ORDER BY ord
    ) AS blocks
  FROM liftoff_chat_messages m2,
       LATERAL jsonb_array_elements(m2.visualization_blocks) WITH ORDINALITY AS e(b, ord)
  WHERE jsonb_typeof(m2.visualization_blocks) = 'array'
  GROUP BY m2.id
) rebuilt
WHERE m.id = rebuilt.id
  AND m.visualization_blocks IS DISTINCT FROM rebuilt.blocks;
