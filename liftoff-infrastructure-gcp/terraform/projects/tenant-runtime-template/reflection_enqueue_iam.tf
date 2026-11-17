// The actAs grant the reflection enqueue path has always needed and never had.
//
// agent-service creates a Cloud Task for every reflection job, and that task
// carries an OIDC token so the delivered request can authenticate to the
// target. `resolveTaskInvokerSa()` in the runtime builds that token for
//
//   tenant-${TENANT_ID}-runtime@tenant-${TENANT_ID}-${ENVIRONMENT}
//
// which is the SAME account agent-service itself runs as. Cloud Tasks validates
// the caller's `iam.serviceAccounts.actAs` on whatever account the token names,
// so the runtime SA needs `roles/iam.serviceAccountUser` ON ITSELF. Without it
// every enqueue fails:
//
//   PERMISSION_DENIED: The principal lacks IAM permission
//   "iam.serviceAccounts.actAs" for the resource
//   "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
//
// WHY THIS GAP CAN GO UNNOTICED. The enqueue only runs once
// `shouldTriggerReflection` answers "yes", and that depends on evidence
// counters (which read `invocations`). While the gate stays shut the enqueue
// below it is never called, so a missing permission here only surfaces on the
// first sweep where an agent qualifies — and then every qualifying agent fails.
//
// The neighbouring grants are for a DIFFERENT pair — `runtime_act_as_scheduler`
// and `tenant_runtime_sa_act_as_scheduler` in main.tf let callers act as the
// SCHEDULER SA for Cloud Scheduler HTTP targets. Cloud Tasks names the runtime
// SA, not the scheduler SA, so neither of those covers this and adding it here
// is not a duplicate. The precedent for the self-actAs shape is
// `sandbox_executor_actas_self` in sandbox_executor_iam.tf, which exists for
// the same reason on Cloud Run's actAs check.
//
// Scoped to the one service account rather than granted at project level: a
// project-level serviceAccountUser would let the runtime impersonate every SA
// in the project, which is a much larger grant than the enqueue needs.

resource "google_service_account_iam_member" "tenant_runtime_sa_actas_self" {
  service_account_id = "projects/${google_project.tenant_runtime.project_id}/serviceAccounts/${module.iam.tenant_runtime_sa}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.iam.tenant_runtime_sa}"
}
