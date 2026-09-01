import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defaultConfig } from '../src/config.js';
import {
  BridgeHttpServer,
  type BridgeHttpAccessEvent,
  type BridgeHttpCarrier,
} from '../src/http/server.js';
import { LocalWorkspaceAdapter } from '../src/workspace/adapter.js';

const servers: BridgeHttpServer[] = [];
const adapters: LocalWorkspaceAdapter[] = [];
const carriers: TestCarrier[] = [];
const allowedOrigin = 'https://workbuddy.cn';
const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {
      name: 'cors-test-client',
      version: '1.0.0',
    },
  },
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

class TestCarrier implements BridgeHttpCarrier {
  readonly host = '127.0.0.1' as const;
  readonly registeredPaths: string[] = [];
  disposeCount = 0;
  private route: Parameters<BridgeHttpCarrier['register']>[0] | undefined;
  private readonly server = createHttpServer((req, res) => this.handle(req, res));

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Carrier is not listening');
    return address.port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, this.host, resolve));
  }

  register(route: Parameters<BridgeHttpCarrier['register']>[0]): () => void {
    if (this.route) throw new Error('Route already registered');
    this.route = route;
    this.registeredPaths.push(route.path);
    return () => {
      if (this.route === route) {
        this.route = undefined;
        this.disposeCount += 1;
      }
    };
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => (
      error ? reject(error) : resolve()
    )));
    this.server.closeAllConnections();
    await closed;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://carrier.local').pathname;
    const route = this.route;
    if (route && (pathname === route.path || pathname.startsWith(`${route.path}/`))) {
      void route.handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) {
    throw new Error('No free port');
  }
  return port;
}

