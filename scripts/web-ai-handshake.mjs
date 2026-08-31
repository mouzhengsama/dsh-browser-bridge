#!/usr/bin/env node
import process from 'node:process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);
const SERVICE_NAME = 'dsh-browser-bridge';

function argumentValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name) {
  return args.includes(name);
}

function usage() {
  console.error([
    'Usage:',
    '  node scripts/web-ai-handshake.mjs --port <bridge port> [--workspace <root>] [--write] [--cleanup]',
    '',
    'The script reads secrets from the local OS keyring. --write enables a',
    'single-file patch, and --cleanup removes that file through run_command.',
  ].join('\n'));
  process.exit(1);
}

const workspace = path.resolve(argumentValue('--workspace') ?? process.cwd());
const namespace = createHash('sha256')
  .update(workspace)
  .digest('hex')
  .slice(0, 20);

function readSecret(key) {
  return new Entry(SERVICE_NAME, `${namespace}:${key}`).getPassword() ?? undefined;
}

const pathSecret = readSecret('mcp-path-secret');
const bearerToken = readSecret('bearer-token');
if (!pathSecret) {
  console.error(`keyring: mcp-path-secret not found for workspace: ${workspace}`);
  process.exit(1);
}

const port = Number(argumentValue('--port'));
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  usage();
}

const allowWrite = hasFlag('--write');
const cleanup = hasFlag('--cleanup');
if (cleanup && !allowWrite) {
  usage();
}

const mcpUrl = `http://127.0.0.1:${port}/mcp/${encodeURIComponent(pathSecret)}`;
const headers = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers },
});
const client = new Client({ name: 'dsh-browser-bridge-handshake', version: '0.1.0' });

function text(result) {
  return result.content?.find((block) => block.type === 'text')?.text ?? '';
}

try {
  await client.connect(transport);
  console.log('connect: ok');
  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((tool) => tool.name).sort().join(', ')}`);
  const info = await client.callTool({ name: 'bridge_info', arguments: {} });
  console.log(`bridge_info: ${JSON.stringify(info, null, 2)}`);
  const file = 'package.json';
  const read = await client.callTool({ name: 'read_file', arguments: { path: file } });
  console.log(`read_file(${file}): ${text(read).slice(0, 80).replace(/\s+/g, ' ')}`);

  if (!allowWrite) {
    console.log('bridge_info: ok');
  } else {
    const marker = `dsh-browser-bridge-handshake-${Date.now()}`;
    const patch = [
      '--- /dev/null',
      '+++ b/dsh-browser-bridge-handshake.txt',
      '@@ -0,0 +1 @@',
      `+${marker}`,
    ].join('\n') + '\n';
    const write = await client.callTool({ name: 'apply_patch', arguments: { patch } });
    if (write.isError) {
      throw new Error(text(write));
    }
    const verify = await client.callTool({
      name: 'read_file',
      arguments: { path: 'dsh-browser-bridge-handshake.txt' },
    });
    if (!text(verify).includes(marker)) {
      throw new Error('write verification failed');
    }
    console.log('write: ok');

    if (cleanup) {
      const command = await client.callTool({
        name: 'run_command',
        arguments: {
          command: process.platform === 'win32'
            ? 'del /q dsh-browser-bridge-handshake.txt'
            : 'rm -f dsh-browser-bridge-handshake.txt',
          waitMs: 10000,
        },
      });
      if (command.isError) {
        throw new Error(text(command));
      }
      console.log('cleanup: ok');
    }
  }
} finally {
  await client.close();
}
