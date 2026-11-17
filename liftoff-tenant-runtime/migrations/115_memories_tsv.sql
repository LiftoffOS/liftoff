ALTER TABLE memories ADD COLUMN content_tsv TSVECTOR;

CREATE OR REPLACE FUNCTION memories_tsv_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content_classification NOT IN ('pii', 'sensitive') THEN
    NEW.content_tsv = to_tsvector('simple', COALESCE(NEW.content, ''));
  ELSE
    NEW.content_tsv = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_tsv_trigger
  BEFORE INSERT OR UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_tsv_update();

CREATE INDEX idx_memories_tsv ON memories USING GIN (content_tsv);