describe('BridgeHttpServer', () => {
  it('serves health and completes a real Streamable HTTP MCP handshake', async () => {
    const config = defaultConfig(process.cwd());
    config.port = await freePort();
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'test-secret',
    });
    servers.push(server);
    await server.start();

    const health = await fetch(`${server.localOrigin}${server.healthPath}`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      protocol: 'streamable-http',
      sessions: 0,
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('read_file');
    const response = await client.callTool({
      name: 'read_file',
      arguments: { path: 'package.json' },
    });
    expect(response.isError).not.toBe(true);
    await client.close();
  });

  it('requires the configured bearer token before health or MCP requests', async () => {
    const config = defaultConfig(process.cwd());
    config.port = await freePort();
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'auth-secret',
      bearerToken: 'test-token',
    });
    servers.push(server);
    await server.start();

    const unauthorized = await fetch(`${server.localOrigin}${server.healthPath}`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${server.localOrigin}${server.healthPath}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(authorized.status).toBe(200);
  });

  it('allows missing authorization only when secret-path mode is enabled', async () => {
    const config = defaultConfig(process.cwd());
    config.port = await freePort();
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'secret-path-auth',
      bearerToken: 'secret-path-token',
      allowSecretPathOnly: true,
    });
    servers.push(server);
    await server.start();

    const request = async (authorization?: string) => await fetch(
      `${server.localOrigin}${server.mcpPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(initializeRequest),
      },
    );

    await expect(request()).resolves.toMatchObject({ status: 200 });
    await expect(request('Bearer wrong-token')).resolves.toMatchObject({ status: 401 });
  });

  it('records sanitized access metadata without credentials or URLs', async () => {
    const config = defaultConfig(process.cwd());
    config.port = await freePort();
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const accessEvents: BridgeHttpAccessEvent[] = [];
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'logging-secret',
      bearerToken: 'secret-test-token',
      onAccessLog: (event) => accessEvents.push(event),
    });
    servers.push(server);
    await server.start();

    await fetch(`${server.localOrigin}${server.healthPath}`);
    await fetch(`${server.localOrigin}${server.healthPath}`, {
      headers: { Authorization: 'Bearer secret-test-token' },
    });

    expect(accessEvents).toHaveLength(2);
    expect(accessEvents[0]).toMatchObject({
      method: 'GET',
      status: 401,
      reason: 'response',
      hasAuthorization: false,
    });
    expect(accessEvents[1]).toMatchObject({
      method: 'GET',
      status: 200,
      reason: 'response',
      hasAuthorization: true,
    });
    expect(JSON.stringify(accessEvents)).not.toContain('secret-test-token');
    expect(JSON.stringify(accessEvents)).not.toContain('logging-secret');
  });

  it.each([
    { name: 'standalone HTTP server', carrier: false },
    { name: 'DSH HTTP carrier', carrier: true },
  ])('logs sanitized origin, user-agent and body method through the $name', async ({ carrier: useCarrier }) => {
    const carrier = useCarrier ? new TestCarrier() : undefined;
    if (carrier) {
      await carrier.start();
      carriers.push(carrier);
    }

    const config = defaultConfig(process.cwd());
    config.port = carrier?.port ?? await freePort();
    config.allowedOrigins = [allowedOrigin];
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const accessEvents: BridgeHttpAccessEvent[] = [];
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'origin-secret',
      bearerToken: 'origin-test-token',
      onAccessLog: (event) => accessEvents.push(event),
      ...(carrier ? { carrier } : {}),
    });
    servers.push(server);
    await server.start();

    const url = useCarrier
      ? `${carrierOrigin(carrier!)}${server.mcpPath}`
      : server.mcpUrl;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: 'Bearer origin-test-token',
        'User-Agent': 'kimi-test/1.0 (mcp connector)',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(response.status).toBe(200);

    const logged = accessEvents.find((event) => event.method === 'POST');
    expect(logged).toMatchObject({
      method: 'POST',
      status: 200,
      hasOrigin: true,
      originAllowed: true,
      origin: 'workbuddy.cn',
      userAgent: 'kimi-test/1.0 (mcp connector)',
      bodyMethod: 'initialize',
      hasAuthorization: true,
      hasSessionId: false,
    });
    expect(JSON.stringify(accessEvents)).not.toContain('origin-test-token');
    expect(JSON.stringify(accessEvents)).not.toContain('origin-secret');
  });

  it('uses a dsh HTTP carrier and removes its prefix route on stop', async () => {
    const carrier = new TestCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.port = carrier.port;
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'carrier-secret',
      carrier,
    });
    servers.push(server);

    await server.start();
    expect(carrier.registeredPaths).toEqual(['/mcp/carrier-secret']);
    expect(server.localOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const connectorOrigin = server.localOrigin;
    const carrierHealth = await fetch(`${carrierOrigin(carrier)}${server.healthPath}`);
    expect(await carrierHealth.json()).toEqual({
      ok: true,
      protocol: 'streamable-http',
      sessions: 0,
    });

    const client = new Client({ name: 'carrier-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('read_file');
    await client.close();

    const connectorHealth = await fetch(`${connectorOrigin}${server.healthPath}`);
    expect(await connectorHealth.json()).toMatchObject({
      ok: true,
      protocol: 'streamable-http',
    });
    const connectorClient = new Client({
      name: 'connector-client',
      version: '1.0.0',
    });
    await connectorClient.connect(
      new StreamableHTTPClientTransport(new URL(`${connectorOrigin}${server.mcpPath}`)),
    );
    expect((await connectorClient.listTools()).tools.map((tool) => tool.name))
      .toContain('read_file');
    await connectorClient.close();

    await server.stop();
    expect(carrier.disposeCount).toBe(1);
    expect((await fetch(`${carrierOrigin(carrier)}/mcp/carrier-secret/health`)).status).toBe(404);
  });

  it('falls back to an ephemeral connector port when the preferred port is busy', async () => {
    const carrier = new TestCarrier();
    await carrier.start();
    carriers.push(carrier);

    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === 'string') {
      throw new Error('Unable to determine occupied port');
    }

    try {
      const config = defaultConfig(process.cwd());
      config.port = carrier.port;
      const adapter = await LocalWorkspaceAdapter.create(config);
      adapters.push(adapter);
      const server = new BridgeHttpServer({
        config,
        adapter,
        secretPath: 'fallback-secret',
        carrier,
        localConnectorPort: occupiedAddress.port,
      });
      servers.push(server);

      await server.start();
      expect(server.localOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(new URL(server.localOrigin).port).not.toBe(String(occupiedAddress.port));

      const health = await fetch(`${server.localOrigin}${server.healthPath}`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        ok: true,
        protocol: 'streamable-http',
        sessions: 0,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it.each([
    { name: 'standalone HTTP server', carrier: false },
    { name: 'DSH HTTP carrier', carrier: true },
  ])('enforces CORS and bearer authentication through the $name', async ({ carrier: useCarrier }) => {
    const carrier = useCarrier ? new TestCarrier() : undefined;
    if (carrier) {
      await carrier.start();
      carriers.push(carrier);
    }

    const config = defaultConfig(process.cwd());
    config.port = carrier?.port ?? await freePort();
    config.allowedOrigins = [allowedOrigin];
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: useCarrier ? 'carrier-cors-secret' : 'standalone-cors-secret',
      bearerToken: 'cors-token',
      ...(carrier ? { carrier } : {}),
    });
    servers.push(server);
    await server.start();

    const preflight = await fetch(server.mcpUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, mcp-session-id',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(preflight.headers.get('vary')).toBe('Origin');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET, POST, DELETE, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id');
    expect(preflight.headers.get('access-control-expose-headers')).toContain('Mcp-Session-Id');
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

    const rejectedPreflight = await fetch(server.mcpUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(rejectedPreflight.status).toBe(403);

    const unauthorized = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('access-control-allow-origin')).toBe(allowedOrigin);

    const initialized = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: 'Bearer cors-token',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(initialized.headers.get('access-control-expose-headers')).toContain('Mcp-Session-Id');
    expect(initialized.headers.get('mcp-session-id')).toBeTruthy();
    await expect(readJsonRpcResponse(initialized)).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: expect.any(Object),
    });
  });

  it.each([
    { name: 'standalone HTTP server', carrier: false },
    { name: 'DSH HTTP carrier', carrier: true },
  ])('serves protected-resource OAuth discovery through the $name', async ({ carrier: useCarrier }) => {
    const carrier = useCarrier ? new TestCarrier() : undefined;
    if (carrier) {
      await carrier.start();
      carriers.push(carrier);
    }

    const config = defaultConfig(process.cwd());
    config.port = carrier?.port ?? await freePort();
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: useCarrier ? 'carrier-oauth-secret' : 'standalone-oauth-secret',
      bearerToken: 'oauth-discovery-token',
      ...(carrier ? { carrier } : {}),
    });
    servers.push(server);
    await server.start();

    const origin = useCarrier ? carrierOrigin(carrier!) : new URL(server.mcpUrl).origin;
    const metadataUrl = `${origin}${server.oauthResourceMetadataPath}`;
    const metadata = await fetch(metadataUrl, {
      headers: { Authorization: 'Bearer oauth-discovery-token' },
    });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-type')).toContain('application/json');
    expect(await metadata.json()).toEqual({
      resource: `${origin}${server.mcpPath}`,
      authorization_servers: [origin],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}${server.mcpPath}`,
    });

    const invalidCredential = await fetch(metadataUrl, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(invalidCredential.status).toBe(401);

    const outsideCapability = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    expect(outsideCapability.status).toBe(404);

    const unauthorized = await fetch(`${origin}${server.healthPath}`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      `Bearer, resource_metadata="${metadataUrl}"`,
    );
  });
});

function carrierOrigin(carrier: TestCarrier): string {
  return `http://${carrier.host}:${carrier.port}`;
}

async function readJsonRpcResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const payload = body
      .split(/\r?\n/)
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (!payload) {
      throw new Error('MCP SSE response did not contain a data payload');
    }
    return JSON.parse(payload) as unknown;
  }
  return JSON.parse(body) as unknown;
}
