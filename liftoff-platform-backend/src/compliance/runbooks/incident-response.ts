// Incident Response Runbook Service
// Per Section 19: SOC 2 and GDPR readiness - incident runbooks

import { pool } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { PubSubPublisher } from '../../infrastructure/pubsub';

export type IncidentSeverity = 'P1' | 'P2' | 'P3' | 'P4';
export type IncidentStatus = 'detected' | 'acknowledged' | 'investigating' | 'mitigating' | 'resolved' | 'post_mortem';
export type IncidentType = 'outage' | 'degradation' | 'security' | 'data_loss' | 'compliance' | 'other';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  type: IncidentType;
  status: IncidentStatus;
  impactedServices: string[];
  impactedTenants: string[];
  incidentCommander?: string;
  communicationsLead?: string;
  technicalLead?: string;
  detectedAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  timeline: IncidentTimelineEntry[];
  actionItems: IncidentActionItem[];
  postMortemId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IncidentTimelineEntry {
  id: string;
  incidentId: string;
  timestamp: Date;
  author: string;
  type: 'status_change' | 'update' | 'action' | 'communication' | 'escalation';
  content: string;
  metadata?: Record<string, any>;
}

export interface IncidentActionItem {
  id: string;
  incidentId: string;
  description: string;
  assignee: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  dueAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface EscalationPolicy {
  severity: IncidentSeverity;
  initialResponseMinutes: number;
  escalationChain: EscalationLevel[];
  autoEscalateAfterMinutes: number;
  requiresIncidentCommander: boolean;
  requiresCommunicationsLead: boolean;
  notifyExecutives: boolean;
  notifyCustomers: boolean;
}

export interface EscalationLevel {
  level: number;
  roles: string[];
  channels: string[];
  timeoutMinutes: number;
}

// Default escalation policies per severity
export const ESCALATION_POLICIES: Record<IncidentSeverity, EscalationPolicy> = {
  P1: {
    severity: 'P1',
    initialResponseMinutes: 5,
    autoEscalateAfterMinutes: 15,
    requiresIncidentCommander: true,
    requiresCommunicationsLead: true,
    notifyExecutives: true,
    notifyCustomers: true,
    escalationChain: [
      { level: 1, roles: ['on-call-engineer'], channels: ['pagerduty', 'slack'], timeoutMinutes: 5 },
      { level: 2, roles: ['engineering-lead', 'platform-lead'], channels: ['pagerduty', 'slack', 'phone'], timeoutMinutes: 10 },
      { level: 3, roles: ['vp-engineering', 'cto'], channels: ['pagerduty', 'slack', 'phone', 'sms'], timeoutMinutes: 15 },
    ],
  },
  P2: {
    severity: 'P2',
    initialResponseMinutes: 15,
    autoEscalateAfterMinutes: 30,
    requiresIncidentCommander: true,
    requiresCommunicationsLead: false,
    notifyExecutives: false,
    notifyCustomers: true,
    escalationChain: [
      { level: 1, roles: ['on-call-engineer'], channels: ['pagerduty', 'slack'], timeoutMinutes: 15 },
      { level: 2, roles: ['engineering-lead'], channels: ['pagerduty', 'slack'], timeoutMinutes: 30 },
    ],
  },
  P3: {
    severity: 'P3',
    initialResponseMinutes: 60,
    autoEscalateAfterMinutes: 120,
    requiresIncidentCommander: false,
    requiresCommunicationsLead: false,
    notifyExecutives: false,
    notifyCustomers: false,
    escalationChain: [
      { level: 1, roles: ['on-call-engineer'], channels: ['slack'], timeoutMinutes: 60 },
      { level: 2, roles: ['engineering-lead'], channels: ['slack'], timeoutMinutes: 120 },
    ],
  },
  P4: {
    severity: 'P4',
    initialResponseMinutes: 240,
    autoEscalateAfterMinutes: 480,
    requiresIncidentCommander: false,
    requiresCommunicationsLead: false,
    notifyExecutives: false,
    notifyCustomers: false,
    escalationChain: [
      { level: 1, roles: ['assigned-engineer'], channels: ['slack'], timeoutMinutes: 240 },
    ],
  },
};

// Communication templates
export const COMMUNICATION_TEMPLATES = {
  initial_detection: {
    internal: `
🚨 INCIDENT DETECTED

**Incident ID:** {{incidentId}}
**Severity:** {{severity}}
**Type:** {{type}}
**Title:** {{title}}

**Description:**
{{description}}

**Impacted Services:** {{impactedServices}}
**Impacted Tenants:** {{impactedTenants}}

**Detected At:** {{detectedAt}}

**Immediate Actions:**
1. Acknowledge incident in #incidents channel
2. Join incident bridge: {{bridgeLink}}
3. Review runbook: {{runbookLink}}

**Escalation Policy:** {{escalationPolicy}}
    `.trim(),
    external: `
We are currently investigating an issue that may be affecting some of our services. We will provide updates as more information becomes available.

Current Status: Investigating
    `.trim(),
  },
  status_update: {
    internal: `
📊 INCIDENT UPDATE - {{incidentId}}

**Status:** {{status}}
**Last Updated:** {{timestamp}}
**Updated By:** {{author}}

**Update:**
{{content}}

**Current Impact:**
- Services: {{impactedServices}}
- Tenants: {{impactedTenants}}

**Next Steps:**
{{nextSteps}}
    `.trim(),
    external: `
Update on {{title}}

We continue to work on resolving the issue affecting {{impactedServices}}.

Current Status: {{status}}
Next Update: {{nextUpdateTime}}
    `.trim(),
  },
  resolution: {
    internal: `
✅ INCIDENT RESOLVED - {{incidentId}}

**Resolved At:** {{resolvedAt}}
**Duration:** {{duration}}
**Resolved By:** {{resolvedBy}}

**Resolution Summary:**
{{resolutionSummary}}

**Impact Summary:**
- Duration: {{duration}}
- Affected Services: {{impactedServices}}
- Affected Tenants: {{impactedTenants}}

**Post-Mortem:** {{postMortemRequired ? 'Required' : 'Not Required'}}
{{postMortemDate ? 'Scheduled: ' + postMortemDate : ''}}
    `.trim(),
    external: `
Resolved: {{title}}

The issue affecting {{impactedServices}} has been resolved.

Duration: {{duration}}
Impact: {{impactSummary}}

We apologize for any inconvenience caused. A detailed analysis will be conducted to prevent similar issues in the future.
    `.trim(),
  },
  post_mortem: {
    template: `
# Post-Incident Review: {{incidentId}}

## Incident Summary
- **Title:** {{title}}
- **Severity:** {{severity}}
- **Duration:** {{duration}}
- **Detection Time:** {{detectedAt}}
- **Resolution Time:** {{resolvedAt}}

## Impact
- **Services Affected:** {{impactedServices}}
- **Customers Affected:** {{customerCount}}
- **Error Rate:** {{errorRate}}
- **Revenue Impact:** {{revenueImpact}}

## Timeline
{{#each timeline}}
- **{{timestamp}}** [{{type}}] {{content}}
{{/each}}

## Root Cause Analysis

### What Happened
{{rootCause}}

### Why It Happened
{{whyItHappened}}

### Detection
- How was the incident detected? {{detectionMethod}}
- Time to detection: {{timeToDetection}}
- Could we have detected it sooner? {{detectionImprovement}}

## Response Analysis

### What Went Well
{{#each whatWentWell}}
- {{this}}
{{/each}}

### What Could Be Improved
{{#each whatCouldBeImproved}}
- {{this}}
{{/each}}

## Action Items
| Priority | Action | Owner | Due Date | Status |
|----------|--------|-------|----------|--------|
{{#each actionItems}}
| {{priority}} | {{description}} | {{assignee}} | {{dueDate}} | {{status}} |
{{/each}}

## Lessons Learned
{{lessonsLearned}}

## Prevention Measures
{{preventionMeasures}}

## Sign-Off
- **Incident Commander:** {{incidentCommander}}
- **Technical Lead:** {{technicalLead}}
- **Review Date:** {{reviewDate}}
    `.trim(),
  },
};

export class IncidentRunbookService {
  private publisher = new PubSubPublisher();

