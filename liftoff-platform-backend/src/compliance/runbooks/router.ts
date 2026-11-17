// Incident Runbooks Router
// Per Section 19: SOC 2 and GDPR readiness - incident runbooks
// Per Phase 0.3: SE-004 - Fix x-user-id header spoofing vulnerability

import { Router } from 'express';
import { IncidentRunbookService, ESCALATION_POLICIES, COMMUNICATION_TEMPLATES } from './incident-response';
import { getAuthenticatedUserId, getOptionalAuthenticatedUserId, isUnauthorizedError } from '../../infrastructure/auth-helpers';

export const runbooksRouter = Router();
const service = new IncidentRunbookService();

// Create a new incident
// Per SE-004: Use authenticated user context instead of spoofable header
runbooksRouter.post('/incidents', async (req, res) => {
  try {
    const detectedBy = getOptionalAuthenticatedUserId(req);
    const {
      title,
      description,
      severity,
      type,
      impactedServices,
      impactedTenants,
    } = req.body;

    const incident = await service.createIncident({
      title,
      description,
      severity,
      type,
      impactedServices,
      impactedTenants: impactedTenants || [],
      detectedBy: detectedBy || 'system',
    });

    res.status(201).json(incident);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get active incidents
runbooksRouter.get('/incidents/active', async (req, res) => {
  const incidents = await service.getActiveIncidents();
  res.json(incidents);
});

// Get incident by ID
runbooksRouter.get('/incidents/:id', async (req, res) => {
  const incident = await service.getIncident(req.params.id);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found' });
  }
  res.json(incident);
});

// Acknowledge incident
// Per SE-004: Use authenticated user context instead of spoofable header
runbooksRouter.post('/incidents/:id/acknowledge', async (req, res) => {
  try {
    const acknowledgedBy = getAuthenticatedUserId(req);
    const incident = await service.acknowledgeIncident(req.params.id, acknowledgedBy);
    res.json(incident);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Update incident status
// Per SE-004: Use authenticated user context instead of spoofable header
runbooksRouter.post('/incidents/:id/status', async (req, res) => {
  try {
    const updatedBy = getAuthenticatedUserId(req);
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status required' });
    }

    const incident = await service.updateStatus(req.params.id, status, updatedBy, notes);
    res.json(incident);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Assign role to incident
// Per SE-004: Use authenticated user context instead of spoofable header
runbooksRouter.post('/incidents/:id/assign', async (req, res) => {
  try {
    const assignedBy = getAuthenticatedUserId(req);
    const { role, userId } = req.body;

    if (!role || !userId) {
      return res.status(400).json({ error: 'role and userId required' });
    }

    const validRoles = ['incident_commander', 'communications_lead', 'technical_lead'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const incident = await service.assignRole(req.params.id, role, userId, assignedBy);
    res.json(incident);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Add timeline entry
// Per SE-004: Use authenticated user context instead of spoofable header
runbooksRouter.post('/incidents/:id/timeline', async (req, res) => {
  try {
    const author = getAuthenticatedUserId(req);
    const { type, content, metadata } = req.body;

    if (!type || !content) {
      return res.status(400).json({ error: 'type and content required' });
    }

    const entry = await service.addTimelineEntry(req.params.id, {
      author,
      type,
      content,
      metadata,
    });

    res.status(201).json(entry);
  } catch (error: any) {
    if (isUnauthorizedError(error)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    res.status(400).json({ error: error.message });
  }
});

// Add action item
runbooksRouter.post('/incidents/:id/actions', async (req, res) => {
  try {
    const { description, assignee, priority, dueAt } = req.body;

    if (!description || !assignee || !priority) {
      return res.status(400).json({ error: 'description, assignee, and priority required' });
    }

    const actionItem = await service.addActionItem(req.params.id, {
      description,
      assignee,
      priority,
      dueAt: dueAt ? new Date(dueAt) : undefined,
    });

    res.status(201).json(actionItem);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Complete action item
runbooksRouter.post('/incidents/:incidentId/actions/:actionId/complete', async (req, res) => {
  try {
    const actionItem = await service.completeActionItem(req.params.actionId);
    res.json(actionItem);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get escalation policies
runbooksRouter.get('/escalation-policies', async (req, res) => {
  res.json(ESCALATION_POLICIES);
});

// Get escalation policy for severity
runbooksRouter.get('/escalation-policies/:severity', async (req, res) => {
  const severity = req.params.severity.toUpperCase();
  if (!['P1', 'P2', 'P3', 'P4'].includes(severity)) {
    return res.status(400).json({ error: 'Invalid severity. Must be P1, P2, P3, or P4' });
  }

  const policy = service.getEscalationPolicy(severity as any);
  res.json(policy);
});

// Get communication templates
runbooksRouter.get('/templates', async (req, res) => {
  res.json(Object.keys(COMMUNICATION_TEMPLATES));
});

// Get specific template
runbooksRouter.get('/templates/:type', async (req, res) => {
  const templateType = req.params.type;
  const audience = (req.query.audience as string) || 'internal';

  if (!['internal', 'external'].includes(audience)) {
    return res.status(400).json({ error: 'Invalid audience. Must be internal or external' });
  }

  if (!(templateType in COMMUNICATION_TEMPLATES)) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const template = service.getCommunicationTemplate(templateType as any, audience as any);
  res.json({ template });
});

// Render template with data
runbooksRouter.post('/templates/:type/render', async (req, res) => {
  const templateType = req.params.type;
  const audience = (req.query.audience as string) || 'internal';
  const data = req.body;

  if (!(templateType in COMMUNICATION_TEMPLATES)) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const template = service.getCommunicationTemplate(templateType as any, audience as any);
  const rendered = service.renderTemplate(template, data);

  res.json({ rendered });
});
