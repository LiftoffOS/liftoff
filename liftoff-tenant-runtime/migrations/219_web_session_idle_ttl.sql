ALTER TABLE web_sessions
  ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '10 minutes';

UPDATE web_sessions
  SET expires_at = LEAST(expires_at, NOW() + INTERVAL '10 minutes')
  WHERE closed_at IS NULL;
