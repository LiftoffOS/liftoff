import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getRemoteConfig } from 'firebase/remote-config'
import { googleHostedDomain } from './emailDomains'

// The VITE_FIREBASE_* values are injected at build time via the deploy
// pipeline's Docker build-args (see Dockerfile / cloudbuild.yaml). Builds that
// do NOT inject them — a CI build and a bare local `vite build` — leave apiKey
// undefined, and getAuth() below throws 'auth/invalid-api-key' SYNCHRONOUSLY at
// module load. That crash takes down the entire app, leaving a blank #root.
// Fall back to a non-empty placeholder so initialization never throws; it only
// surfaces in builds without a real key, and real auth requests happen only
// when someone signs in, on a build that ships the injected key. If a deploy
// ever loses the key, login fails loudly at request time rather than
// white-screening the app at load.
// Every field falls back to a non-empty placeholder: getAuth() validates apiKey
// and getRemoteConfig()/Installations validates projectId + appId, each throwing
// synchronously at module load if its value is missing. Any one throw crashes
// the whole app. Placeholders keep all three initializers from throwing; they
// only surface in a keyless build (CI / bare local build), never in the deploy
// build.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'missing-firebase-api-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'missing.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'missing-project',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'missing.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000',
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

// Request additional scopes if needed
googleProvider.addScope('email')
googleProvider.addScope('profile')

// Always show account chooser so users can pick which Google account to use.
// When the build restricts sign-in to a single email domain (dev only), pass
// Google's `hd` hint too so the chooser only offers accounts on that domain.
// Google documents `hd` as a hint it does not guarantee, so AuthProvider still
// verifies the returned profile; this only spares people from picking an
// account that is about to be refused.
const hostedDomain = googleHostedDomain()
googleProvider.setCustomParameters({
  prompt: 'select_account',
  ...(hostedDomain ? { hd: hostedDomain } : {}),
})

export const remoteConfig = getRemoteConfig(app)
remoteConfig.settings.minimumFetchIntervalMillis = 3_600_000
remoteConfig.defaultConfig = {
  liftoff_score_enabled: false,
}

// Web Push (VAPID) public key. Deliberately NOT part of firebaseConfig above:
// it is not a FirebaseOptions field, getToken() takes it separately.
//
// It arrives as a plain Cloud Build substitution rather than from Secret
// Manager (cloudbuild.yaml `_VITE_FIREBASE_VAPID_KEY`), because it is compiled
// into the bundle and served to every visitor. One value covers both
// environments: dev and prod share the Firebase project YOUR_WEB_PROJECT.
//
// Empty string, not a placeholder, when unset. The fields above fall back to
// fake-but-non-empty values because getAuth() and getRemoteConfig() validate
// them and throw SYNCHRONOUSLY at module load, which would take down the
// whole app. Nothing validates this one at load: it is read only when
// a person clicks Enable. So an empty string is the honest signal, and
// lib/pushNotifications.ts reads it as "push is not configured in this build"
// and never calls getToken. A placeholder would instead reach FCM and fail at
// request time, in front of a user who just asked for notifications.
export const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY || ''
