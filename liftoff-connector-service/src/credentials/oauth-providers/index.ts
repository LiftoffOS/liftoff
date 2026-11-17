// Barrel for OAuth refresh providers.
//
// Importing this module at service startup triggers the
// `registerOAuthRefreshHandler` calls in every provider file. The
// service entry point (src/index.ts) imports this exactly once so
// every known connector type has a refresh handler before the first
// RPC call lands.
//
// Provider → connector type coverage:
//   google       → google, google_calendar, google_drive, google_mail,
//                  google_sheets, google_docs, google_slides,
//                  google_contacts, google_tasks, google_bigquery,
//                  google_firestore
//   slack        → slack
//   github       → github
//   gitlab       → gitlab
//   hubspot      → hubspot
//   salesforce   → salesforce
//   atlassian    → atlassian_jira, atlassian_confluence
//   zendesk      → zendesk
//   intercom     → intercom
//   square       → square
//   dcr          → notion, linear, calendly, asana, datadog, paypal
//   meta         → meta_ads
//   microsoft    → microsoft_teams, microsoft_onedrive, microsoft_outlook_mail,
//                  microsoft_outlook_calendar, microsoft_onenote,
//                  microsoft_planner, microsoft_sharepoint, microsoft_todo,
//                  microsoft_contacts, microsoft_excel, microsoft_dynamics

import './google.js';
import './slack.js';
import './github.js';
import './gitlab.js';
import './hubspot.js';
import './salesforce.js';
import './atlassian.js';
import './zendesk.js';
import './intercom.js';
import './square.js';
import './dcr.js';
import './meta.js';
import './microsoft.js';

export {};
