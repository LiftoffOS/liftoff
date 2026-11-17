// Firebase Admin SDK Integration
// Per Section 20: Firebase for authentication token verification

import { initializeApp, cert, applicationDefault, App } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';
import { log } from './logging';

let firebaseApp: App | null = null;

// Initialize Firebase Admin SDK
// Uses Application Default Credentials when running on GCP (Cloud Run)
// Falls back to service account JSON for local development
export async function initFirebase(serviceAccountJson?: string): Promise<void> {
  if (firebaseApp) {
    log.warn('Firebase already initialized');
    return;
  }

  try {
    if (serviceAccountJson) {
      // Use explicit service account credentials (local dev)
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      log.info({ projectId: serviceAccount.project_id }, 'Firebase Admin SDK initialized with service account');
    } else {
      // Use Application Default Credentials (Cloud Run, GKE, etc.)
      // Note: FIREBASE_PROJECT_ID is for auth token verification, separate from GCP_PROJECT_ID
      firebaseApp = initializeApp({
        credential: applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID || 'YOUR_WEB_PROJECT',
      });
      log.info({ projectId: process.env.FIREBASE_PROJECT_ID || 'YOUR_WEB_PROJECT' }, 'Firebase Admin SDK initialized with Application Default Credentials');
    }
  } catch (error) {
    log.error({ error }, 'Failed to initialize Firebase Admin SDK');
    throw new Error('Failed to initialize Firebase Admin SDK');
  }
}

// Verify Firebase ID token and return decoded claims
export async function verifyIdToken(idToken: string): Promise<DecodedIdToken> {
  if (!firebaseApp) {
    throw new Error('Firebase not initialized');
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(idToken, true);
    return decodedToken;
  } catch (error) {
    log.debug({ error }, 'Token verification failed');
    throw error;
  }
}

// Create a custom token for a user (used for passkey authentication)
export async function createCustomToken(uid: string): Promise<string> {
  if (!firebaseApp) {
    throw new Error('Firebase not initialized');
  }

  try {
    return await getAuth().createCustomToken(uid);
  } catch (error) {
    log.error({ error, uid }, 'Failed to create custom token');
    throw error;
  }
}

// Check if Firebase is initialized
export function isFirebaseInitialized(): boolean {
  return firebaseApp !== null;
}

// Export types for use in other modules
export type { DecodedIdToken };
