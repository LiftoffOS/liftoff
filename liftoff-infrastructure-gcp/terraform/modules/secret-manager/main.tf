# Secret Manager Module
# Per Section 12: Credentials for connectors

variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "labels" {
  type    = map(string)
  default = {}
}

# Service accounts that can access secrets
variable "secret_accessors" {
  type        = list(string)
  description = "Service account emails that can access secrets"
  default     = []
}

# Platform admin service account that can manage secrets
variable "secret_admin" {
  type        = string
  description = "Service account email that can manage secrets"
  default     = ""
}

# -----------------------------------------------------------------------------
# Platform Secret Templates
# Per Section 12: Standard secret structure
# -----------------------------------------------------------------------------

locals {
  common_labels = merge(var.labels, {
    environment = var.environment
    managed_by  = "terraform"
  })

  # Platform secret templates - these define the secrets that should exist
  platform_secrets = {
    # Database credentials
    "database-credentials" = {
      description = "PostgreSQL database connection credentials"
      labels = {
        type     = "database"
        rotation = "manual"
      }
    }

    # JWT signing key for auth tokens
    "jwt-signing-key" = {
      description = "JWT signing key for authentication tokens"
      labels = {
        type     = "crypto"
        rotation = "annual"
      }
    }

    # Encryption key for sensitive data at rest
    "encryption-key" = {
      description = "AES-256 key for encrypting sensitive data"
      labels = {
        type     = "crypto"
        rotation = "annual"
      }
    }

    # API key for internal service-to-service auth
    "internal-api-key" = {
      description = "API key for internal service authentication"
      labels = {
        type     = "api-key"
        rotation = "quarterly"
      }
    }

    # Pub/Sub credentials (if not using default SA)
    "pubsub-credentials" = {
      description = "Pub/Sub service account credentials"
      labels = {
        type     = "service-account"
        rotation = "annual"
      }
    }

    # Anthropic/Claude API key
    "anthropic-api-key" = {
      description = "Anthropic Claude API key"
      labels = {
        type     = "vendor-api"
        rotation = "manual"
      }
    }

    # OpenAI API key
    "openai-api-key" = {
      description = "OpenAI API key"
      labels = {
        type     = "vendor-api"
        rotation = "manual"
      }
    }

    # Google Gemini API key (Interactions API / Deep Research). Distinct from
    # google-oauth-client-* which are Workspace OAuth credentials in the
    # connector_secrets map below.
    "google-api-key" = {
      description = "Google Gemini API key (Interactions API / Deep Research)"
      labels = {
        type     = "vendor-api"
        rotation = "manual"
      }
    }
  }

  # Connector OAuth template secrets
  # Pattern: {provider}-oauth-client-id and {provider}-oauth-client-secret
  connector_secrets = {
    # Google Workspace OAuth
    "google-oauth-client-id" = {
      description = "Google Workspace OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "google"
        rotation  = "annual"
      }
    }
    "google-oauth-client-secret" = {
      description = "Google Workspace OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "google"
        rotation  = "annual"
      }
    }

    # Slack OAuth
    "slack-oauth-client-id" = {
      description = "Slack OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "slack"
        rotation  = "annual"
      }
    }
    "slack-oauth-client-secret" = {
      description = "Slack OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "slack"
        rotation  = "annual"
      }
    }

    # GitHub OAuth
    "github-oauth-client-id" = {
      description = "GitHub OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "github"
        rotation  = "annual"
      }
    }
    "github-oauth-client-secret" = {
      description = "GitHub OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "github"
        rotation  = "annual"
      }
    }

    # Microsoft OAuth (OneDrive, SharePoint, Outlook, Teams, etc.)
    "microsoft-oauth-client-id" = {
      description = "Microsoft OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "microsoft"
        rotation  = "annual"
      }
    }
    "microsoft-oauth-client-secret" = {
      description = "Microsoft OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "microsoft"
        rotation  = "annual"
      }
    }

    # Dropbox OAuth
    "dropbox-oauth-client-id" = {
      description = "Dropbox OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "dropbox"
        rotation  = "annual"
      }
    }
    "dropbox-oauth-client-secret" = {
      description = "Dropbox OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "dropbox"
        rotation  = "annual"
      }
    }

    # Box OAuth
    "box-oauth-client-id" = {
      description = "Box OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "box"
        rotation  = "annual"
      }
    }
    "box-oauth-client-secret" = {
      description = "Box OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "box"
        rotation  = "annual"
      }
    }

    # Salesforce OAuth
    "salesforce-oauth-client-id" = {
      description = "Salesforce OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "salesforce"
        rotation  = "annual"
      }
    }
    "salesforce-oauth-client-secret" = {
      description = "Salesforce OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "salesforce"
        rotation  = "annual"
      }
    }

    # HubSpot OAuth
    "hubspot-oauth-client-id" = {
      description = "HubSpot OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "hubspot"
        rotation  = "annual"
      }
    }
    "hubspot-oauth-client-secret" = {
      description = "HubSpot OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "hubspot"
        rotation  = "annual"
      }
    }

    # Jira OAuth
    "jira-oauth-client-id" = {
      description = "Jira/Atlassian OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "jira"
        rotation  = "annual"
      }
    }
    "jira-oauth-client-secret" = {
      description = "Jira/Atlassian OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "jira"
        rotation  = "annual"
      }
    }

    # Zoom OAuth
    "zoom-oauth-client-id" = {
      description = "Zoom OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "zoom"
        rotation  = "annual"
      }
    }
    "zoom-oauth-client-secret" = {
      description = "Zoom OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "zoom"
        rotation  = "annual"
      }
    }

    # Confluence OAuth
    "confluence-oauth-client-id" = {
      description = "Confluence/Atlassian OAuth client ID"
      labels = {
        type      = "oauth"
        connector = "confluence"
        rotation  = "annual"
      }
    }
    "confluence-oauth-client-secret" = {
      description = "Confluence/Atlassian OAuth client secret"
      labels = {
        type      = "oauth"
        connector = "confluence"
        rotation  = "annual"
      }
    }

    # Atlassian OAuth (shared credentials for Jira/Confluence)
    # Used when a single OAuth app handles multiple Atlassian products
    "atlassian-oauth-client-id" = {
      description = "Atlassian OAuth client ID (shared for Jira/Confluence)"
      labels = {
        type      = "oauth"
        connector = "atlassian"
        rotation  = "annual"
      }
    }
    "atlassian-oauth-client-secret" = {
      description = "Atlassian OAuth client secret (shared for Jira/Confluence)"
      labels = {
        type      = "oauth"
        connector = "atlassian"
        rotation  = "annual"
      }
    }
  }

  all_secrets = merge(local.platform_secrets, local.connector_secrets)
}

