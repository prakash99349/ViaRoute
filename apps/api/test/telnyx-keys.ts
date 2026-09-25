// Imported first by telnyx.e2e-spec.ts: gives the app a webhook public key before config loads.
import { generateKeyPairSync } from 'crypto';

export const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// Raw 32-byte key = last 32 bytes of the SPKI DER, base64 (the format the Telnyx portal shows).
process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
