// Firebase Admin SDK — verifies user JWTs on credential management routes.
// Initialized lazily so tests can run without credentials.

import type { DecodedIdToken } from 'firebase-admin/auth';
import { loadConfig } from './config.js';

let adminAuth: import('firebase-admin/auth').Auth | null = null;

async function getAuth(): Promise<import('firebase-admin/auth').Auth> {
  if (adminAuth) return adminAuth;
  const { initializeApp, getApps, cert: _cert } = await import('firebase-admin/app');
  const { getAuth: _getAuth } = await import('firebase-admin/auth');
  const config = loadConfig();

  if (!getApps().length) {
    if (config.FIREBASE_PROJECT_ID) {
      initializeApp({ projectId: config.FIREBASE_PROJECT_ID });
    } else {
      initializeApp();
    }
  }
  adminAuth = _getAuth();
  return adminAuth;
}

export async function verifyIdToken(token: string): Promise<DecodedIdToken> {
  const auth = await getAuth();
  return auth.verifyIdToken(token);
}
