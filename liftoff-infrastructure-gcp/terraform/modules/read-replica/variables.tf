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

variable "master_instance_name" {
  type        = string
  description = "Name of the control-plane-pg-{env} primary instance (the master to replicate)."
}

variable "network_id" {
  type        = string
  description = "VPC network ID for private IP."
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-4096"
}

variable "kms_key_name" {
  type        = string
  default     = ""
  description = "CMEK for the replica disk. Defaults to match the master."
}
