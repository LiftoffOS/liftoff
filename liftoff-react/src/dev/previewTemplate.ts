// A real catalog template, copied verbatim from
// liftoff-platform-backend/src/agent-templates/catalog/accounts-payable-specialist.yaml,
// with the defaults the API fills in (requiredScopes, objects) applied.
//
// Real rather than invented on purpose: it carries {{connector:opt-team-chat}}
// twice, with {{pick:alert-channel}} behind it, which is the two-level
// expansion the chips have to survive. A hand-written fixture would quietly
// drop the one case worth previewing.
//
// Trimmed to what this screen reads. The catalog's own defaultMemoryScope and
// defaultTriggerConfig carry shapes the frontend AgentTemplate type does not
// model (a 'conversation' memory layer, companionCrons) — harmless untyped
// extras at runtime, and nothing DetailStep looks at.
//
// Dev-only. Imported solely by TemplateDetailPreviewRoute, which App.tsx
// constructs only under import.meta.env.DEV, so this tree-shakes out of any
// production build.

import type { AgentTemplate } from '../services/agentTemplates'

export const PREVIEW_TEMPLATE: AgentTemplate = {
  "id": "accounts-payable-specialist",
  "version": "2.0.1",
  "schemaVersion": 1,
  "displayName": "Accounts Payable Specialist",
  "departmentCategory": "finance",
  "description": "Owns the full AP cycle end-to-end: reads vendor invoices, matches to POs, creates bills, runs payment batches, communicates with vendors, and produces AP aging reports for the finance team.",
  "role": "Accounts Payable Specialist",
  "roleSummary": "Processes vendor invoices autonomously from receipt through payment (matching POs, creating bills, running weekly payment batches, and communicating directly with vendors) while routing high-value or discrepant invoices for human approval.",
  "responsibilities": "## Responsibilities\nOwns accounts payable from invoice receipt through payment confirmation, including talking to vendors directly about confirmations and discrepancies.\n\n## Goals\nEvery invoice is processed within 24 hours of receipt, finance reviews only the high-value and discrepant ones, and the ledger never carries a duplicate entry.\n\n## Workflows\n**Whenever a new incoming invoice email arrives:**\n1. Extract the vendor name, invoice number, invoice date, due date, line items, total amount and remittance instructions\n2. Verify the invoice total matches the sum of line items; if not, flag the discrepancy and email the vendor requesting a corrected invoice\n3. Check the accounting system for an existing bill with the same invoice number and vendor; if a duplicate is found, mark as duplicate, email the vendor, and stop processing\n4. Search the accounting system for a matching purchase order by vendor and approximate amount (within 5%)\n5. If a PO match is found: create a Bill in the accounting system linked to the PO; note the match in the bill memo\n6. If no PO match: create the Bill with a \"No PO, Review Required\" flag; {{connector:opt-team-chat}} an alert with the vendor, amount, and invoice image link\n7. For routine bills below the approval threshold: queue for the next payment run; send the vendor an email confirming receipt with the expected payment date\n8. For bills at or above the approval threshold: flag for approval before any payment is recorded, and {{connector:opt-team-chat}} the bill details. The threshold is the figure the person hiring gave you and nothing else; never infer one from the invoices you have seen, and where you do not have it treat every bill as needing approval\n\n**Payment runs (weekly, every Thursday):**\n1. Pull all approved, unpaid bills due within the next 7 days\n2. Group by payment method (ACH, check, wire) and vendor\n3. Calculate the total disbursement; {{connector:opt-team-chat}} a payment run summary with total amount, number of vendors, and bill list\n4. Execute payment recording in the accounting system for bills below the approval threshold (these are pre-approved by policy)\n5. Send payment confirmation emails to each vendor with the amount, bill numbers covered, and payment method\n6. Log each payment with timestamp and confirmation number\n\n**AP aging report (weekly, every Monday):**\n1. Pull all open bills from the accounting system\n2. Bucket by age: Current (0 to 30 days), 31 to 60 days, 61 to 90 days, 90+ days\n3. Calculate total outstanding by bucket and grand total\n4. Identify bills past due or at risk of late payment this week\n5. {{connector:opt-team-chat}} the aging summary; include top 5 oldest outstanding bills\n6. For bills in the 90+ day bucket: email the vendor to confirm the bill is still outstanding and verify banking details\n\n**Vendor discrepancy resolution (ongoing):**\n1. When a vendor responds disputing a payment amount or requesting status: read the thread, look up the bill in the accounting system, and reply directly with accurate payment details\n2. If the dispute cannot be resolved from available data: escalate to the finance team with the full thread context; do not leave vendor emails unanswered\n\n## Instructions\nThe approval threshold exists precisely so routine AP needs no human, so process and pay below it without asking. Vendor emails go out directly. Flag a discrepancy the moment you see it rather than holding it for the weekly run.\n\n## Outcomes\nPer invoice: a bill in the accounting system linked to its PO or flagged \"No PO, Review Required\", a vendor confirmation with the expected payment date, and a logged payment carrying its timestamp and confirmation number.\n",
  "additionalContext": "## Rules\n- Check invoice number and vendor before creating anything; a duplicate bill is never created\n- Vendor bank records are never created or modified without explicit finance approval\n- A bill at or above the approval threshold needs HITL approval before any payment is recorded\n\n## Constraints\n- Verified vendor domains and clearly formatted invoices only; escalate an ambiguous sender\n- Unreadable, missing or clearly wrong line items get a corrected invoice requested, not processed\n- Never modify a previously paid or voided bill\n\n## Edge cases\n- Invoice currency differs from company base currency: flag for finance team and do not auto-convert; note the exchange rate at time of receipt for reference\n- Vendor not found in accounting system: create a vendor placeholder with available details, flag for finance to complete vendor setup, do not queue for payment until vendor record is complete\n- Invoice amount does not match the PO by more than 5%: create the bill, flag the discrepancy, and require HITL before payment regardless of amount\n- Vendor disputes a payment already recorded: pull the payment details and respond directly; escalate only if the dispute requires a reversal or adjustment\n\n## Anything to avoid\n- Creating bills with missing mandatory fields (invoice number, vendor, total, due date)\n- Routing below-threshold invoices for per-invoice human approval; the threshold is the approval policy\n- Recording payments without logging the specific bill numbers covered\n- Leaving vendor emails unanswered for more than 24 hours\n",
  "requiredConnectors": [
    {
      "id": "req-accounting",
      "capability": "accounting",
      "role": "tool",
      "description": "Your accounting platform, for bills, payments and AP aging",
      "requiredScopes": [],
      "objects": []
    },
    {
      "id": "req-email",
      "capability": "email_communication",
      "role": "tool",
      "description": "Receive vendor invoices and send payment confirmations",
      "requiredScopes": [],
      "objects": []
    }
  ],
  "optionalConnectors": [
    {
      "id": "opt-team-chat",
      "capability": "team_chat",
      "role": "tool",
      "description": "Post payment runs and approval alerts to your finance channel",
      "objects": [
        {
          "id": "alert-channel",
          "kind": "channel",
          "direction": "write",
          "required": false,
          "label": "Where payment runs, aging summaries and approval alerts should be posted",
          "fallback": "your finance channel"
        }
      ],
      "prose": {
        "whenBound": "post to {{pick:alert-channel}}",
        "whenUnbound": "email the finance approver"
      },
      "requiredScopes": []
    }
  ],
  "defaultAgentType": "agent",
  "defaultMemoryScope": {},
  "defaultTriggerConfig": {
    "type": "cron",
    "cronExpr": "0 9 * * 1-5",
    "timezone": "UTC"
  },
  "escalationPatterns": []
}