  // Create a new incident
  async createIncident(input: {
    title: string;
    description: string;
    severity: IncidentSeverity;
    type: IncidentType;
    impactedServices: string[];
    impactedTenants: string[];
    detectedBy: string;
  }): Promise<Incident> {
    const result = await pool.query(
      `INSERT INTO incidents (
        title, description, severity, type, status,
        impacted_services, impacted_tenants, detected_at
      ) VALUES ($1, $2, $3, $4, 'detected', $5, $6, NOW())
      RETURNING *`,
      [
        input.title,
        input.description,
        input.severity,
        input.type,
        JSON.stringify(input.impactedServices),
        JSON.stringify(input.impactedTenants),
      ]
    );

    const incident = this.mapIncident(result.rows[0]);

    // Add initial timeline entry
    await this.addTimelineEntry(incident.id, {
      author: input.detectedBy,
      type: 'status_change',
      content: `Incident detected: ${input.title}`,
      metadata: { severity: input.severity, type: input.type },
    });

    // Trigger escalation
    await this.triggerEscalation(incident);

    log.warn('Incident created', {
      incidentId: incident.id,
      severity: incident.severity,
      type: incident.type,
    });

    return incident;
  }

  // Acknowledge an incident
  async acknowledgeIncident(
    incidentId: string,
    acknowledgedBy: string
  ): Promise<Incident> {
    const result = await pool.query(
      `UPDATE incidents
       SET status = 'acknowledged', acknowledged_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [incidentId]
    );

    if (!result.rows[0]) {
      throw new Error('Incident not found');
    }

    const incident = this.mapIncident(result.rows[0]);

    await this.addTimelineEntry(incidentId, {
      author: acknowledgedBy,
      type: 'status_change',
      content: 'Incident acknowledged',
    });

    log.info('Incident acknowledged', { incidentId, acknowledgedBy });

    return incident;
  }

  // Update incident status
  async updateStatus(
    incidentId: string,
    status: IncidentStatus,
    updatedBy: string,
    notes?: string
  ): Promise<Incident> {
    const updates: string[] = ['status = $2', 'updated_at = NOW()'];
    const values: any[] = [incidentId, status];

    if (status === 'resolved') {
      updates.push('resolved_at = NOW()');
    }

    const result = await pool.query(
      `UPDATE incidents SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );

    if (!result.rows[0]) {
      throw new Error('Incident not found');
    }

    const incident = this.mapIncident(result.rows[0]);

    await this.addTimelineEntry(incidentId, {
      author: updatedBy,
      type: 'status_change',
      content: `Status changed to ${status}${notes ? ': ' + notes : ''}`,
      metadata: { previousStatus: result.rows[0].status, newStatus: status },
    });

    // Send notifications based on status
    if (status === 'resolved') {
      await this.sendResolutionNotification(incident);
    }

    log.info('Incident status updated', { incidentId, status, updatedBy });

    return incident;
  }

