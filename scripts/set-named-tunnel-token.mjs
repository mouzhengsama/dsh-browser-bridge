import { Entry } from '@napi-rs/keyring';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Resolves to the workspace root represented by .dsh-bridge/config.json.
const workspaceRoot = path.resolve(process.cwd(), '..');
const namespace = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 20);
const service = 'dsh-browser-bridge';

const token = process.env.NAMED_TUNNEL_TOKEN;
if (!token) {
  console.error('NAMED_TUNNEL_TOKEN env var is required');
  process.exit(2);
}

const key = process.env.KEY || 'cloudflare-tunnel-token';
const account = `${namespace}:${key}`;
const entry = new Entry(service, account);
entry.setPassword(token);
const readBack = new Entry(service, account).getPassword();
console.log(`service=${service}`);
console.log(`workspace=${workspaceRoot}`);
console.log(`namespace=${namespace}`);
console.log(`account=${account}`);
console.log(`readback_len=${readBack?.length ?? 0}`);
