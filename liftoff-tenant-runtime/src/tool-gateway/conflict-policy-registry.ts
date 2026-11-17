// Conflict Policy Registry
// Per Section 11: Versioned config in code inside tenant-runtime

import { ConflictPolicy } from './types';

// Per Section 11: Keep this registry as versioned config in code inside tenant-runtime
// Later, if needed, it can become a database-backed registry

// Per Section 10: Per connector/action type, choose one of:
// - compare-and-set / optimistic concurrency
// - fresh-read-before-write
// - last-write-wins
// - escalate-on-conflict
// - merge semantics
const POLICIES: ConflictPolicy[] = [
  // ============================================
  // Salesforce - CRM with version tracking
  // ============================================
  {
    connector: 'salesforce',
    entityType: 'Account',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Name', 'Industry', 'AnnualRevenue'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'salesforce',
    entityType: 'Opportunity',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Amount', 'StageName', 'CloseDate'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'salesforce',
    entityType: 'Lead',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Status', 'Email', 'Company'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'salesforce',
    entityType: 'Contact',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Email', 'FirstName', 'LastName', 'Phone'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  // Salesforce creates - no conflict detection needed
  {
    connector: 'salesforce',
    entityType: '*',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full', // Can delete created records
  },

  // ============================================
  // HubSpot - CRM with version tracking
  // ============================================
  {
    connector: 'hubspot',
    entityType: 'Contact',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'hs_object_version_number',
    fieldComparisonSet: ['email', 'firstname', 'lastname'],
    conflictResolutionMode: 'fresh-read-before-write',
    escalateOnConflict: false,
    undoSupportMode: 'partial',
  },
  {
    connector: 'hubspot',
    entityType: 'Deal',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'hs_object_version_number',
    fieldComparisonSet: ['dealname', 'amount', 'dealstage', 'closedate'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'hubspot',
    entityType: 'Company',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'hs_object_version_number',
    fieldComparisonSet: ['name', 'domain', 'industry'],
    conflictResolutionMode: 'merge',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },

  // ============================================
  // Jira - Issue tracking with optimistic locking
  // ============================================
  {
    connector: 'atlassian_jira',
    entityType: 'Issue',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: null, // Jira uses ETags
    fieldComparisonSet: ['summary', 'status', 'assignee'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'atlassian_jira',
    entityType: 'Issue',
    actionType: 'transition',
    freshnessTTL: 15, // Transitions require fresh state
    freshReadBeforeWriteRequired: true,
    versionTokenField: null,
    fieldComparisonSet: ['status'],
    conflictResolutionMode: 'escalate-on-conflict',
    escalateOnConflict: true,
    undoSupportMode: 'partial', // Can transition back
  },
  {
    connector: 'atlassian_jira',
    entityType: 'Comment',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full', // Can delete comments
  },

  // ============================================
  // Slack - Messaging (mostly append-only)
  // ============================================
  {
    connector: 'slack',
    entityType: 'Message',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full', // Can delete messages
  },
  {
    connector: 'slack',
    entityType: 'Message',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'ts',
    fieldComparisonSet: ['text', 'attachments'],
    conflictResolutionMode: 'fresh-read-before-write',
    escalateOnConflict: false,
    undoSupportMode: 'partial',
  },

  // ============================================
  // Zoom - Meeting management
  // ============================================
  {
    connector: 'zoom',
    entityType: 'Meeting',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: null,
    fieldComparisonSet: ['topic', 'start_time', 'duration'],
    conflictResolutionMode: 'fresh-read-before-write',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'zoom',
    entityType: 'Meeting',
    actionType: 'delete',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: null,
    fieldComparisonSet: ['status'],
    conflictResolutionMode: 'escalate-on-conflict',
    escalateOnConflict: true,
    undoSupportMode: 'full', // Can recreate meeting from pre-action snapshot
  },

  // ============================================
  // GitHub - Code/Issue management
  // ============================================
  {
    connector: 'github',
    entityType: 'Issue',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'updated_at',
    fieldComparisonSet: ['title', 'body', 'state', 'labels'],
    conflictResolutionMode: 'merge',
    escalateOnConflict: false,
    undoSupportMode: 'partial',
  },
  {
    connector: 'github',
    entityType: 'Issue',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full', // Can close issue
  },
  {
    connector: 'github',
    entityType: 'PullRequest',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'updated_at',
    fieldComparisonSet: ['title', 'body', 'state'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'github',
    entityType: 'Comment',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full',
  },

  // ============================================
  // Google Workspace - Calendar/Docs
  // ============================================
  {
    connector: 'google_calendar',
    entityType: 'Event',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'etag',
    fieldComparisonSet: ['summary', 'start', 'end', 'attendees'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'google_calendar',
    entityType: 'Event',
    actionType: 'delete',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'etag',
    fieldComparisonSet: ['status'],
    conflictResolutionMode: 'escalate-on-conflict',
    escalateOnConflict: true,
    undoSupportMode: 'full', // Can recreate event from pre-action snapshot
  },

  // ============================================
  // Notion - Wiki/Database
  // ============================================
  {
    connector: 'notion',
    entityType: 'Page',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'last_edited_time',
    fieldComparisonSet: ['title', 'properties'],
    conflictResolutionMode: 'merge',
    escalateOnConflict: false,
    undoSupportMode: 'partial',
  },
  {
    connector: 'notion',
    entityType: 'Database',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'last_edited_time',
    fieldComparisonSet: ['title', 'properties'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },

  // ============================================
  // Linear - Project management
  // ============================================
  {
    connector: 'linear',
    entityType: 'Issue',
    actionType: 'update',
    freshnessTTL: 30,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'updatedAt',
    fieldComparisonSet: ['title', 'description', 'state', 'assignee'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
  },
  {
    connector: 'linear',
    entityType: 'Comment',
    actionType: 'create',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'full',
  },

  // ============================================
  // Intercom - Customer messaging
  // ============================================
  {
    connector: 'intercom',
    entityType: 'Conversation',
    actionType: 'reply',
    freshnessTTL: null,
    freshReadBeforeWriteRequired: false,
    versionTokenField: null,
    fieldComparisonSet: [],
    conflictResolutionMode: 'last-write-wins',
    escalateOnConflict: false,
    undoSupportMode: 'none', // Cannot unsend
  },
  {
    connector: 'intercom',
    entityType: 'Contact',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'updated_at',
    fieldComparisonSet: ['email', 'name', 'custom_attributes'],
    conflictResolutionMode: 'merge',
    escalateOnConflict: false,
    undoSupportMode: 'partial',
  },
];

export class ConflictPolicyRegistry {
  get(connector: string, entityType: string, actionType: string): ConflictPolicy {
    const policy = POLICIES.find(
      (p) =>
        p.connector === connector &&
        p.entityType === entityType &&
        p.actionType === actionType
    );

    if (!policy) {
      // Default restrictive policy
      return {
        connector,
        entityType,
        actionType,
        freshnessTTL: 30,
        freshReadBeforeWriteRequired: true,
        versionTokenField: null,
        fieldComparisonSet: [],
        conflictResolutionMode: 'escalate-on-conflict',
        escalateOnConflict: true,
        undoSupportMode: 'none',
      };
    }

    return policy;
  }
}
