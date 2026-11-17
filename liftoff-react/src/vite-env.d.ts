/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_STORAGE_BUCKET: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string
  readonly VITE_FIREBASE_APP_ID: string
  // Comma-separated email-domain allow-list for sign-in and signup. Empty or
  // absent means no restriction, which is what prod builds ship.
  readonly VITE_ALLOWED_EMAIL_DOMAINS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
