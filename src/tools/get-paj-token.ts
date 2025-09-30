import 'dotenv/config';
import readline from 'node:readline';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Load paj_ramp with loose typing to accommodate missing type exports
// eslint-disable-next-line @typescript-eslint/no-var-requires
const paj: any = require('paj_ramp');

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  const env = (process.env.PAJ_RAMP_ENV === 'production' ? 'production' : 'staging') as 'staging' | 'production';
  const email = process.env.PAJ_EMAIL;
  const apiKey = process.env.PAJ_API_KEY;

  if (!email || !apiKey) {
    console.error('Missing required env vars. Please set PAJ_EMAIL and PAJ_API_KEY in your .env');
    process.exit(1);
  }

  console.log(`Initializing PAJ Ramp SDK in ${env}...`);
  if (typeof paj.initializeSDK !== 'function') {
    console.error('paj_ramp.initializeSDK not found. Is paj_ramp installed correctly?');
    process.exit(1);
  }
  paj.initializeSDK(env);

  console.log('Starting verification session (an OTP will be emailed to you)...');
  if (typeof paj.initiate !== 'function') {
    console.error('paj_ramp.initiate not found. Please ensure your paj_ramp version supports session initiation.');
    process.exit(1);
  }
  const initResp = await paj.initiate(email, apiKey);
  console.log(`Initiated for ${initResp.email}. Check your inbox for the OTP.`);

  const otp = await ask('Enter the OTP from your email: ');

  // Basic device info (customize as needed)
  const deviceInfo = {
    uuid: process.env.PAJ_DEVICE_UUID || os.hostname(),
    device: process.env.PAJ_DEVICE_NAME || 'Server',
    os: process.platform,
    browser: 'node',
    ip: process.env.PAJ_DEVICE_IP || '127.0.0.1',
  };

  console.log('Verifying session...');
  if (typeof paj.verify !== 'function') {
    console.error('paj_ramp.verify not found. Please ensure your paj_ramp version supports session verification.');
    process.exit(1);
  }
  const verified = await paj.verify(email, otp, deviceInfo, apiKey);
  console.log('Verification complete. Token details:');
  console.log({ email: verified.email, isActive: verified.isActive, expiresAt: verified.expiresAt });

  // Output the token plainly for copy/paste
  console.log('\nPAJ_VERIFICATION_TOKEN=');
  console.log(verified.token);

  console.log('\nYou can export this as an env var or place it into your .env as e.g. PAJ_TOKEN=...');
}

main().catch((err) => {
  console.error('Failed to obtain verification token:', err?.message || err);
  process.exit(1);
});
