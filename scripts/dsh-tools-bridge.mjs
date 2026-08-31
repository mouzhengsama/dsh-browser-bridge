#!/usr/bin/env node
import process from 'node:process';
import {
  CallToolRequestSchema,
  Client,
  ListToolsRequestSchema,
  StdioClientTransport,
} from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);

function argumentValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  console.error('Usage: node scripts/dsh-tools-bridge.mjs --port <dsh web server port>');
  process.exit(1);
}

const portValue = argumentValue('--port');
const port = Number(portValue);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  usage();
}

const mcpUrl = `http://127.0.0.1:${port}/mcp`;

const upstream = new Client({
  name: 'dsh-browser-bridge-tools-proxy',
  version: '0.1.0',
});

const upstreamTransport = new StreamableHTTPClientTransport(new URL(mcpUrl));
await upstream.connect(upstreamTransport);

const server = new Server(
  { name: 'dsh-browser-bridge-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools();
  return { tools: tools.filter((tool) => tool.name.startsWith('bridge_')) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!request.params.name.startsWith('bridge_')) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  return await upstream.callTool(request.params);
});

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.allSettled([upstream.close(), server.close()]);
    process.exit(0);
  });
}
