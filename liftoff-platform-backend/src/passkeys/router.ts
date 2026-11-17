// Passkey Router
// WebAuthn API endpoints

import { Router } from 'express';
import { PasskeyService } from './service';
import { createCustomToken } from '../infrastructure/firebase';
import { logAudit } from '../infrastructure/logging';
import { resolveAuditActor } from '../infrastructure/audit-context';

const router = Router();
const service = new PasskeyService();

// Get registration options (requires auth)
router.post('/register/options', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const options = await service.getRegistrationOptions(
      user.uid,
      user.email || user.uid,
      user.displayName || user.email || 'User'
    );

    req.log.info({ userId: user.uid }, 'Passkey registration options generated');
    res.json(options);
  } catch (error) {
    next(error);
  }
});

// Verify registration and store passkey (requires auth)
router.post('/register/verify', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { credentialId, attestationObject, clientDataJSON, transports, deviceName } = req.body;

    if (!credentialId || !attestationObject || !clientDataJSON) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const passkey = await service.verifyRegistration(user.uid, {
      credentialId,
      attestationObject,
      clientDataJSON,
      transports,
      deviceName,
    });

    req.log.info({ userId: user.uid, passkeyId: passkey.id }, 'Passkey registered');

    // Audit attribution: passkey is account-scoped, not tenant-scoped.
    //
    // Three cases:
    //   1. User has joined at least one tenant → attribute to primary
    //      tenant; row appears in that tenant's workspace audit feed.
    //   2. User has NO tenant memberships yet (mid-signup, account just
    //      created) → still emit the audit row with tenant_id NULL so the
    //      `account.*` history exists in audit_log for later forensic
    //      lookup; it just won't surface in any workspace feed. A later
    //      backfill could re-attribute these on tenant creation.
    //   3. Firebase UID has no account row at all → skip (truly anonymous;
    //      shouldn't happen at this point in the flow).
    const actor = await resolveAuditActor(req);
    if (actor) {
      logAudit(
        'passkey.registered',
        {
          ...req.ctx,
          tenantId: actor.primaryTenantId ?? undefined,
          userId: actor.accountId,
        },
        {
          resourceType: 'account',
          resourceId: actor.accountId,
          newState: {
            passkeyId: passkey.id,
            deviceName: passkey.deviceName,
          },
        },
      );
    } else {
      req.log.warn(
        { firebaseUid: user.uid, passkeyId: passkey.id },
        'passkey.registered: no account row resolved — audit row skipped',
      );
    }

    res.json({
      id: passkey.id,
      credentialId: passkey.credentialId,
      deviceName: passkey.deviceName,
      createdAt: passkey.createdAt,
    });
  } catch (error) {
    next(error);
  }
});

// Get authentication options (public - for passkey login)
router.post('/authenticate/options', async (req, res, next) => {
  try {
    const { userId } = req.body;
    const options = await service.getAuthenticationOptions(userId);

    req.log.info('Passkey authentication options generated');
    res.json(options);
  } catch (error) {
    next(error);
  }
});

// Verify authentication (public - for passkey login)
router.post('/authenticate/verify', async (req, res, next) => {
  try {
    const { credentialId, counter } = req.body;

    if (!credentialId) {
      return res.status(400).json({ error: 'Missing credential ID' });
    }

    const passkey = await service.verifyAuthentication(credentialId, counter || 0);

    // Create a Firebase custom token for the user to sign in
    const customToken = await createCustomToken(passkey.userId);

    req.log.info({ userId: passkey.userId, passkeyId: passkey.id }, 'Passkey authentication verified');
    res.json({
      userId: passkey.userId,
      passkeyId: passkey.id,
      verified: true,
      customToken,
    });
  } catch (error) {
    next(error);
  }
});

// List user's passkeys (requires auth)
router.get('/', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const passkeys = await service.getPasskeys(user.uid);

    res.json(
      passkeys.map((p) => ({
        id: p.id,
        credentialId: p.credentialId,
        deviceName: p.deviceName,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      }))
    );
  } catch (error) {
    next(error);
  }
});

// Delete a passkey (requires auth)
router.delete('/:id', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch the passkey BEFORE delete so the audit `previousState` carries
    // the deviceName (otherwise reviewers only see an opaque ID).
    const passkeys = await service.getPasskeys(user.uid);
    const prior = passkeys.find((p) => p.id === req.params.id);

    const deleted = await service.deletePasskey(req.params.id, user.uid);

    if (!deleted) {
      return res.status(404).json({ error: 'Passkey not found' });
    }

    req.log.info({ userId: user.uid, passkeyId: req.params.id }, 'Passkey deleted');

    // Same attribution semantics as registration (see register handler):
    // attribute to primary tenant; emit with tenant_id NULL when none.
    const actor = await resolveAuditActor(req);
    if (actor) {
      logAudit(
        'passkey.deleted',
        {
          ...req.ctx,
          tenantId: actor.primaryTenantId ?? undefined,
          userId: actor.accountId,
        },
        {
          resourceType: 'account',
          resourceId: actor.accountId,
          previousState: prior
            ? { passkeyId: prior.id, deviceName: prior.deviceName }
            : { passkeyId: req.params.id },
        },
      );
    } else {
      req.log.warn(
        { firebaseUid: user.uid, passkeyId: req.params.id },
        'passkey.deleted: no account row resolved — audit row skipped',
      );
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export const passkeysRouter = router;
