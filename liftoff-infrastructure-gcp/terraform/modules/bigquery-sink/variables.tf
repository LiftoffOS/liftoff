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

variable "kms_key_id" {
  type        = string
  default     = ""
  description = "Optional CMEK for BigQuery datasets."
}

variable "developer_proxy_usage_topic" {
  type        = string
  description = "Pub/Sub topic name carrying developer-proxy usage events."
}

variable "dataflow_service_account" {
  type        = string
  description = "Service account used by the Dataflow streaming job. Needs BQ data editor + Pub/Sub subscriber."
}

variable "enable_governance_audit_mirror" {
  type    = bool
  default = false
}

variable "governance_audit_topic" {
  type    = string
  default = ""
}

variable "enable_dataflow_job" {
  type        = bool
  default     = true
  description = "Provision the Dataflow flex-template streaming job developer-proxy-usage → BigQuery. Disable in dev to save cost."
}

variable "dataflow_template_gcs_path" {
  type        = string
  default     = "gs://dataflow-templates-us-west1/latest/flex/PubSub_Subscription_to_BigQuery"
  description = "GCS path of the Google-provided PubSub → BigQuery flex template. Pinned to us-west1 (regional scope)."
}

variable "enable_gcp_billing_export" {
  type        = bool
  default     = false
  description = "Create a BigQuery dataset for GCP billing export. After Terraform creates it, manually enable export in GCP Console: Billing → Billing export → Standard usage cost → select this dataset."
}

variable "platform_backend_service_account" {
  type        = string
  default     = ""
  description = "Email of the platform-backend service account. Granted bigquery.dataViewer on the billing export dataset when enable_gcp_billing_export=true."
}
