variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type    = string
  default = "us-west1"
}

variable "kms_key_ring_id" {
  type        = string
  description = "keyring-{env} full resource ID. A dedicated key `audit-anchor-key` is created inside it (plan 0y: the anchor bucket KMS key is distinct)."
}

variable "anchor_service_accounts" {
  type        = map(string)
  default     = {}
  description = "Map of service => SA email for services that append daily hash anchors. Keys: billing, workforce, governance, developer-proxy. Each SA gets roles/storage.objectCreator scoped to its prefix."
}

variable "operator_readers" {
  type        = list(string)
  default     = []
  description = "IAM members (group:ops@…) granted read-only access to the anchor bucket. Plan 0y."
}

variable "enable_scheduler" {
  type        = bool
  default     = true
  description = "Whether to provision per-service daily Cloud Scheduler jobs that publish the <service>/<yyyy-mm-dd>.hash manifest."
}

variable "scheduler_sa_email" {
  type        = string
  default     = ""
  description = "Service account used by Cloud Scheduler to invoke per-service anchor Cloud Run Jobs. Required when enable_scheduler=true."
}

variable "anchor_job_urls" {
  type        = map(string)
  default     = {}
  description = "Map of service => Cloud Run Job resource URI (apis/run.googleapis.com/v1/...:run) that computes and uploads the daily anchor. Optional until the jobs exist."
}

variable "gcs_sa_email" {
  type        = string
  description = "GCS service agent email (YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com). Must have cryptoKeyEncrypterDecrypter on the audit-anchor KMS key so default bucket encryption works."
}
