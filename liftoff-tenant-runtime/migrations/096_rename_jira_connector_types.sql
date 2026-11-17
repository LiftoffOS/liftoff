-- Migration 096: Rename bare 'jira'/'confluence' connector types to Atlassian-namespaced forms.
--
-- Atlassian Jira and Confluence share a single OAuth provider. The canonical
-- ConnectorType values are 'atlassian_jira' and 'atlassian_confluence' to make
-- this relationship explicit and avoid ambiguity with other ticket/wiki systems.
--
-- This migration renames any existing rows that used the old bare names.

-- connectors.type column (VARCHAR(50))
UPDATE connectors
  SET type = 'atlassian_jira',
      updated_at = NOW()
  WHERE type = 'jira';

UPDATE connectors
  SET type = 'atlassian_confluence',
      updated_at = NOW()
  WHERE type = 'confluence';

-- connector_manifests.connector_type column (TEXT)
UPDATE connector_manifests
  SET connector_type = 'atlassian_jira',
      updated_at = NOW()
  WHERE connector_type = 'jira';

UPDATE connector_manifests
  SET connector_type = 'atlassian_confluence',
      updated_at = NOW()
  WHERE connector_type = 'confluence';
