// Passkey types for WebAuthn

export interface Passkey {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceName: string | null;
  transports: string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreatePasskeyInput {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceName?: string;
  transports?: string[];
}

export interface RegistrationOptions {
  challenge: string;
  rp: {
    name: string;
    id: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: Array<{
    alg: number;
    type: 'public-key';
  }>;
  timeout: number;
  attestation: 'none' | 'indirect' | 'direct';
  authenticatorSelection: {
    authenticatorAttachment: 'platform' | 'cross-platform';
    userVerification: 'required' | 'preferred' | 'discouraged';
    residentKey: 'required' | 'preferred' | 'discouraged';
  };
  excludeCredentials?: Array<{
    id: string;
    type: 'public-key';
    transports?: string[];
  }>;
}

export interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required' | 'preferred' | 'discouraged';
  allowCredentials?: Array<{
    id: string;
    type: 'public-key';
    transports?: string[];
  }>;
}

export interface RegistrationVerificationInput {
  credentialId: string;
  attestationObject: string;
  clientDataJSON: string;
  transports?: string[];
  deviceName?: string;
}

export interface AuthenticationVerificationInput {
  credentialId: string;
  signature: string;
  authenticatorData: string;
  clientDataJSON: string;
}
