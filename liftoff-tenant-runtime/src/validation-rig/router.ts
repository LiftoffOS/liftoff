// Production Validation Router
// Per Section 21: Run design-partner workflows end to end

import { Router } from 'express';
import { ProductionValidationService } from './production-validation';

export const validationRigRouter = Router();
const service = new ProductionValidationService();

// Start a new production validation
validationRigRouter.post('/validations', async (req, res) => {
  try {
    const createdBy = req.headers['x-user-id'] as string;
    const {
      tenantId,
      designPartnerId,
      designPartnerName,
      config,
    } = req.body;

    if (!createdBy) {
      return res.status(401).json({ error: 'User ID required' });
    }

    if (!tenantId || !designPartnerId || !designPartnerName || !config) {
      return res.status(400).json({
        error: 'tenantId, designPartnerId, designPartnerName, and config required',
      });
    }

    const validation = await service.startValidation({
      tenantId,
      designPartnerId,
      designPartnerName,
      createdBy,
      config,
    });

    res.status(201).json(validation);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Execute a validation
validationRigRouter.post('/validations/:id/execute', async (req, res) => {
  try {
    const validation = await service.executeValidation(req.params.id);
    res.json(validation);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Get validation by ID
validationRigRouter.get('/validations/:id', async (req, res) => {
  const validation = await service.getValidation(req.params.id);
  if (!validation) {
    return res.status(404).json({ error: 'Validation not found' });
  }
  res.json(validation);
});

// Get validation phases for a validation
validationRigRouter.get('/validations/:id/phases', async (req, res) => {
  const validation = await service.getValidation(req.params.id);
  if (!validation) {
    return res.status(404).json({ error: 'Validation not found' });
  }
  res.json(validation.phases);
});

// Get connector test results
validationRigRouter.get('/validations/:id/connectors', async (req, res) => {
  const validation = await service.getValidation(req.params.id);
  if (!validation) {
    return res.status(404).json({ error: 'Validation not found' });
  }
  res.json(validation.connectorTests);
});

// Get real data test results
validationRigRouter.get('/validations/:id/real-data-tests', async (req, res) => {
  const validation = await service.getValidation(req.params.id);
  if (!validation) {
    return res.status(404).json({ error: 'Validation not found' });
  }
  res.json(validation.realDataTests);
});

// Get validation summary
validationRigRouter.get('/validations/:id/summary', async (req, res) => {
  const validation = await service.getValidation(req.params.id);
  if (!validation) {
    return res.status(404).json({ error: 'Validation not found' });
  }
  res.json(validation.summary);
});
