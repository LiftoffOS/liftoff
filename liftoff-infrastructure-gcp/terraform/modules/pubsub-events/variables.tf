variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "kms_key_id" {
  type        = string
  default     = ""
  description = "Optional CMEK for topic message storage."
}

variable "topics" {
  type = map(object({
    ordering      = bool
    retention     = string
    dlq_retention = string
  }))
  default = {
    billing-events = {
      ordering      = true
      retention     = "604800s"
      dlq_retention = "604800s"
    }
    workforce-events = {
      ordering      = true
      retention     = "604800s"
      dlq_retention = "604800s"
    }
    developer-proxy-usage = {
      ordering      = false
      retention     = "604800s"
      dlq_retention = "604800s"
    }
  }
  description = "Topics owned by this producer. Plan 0w: producers own topics."
}

variable "publisher_sa_emails" {
  type        = map(string)
  default     = {}
  description = "Map of topic-key => publisher SA email. Grants roles/pubsub.publisher on the topic."
}
