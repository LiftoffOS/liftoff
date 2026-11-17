// JWT Token Verification
//
// Delegates to infrastructure/firebase.ts rather than verifying here. This file
// used to call `admin.auth().verifyIdToken(token)` through the legacy namespaced
// `firebase-admin` entry point, which firebase-admin 14 removes. Porting it to
// the modular `getAuth()` would have kept two verification paths that had
// already drifted apart: this one passed no `checkRevoked`, so a token revoked
// through /me/sessions/revoke-all still opened a voice WebSocket after every
// HTTP route had started rejecting it.
//
// One path now, and it is the strict one.

import { verifyIdToken } from '../infrastructure/firebase';
import { log } from '../infrastructure/logging';

export interface TokenPayload {
  uid: string;
  userId: string;
  email?: string;
  tenantId?: string;
  role?: string;
}

// Verify Firebase ID token
export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    // Throws on an invalid, expired or revoked token, and when Firebase has not
    // been initialized. Every one of those is "no caller identity" here, which
    // is what null means to the WebSocket handshake that reads it.
    const decodedToken = await verifyIdToken(token);
    return {
      uid: decodedToken.uid,
      userId: decodedToken.uid,
      email: decodedToken.email,
      // Custom claims, so they are not on DecodedIdToken's declared shape and
      // are read through the index signature. Absent for most accounts.
      tenantId: decodedToken.tenantId as string | undefined,
      role: decodedToken.role as string | undefined,
    };
  } catch (error) {
    log.warn({ error }, 'Failed to verify token');
    return null;
  }
}

// Verify token from Authorization header
export async function verifyAuthHeader(authHeader: string | undefined): Promise<TokenPayload | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  return verifyToken(token);
}