  // Assign incident roles
  async assignRole(
    incidentId: string,
    role: 'incident_commander' | 'communications_lead' | 'technical_lead',
    userId: string,
    assignedBy: string
  ): Promise<Incident> {
    const columnMap = {
      incident_commander: 'incident_commander',
      communications_lead: 'communications_lead',
      technical_lead: 'technical_lead',
    };

    const result = await pool.query(
      `UPDATE incidents SET ${columnMap[role]} = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [incidentId, userId]
    );

    if (!result.rows[0]) {
      throw new Error('Incident not found');
    }

    const incident = this.mapIncident(result.rows[0]);

    await this.addTimelineEntry(incidentId, {
      author: assignedBy,
      type: 'update',
      content: `${role.replace('_', ' ')} assigned: ${userId}`,
    });

    log.info('Incident role assigned', { incidentId, role, userId });

    return incident;
  }

  // Add timeline entry
  async addTimelineEntry(
    incidentId: string,
    entry: {
      author: string;
      type: IncidentTimelineEntry['type'];
      content: string;
      metadata?: Record<string, any>;
    }
  ): Promise<IncidentTimelineEntry> {
    const result = await pool.query(
      `INSERT INTO incident_timeline (incident_id, timestamp, author, type, content, metadata)
       VALUES ($1, NOW(), $2, $3, $4, $5)
       RETURNING *`,
      [incidentId, entry.author, entry.type, entry.content, JSON.stringify(entry.metadata || {})]
    );

    return this.mapTimelineEntry(result.rows[0]);
  }

  // Add action item
  async addActionItem(
    incidentId: string,
    actionItem: {
      description: string;
      assignee: string;
      priority: 'high' | 'medium' | 'low';
      dueAt?: Date;
    }
  ): Promise<IncidentActionItem> {
    const result = await pool.query(
      `INSERT INTO incident_action_items (incident_id, description, assignee, priority, status, due_at)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [incidentId, actionItem.description, actionItem.assignee, actionItem.priority, actionItem.dueAt]
    );

    return this.mapActionItem(result.rows[0]);
  }