# -----------------------------------------------------------------------------
# Secret Resources
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "secrets" {
  for_each = local.all_secrets

  project   = var.project_id
  secret_id = "${each.key}-${var.environment}"

  labels = merge(local.common_labels, each.value.labels)

  replication {
    auto {}
  }
}

# -----------------------------------------------------------------------------
# IAM - Secret Accessor Role
# Allows specified service accounts to read secrets
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = {
    for pair in setproduct(keys(local.all_secrets), var.secret_accessors) :
    "${pair[0]}-${pair[1]}" => {
      key    = pair[0]
      member = "serviceAccount:${pair[1]}"
    }
  }

  project = var.project_id
  # Reference the secret resource (not a raw "${key}-${var.environment}" string)
  # so Terraform orders this binding AFTER the secret exists. The raw-string form
  # built no dependency edge, so a first-time apply that creates the secret and
  # this binding in one run could schedule the IAM read before the secret and
  # fail with "retrieving IAM policy ... 404 Secret not found". Resolves to the
  # identical secret_id, so no
  # diff in existing envs — it only adds the ordering edge. Mirrors `admin` below.
  secret_id = google_secret_manager_secret.secrets[each.value.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

# -----------------------------------------------------------------------------
# IAM - Secret Admin Role
# Allows admin service account to manage secrets
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "admin" {
  for_each = var.secret_admin != "" ? local.all_secrets : {}

  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.admin"
  member    = "serviceAccount:${var.secret_admin}"
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "project_id" {
  value = var.project_id
}

output "secret_ids" {
  description = "Map of secret keys to their full secret IDs"
  value = {
    for k, v in google_secret_manager_secret.secrets : k => v.secret_id
  }
}

output "secret_names" {
  description = "Map of secret keys to their full resource names"
  value = {
    for k, v in google_secret_manager_secret.secrets : k => v.name
  }
}

output "platform_secrets" {
  description = "List of platform secret IDs"
  value       = [for k, v in local.platform_secrets : google_secret_manager_secret.secrets[k].secret_id]
}

output "connector_secrets" {
  description = "List of connector secret IDs"
  value       = [for k, v in local.connector_secrets : google_secret_manager_secret.secrets[k].secret_id]
}
