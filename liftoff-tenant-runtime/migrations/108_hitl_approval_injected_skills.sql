ALTER TABLE hitl_approval_requests
  ADD COLUMN injected_skill_ids TEXT[] NOT NULL DEFAULT '{}';