  // Complete action item
  async completeActionItem(actionItemId: string): Promise<IncidentActionItem> {
    const result = await pool.query(
      `UPDATE incident_action_items
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [actionItemId]
    );

    if (!result.rows[0]) {
      throw new Error('Action item not found');
    }

    return this.mapActionItem(result.rows[0]);
  }

  // Get incident by ID
  async getIncident(incidentId: string): Promise<Incident | null> {
    const result = await pool.query(
      'SELECT * FROM incidents WHERE id = $1',
      [incidentId]
    );

    if (!result.rows[0]) return null;

    const incident = this.mapIncident(result.rows[0]);
    incident.timeline = await this.getTimeline(incidentId);
    incident.actionItems = await this.getActionItems(incidentId);

    return incident;
  }

  // Get active incidents
  async getActiveIncidents(): Promise<Incident[]> {
    const result = await pool.query(
      `SELECT * FROM incidents
       WHERE status NOT IN ('resolved', 'post_mortem')
       ORDER BY
         CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
         detected_at DESC`
    );

    return result.rows.map(this.mapIncident);
  }

  // Get escalation policy for severity
  getEscalationPolicy(severity: IncidentSeverity): EscalationPolicy {
    return ESCALATION_POLICIES[severity];
  }

  // Get communication template
  getCommunicationTemplate(
    templateType: keyof typeof COMMUNICATION_TEMPLATES,
    audience: 'internal' | 'external'
  ): string {
    const template = COMMUNICATION_TEMPLATES[templateType];
    if ('template' in template) {
      return template.template;
    }
    return template[audience];
  }

  // Render template with data
  renderTemplate(template: string, data: Record<string, any>): string {
    let rendered = template;

    // Simple variable replacement
    for (const [key, value] of Object.entries(data)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      rendered = rendered.replace(regex, String(value ?? ''));
    }

    return rendered;
  }

  // Private methods
  private async triggerEscalation(incident: Incident): Promise<void> {
    const policy = ESCALATION_POLICIES[incident.severity];

    await this.publisher.publish('incident-escalations', {
      incidentId: incident.id,
      severity: incident.severity,
      policy,
      timestamp: new Date().toISOString(),
    });
  }

  private async sendResolutionNotification(incident: Incident): Promise<void> {
    await this.publisher.publish('incident-notifications', {
      type: 'resolution',
      incidentId: incident.id,
      severity: incident.severity,
      title: incident.title,
      timestamp: new Date().toISOString(),
    });
  }

  private async getTimeline(incidentId: string): Promise<IncidentTimelineEntry[]> {
    const result = await pool.query(
      'SELECT * FROM incident_timeline WHERE incident_id = $1 ORDER BY timestamp ASC',
      [incidentId]
    );
    return result.rows.map(this.mapTimelineEntry);
  }

  private async getActionItems(incidentId: string): Promise<IncidentActionItem[]> {
    const result = await pool.query(
      'SELECT * FROM incident_action_items WHERE incident_id = $1 ORDER BY created_at ASC',
      [incidentId]
    );
    return result.rows.map(this.mapActionItem);
  }

  private mapIncident(row: any): Incident {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      severity: row.severity,
      type: row.type,
      status: row.status,
      impactedServices: typeof row.impacted_services === 'string'
        ? JSON.parse(row.impacted_services)
        : row.impacted_services,
      impactedTenants: typeof row.impacted_tenants === 'string'
        ? JSON.parse(row.impacted_tenants)
        : row.impacted_tenants,
      incidentCommander: row.incident_commander,
      communicationsLead: row.communications_lead,
      technicalLead: row.technical_lead,
      detectedAt: row.detected_at,
      acknowledgedAt: row.acknowledged_at,
      resolvedAt: row.resolved_at,
      timeline: [],
      actionItems: [],
      postMortemId: row.post_mortem_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapTimelineEntry(row: any): IncidentTimelineEntry {
    return {
      id: row.id,
      incidentId: row.incident_id,
      timestamp: row.timestamp,
      author: row.author,
      type: row.type,
      content: row.content,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }

  private mapActionItem(row: any): IncidentActionItem {
    return {
      id: row.id,
      incidentId: row.incident_id,
      description: row.description,
      assignee: row.assignee,
      priority: row.priority,
      status: row.status,
      dueAt: row.due_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
