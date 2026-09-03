import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defaultConfig } from '../src/config.js';
import {
  createAccessToken,
  OAuthRefreshTokenStore,
  verifyAccessToken,
} from '../src/http/oauth-tokens.js';
import {
  BridgeHttpServer,
  type BridgeHttpAccessEvent,
  type BridgeHttpCarrier,
} from '../src/http/server.js';
import { LocalWorkspaceAdapter } from '../src/workspace/adapter.js';
import { MemorySecretStore } from '../src/security/secrets.js';

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
  private routes: Array<Parameters<BridgeHttpCarrier['register']>[0]> = [];
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
    const duplicate = this.routes.find((entry) => entry.kind === route.kind && entry.path === route.path);
    if (duplicate) throw new Error(`Duplicate carrier route for ${route.kind} ${route.path}`);
    this.routes.push(route);
    this.registeredPaths.push(route.path);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = this.routes.indexOf(route);
      if (index >= 0) {
        this.routes.splice(index, 1);
        this.disposeCount += 1;
      }
    };
  }

  private match(pathname: string): Parameters<BridgeHttpCarrier['register']>[0] | undefined {
    for (const route of this.routes) {
      if (route.kind === 'path') {
        if (pathname === route.path) return route;
      } else if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
        return route;
      }
    }
    return undefined;
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
    const route = this.match(pathname);
    if (route) {
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
  it('protects the local OAuth pairing endpoint', async () => {
    const config = defaultConfig(process.cwd());
    config.capabilities = {
      ...config.capabilities,
      write: false,
      command: false,
    };
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'local-pairing-secret',
      bearerToken: 'local-pairing-bearer',
      localConnectorPort: 0,
      localPairingToken: 'local-pairing-token',
    });
    servers.push(server);
    await server.start();

    const endpoint = `http://127.0.0.1:${server.localConnector.port}/__local/oauth/pairing`;
    const missing = await fetch(endpoint, { method: 'POST' });
    expect(missing.status).toBe(401);
    await missing.body?.cancel();

    const wrong = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);
    await wrong.body?.cancel();

    const browser = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer local-pairing-token',
        Origin: 'https://chatgpt.com',
      },
    });
    expect(browser.status).toBe(403);
    await browser.body?.cancel();

    const valid = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-pairing-token' },
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      code: expect.stringMatching(/^[0-9A-Z]{8}$/),
    });
  });
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
      reason: 'bearer-invalid',
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
    expect(carrier.registeredPaths.sort()).toEqual([
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource/mcp/carrier-secret',
      '/.well-known/openid-configuration',
      '/mcp/carrier-secret',
      '/oauth/authorize',
      '/oauth/register',
      '/oauth/revoke',
      '/oauth/token',
    ]);
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
    expect(carrier.disposeCount).toBe(11);
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

  it('rejects a fixed Named Tunnel connector port owned by the DSH WebServer', async () => {
    const carrier = new TestCarrier();
    await carrier.start();
    carriers.push(carrier);

    const config = defaultConfig(process.cwd());
    config.port = carrier.port;
    config.tunnel.provider = 'cloudflare-named';
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'conflicting-connector-secret',
      carrier,
      localConnectorPort: carrier.port,
    });

    await expect(server.start()).rejects.toThrow(/conflicts with the DSH WebServer port/u);
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
      headers: { Accept: 'application/json' },
    });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('content-type')).toContain('application/json');
    expect(await metadata.json()).toEqual({
      resource: `${origin}${server.mcpPath}`,
      authorization_servers: [origin],
      scopes_supported: ['mcp:tools', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'DSH Browser Bridge',
      resource_documentation: `${origin}${server.mcpPath}`,
    });

    const rootMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    expect(rootMetadata.status).toBe(200);
    expect(await rootMetadata.json()).toEqual({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['mcp:tools', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'DSH Browser Bridge',
      resource_documentation: `${origin}/mcp`,
    });

    const publicOrigin = 'https://mcp.example.com';
    const forwarded = await fetch(metadataUrl, {
      headers: {
        Accept: 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'mcp.example.com',
      },
    });
    expect(forwarded.status).toBe(200);
    expect(await forwarded.json()).toEqual({
      resource: `${publicOrigin}${server.mcpPath}`,
      authorization_servers: [publicOrigin],
      scopes_supported: ['mcp:tools', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'DSH Browser Bridge',
      resource_documentation: `${publicOrigin}${server.mcpPath}`,
    });

    const unauthorized = await fetch(`${origin}${server.healthPath}`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe(
      `Bearer, resource_metadata="${metadataUrl}"`,
    );
  });

  it.each([
    { name: 'standalone HTTP server', carrier: false },
    { name: 'DSH HTTP carrier', carrier: true },
  ])('supports dynamic OAuth registration, PKCE, and MCP access through the $name', async ({ carrier: useCarrier }) => {
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
      secretPath: useCarrier ? 'carrier-oauth-flow' : 'standalone-oauth-flow',
      bearerToken: 'oauth-flow-token',
      oauthSigningKey: 'oauth-flow-signing-key',
      ...(carrier ? { carrier } : {}),
    });
    servers.push(server);
    await server.start();

    const origin = useCarrier ? carrierOrigin(carrier!) : new URL(server.mcpUrl).origin;
    const endpoint = (path: string) => `${origin}${path}`;
    const discovery = await fetch(endpoint(server.oauthAuthorizationServerPath));
    expect(discovery.status).toBe(200);
    const discoveryPayload = await discovery.json() as Record<string, string>;
    expect(discoveryPayload.issuer).toBe(origin);
    expect(discoveryPayload.authorization_endpoint).toBe(endpoint('/oauth/authorize'));
    expect(discoveryPayload.token_endpoint).toBe(endpoint('/oauth/token'));
    expect(discoveryPayload.registration_endpoint).toBe(endpoint('/oauth/register'));

    const redirectUri = 'https://client.example/callback';
    const registration = await fetch(endpoint(server.oauthRegisterPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: 'OAuth flow test client',
      }),
    });
    expect(registration.status).toBe(200);
    const clientId = (await registration.json() as { client_id: string }).client_id;
    expect(clientId).toMatch(/^[0-9a-f]{32}$/);

    const verifier = 'test-code-verifier-with-sufficient-entropy-1234567890';
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // GET authorize stores OAuth state and returns a pairing-code form.
    const consentUrl = new URL(endpoint(server.oauthAuthorizePath));
    consentUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'oauth-state',
    }).toString();
    const consentPage = await fetch(consentUrl, { redirect: 'manual' });
    expect(consentPage.status).toBe(200);
    const consentHtml = await consentPage.text();
    expect(consentHtml).toContain('pairing_code');
    const requestId = consentHtml.match(/name="request_id" value="([0-9a-f]{32})"/)?.[1];
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);

    const { code: pairingCode } = server.createOAuthPairingCode();
    const authorize = (submittedCode: string) => fetch(endpoint(server.oauthAuthorizePath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId!,
        pairing_code: submittedCode,
      }),
      redirect: 'manual',
    });

    // A wrong pairing code leaves the pending request alive for retry.
    const rejected = await authorize('00000000');
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as { error: string }).error).toBe('invalid_grant');

    const authorization = await authorize(pairingCode);
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get('location')!);
    expect(callback.origin).toBe(new URL(redirectUri).origin);
    expect(callback.searchParams.get('state')).toBe('oauth-state');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await fetch(endpoint(server.oauthTokenPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokenPayload = await token.json() as Record<string, unknown>;
    expect(typeof tokenPayload.access_token).toBe('string');
    expect((tokenPayload.access_token as string).split('.')).toHaveLength(3);
    expect(tokenPayload.token_type).toBe('Bearer');
    expect(tokenPayload.expires_in).toBe(900);
    expect(typeof tokenPayload.refresh_token).toBe('string');
    expect(tokenPayload.scope).toBe('mcp:tools offline_access');
  });

  it.each([
    { name: 'standalone HTTP server', carrier: false },
    { name: 'DSH HTTP carrier', carrier: true },
  ])('validates OAuth JWT audience, expiry, and bearer compatibility through the $name', async ({ carrier: useCarrier }) => {
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
      secretPath: useCarrier ? 'carrier-jwt-secret' : 'standalone-jwt-secret',
      bearerToken: 'static-bearer',
      allowSecretPathOnly: true,
      oauthSigningKey: 'jwt-signing-key',
      ...(carrier ? { carrier } : {}),
    });
    servers.push(server);
    await server.start();
    const origin = useCarrier ? carrierOrigin(carrier!) : new URL(server.mcpUrl).origin;
    const endpoint = `${origin}${server.mcpPath}`;
    const issuer = origin;

    const validToken = createAccessToken({
      signingKey: 'jwt-signing-key',
      issuer,
      audience: endpoint,
      subject: 'oauth-client',
      scopes: ['mcp:tools'],
    });
    const valid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${validToken}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(valid.status).toBe(200);
    expect(valid.headers.get('mcp-session-id')).toBeTruthy();
    await valid.body?.cancel();

    const expiredToken = createAccessToken({
      signingKey: 'jwt-signing-key',
      issuer,
      audience: endpoint,
      subject: 'oauth-client',
      scopes: ['mcp:tools'],
      lifetimeSeconds: -1,
    });
    const expired = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${expiredToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(expired.status).toBe(401);

    const wrongAudienceToken = createAccessToken({
      signingKey: 'jwt-signing-key',
      issuer,
      audience: `${origin}/mcp/another-secret`,
      subject: 'oauth-client',
      scopes: ['mcp:tools'],
    });
    const wrongAudience = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: `Bearer ${wrongAudienceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(wrongAudience.status).toBe(401);

    const staticBearer = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: 'Bearer static-bearer',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(staticBearer.status).toBe(200);
    await staticBearer.body?.cancel();

    const invalidBearer = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Origin: allowedOrigin,
        Authorization: 'Bearer invalid-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(invalidBearer.status).toBe(401);

    expect(verifyAccessToken(
      'jwt-signing-key',
      validToken,
      issuer,
      endpoint,
      Math.floor(Date.now() / 1000) + 899,
    )).toMatchObject({ iss: issuer, aud: endpoint });
  });

  it('rejects refresh-token replay', () => {
    const store = new OAuthRefreshTokenStore();
    const token = store.create({
      clientId: 'client-id',
      resource: 'https://bridge.example/mcp/secret',
      scopes: ['mcp:tools'],
    });
    expect(store.consume(token)).toMatchObject({ clientId: 'client-id' });
    expect(store.consume(token)).toBeUndefined();
  });

  it('persists OAuth clients and refresh tokens across server restarts', async () => {
    const secrets = new MemorySecretStore();
    const config = defaultConfig(process.cwd());
    config.port = await freePort();
    config.allowedOrigins = [allowedOrigin];
    const adapter = await LocalWorkspaceAdapter.create(config);
    adapters.push(adapter);
    const server = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'persisted-oauth-secret',
      bearerToken: 'persisted-oauth-static-bearer',
      oauthSigningKey: 'persisted-oauth-signing-key',
      oauthSecretStore: secrets,
    });
    servers.push(server);
    await server.start();

    const redirectUri = 'https://persisted-client.example/callback';
    const registration = await fetch(`${server.localOrigin}${server.oauthRegisterPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: 'Persisted OAuth client',
      }),
    });
    expect(registration.status).toBe(200);
    const { client_id: clientId } = await registration.json() as { client_id: string };

    // Generate a refresh token directly through the public flow helpers.
    const verifier = 'persisted-oauth-verifier-with-sufficient-entropy-1234567890';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const consentUrl = new URL(`${server.localOrigin}${server.oauthAuthorizePath}`);
    consentUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'restart-test',
    }).toString();
    const consentPage = await fetch(consentUrl, { redirect: 'manual' });
    expect(consentPage.status).toBe(200);
    const consentHtml = await consentPage.text();
    const requestId = consentHtml.match(/name="request_id" value="([0-9a-f]{32})"/)?.[1];
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    const pairing = server.createOAuthPairingCode();
    const authorization = await fetch(`${server.localOrigin}${server.oauthAuthorizePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_id: requestId!,
        pairing_code: pairing.code,
      }),
      redirect: 'manual',
    });
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get('location')!);
    const authorizationCode = callback.searchParams.get('code');
    expect(authorizationCode).toBeTruthy();
    const tokenResponse = await fetch(`${server.localOrigin}${server.oauthTokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode!,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const firstTokens = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
    };

    // Simulate a process restart with the same durable secret store.
    await server.stop();
    const restartedServer = new BridgeHttpServer({
      config,
      adapter,
      secretPath: 'persisted-oauth-secret',
      bearerToken: 'persisted-oauth-static-bearer',
      oauthSigningKey: 'persisted-oauth-signing-key',
      oauthSecretStore: secrets,
    });
    servers.push(restartedServer);
    await restartedServer.start();

    const refreshRequest = () => fetch(`${restartedServer.localOrigin}${restartedServer.oauthTokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: firstTokens.refresh_token,
        client_id: clientId,
      }),
    });
    let refreshed: Response | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        refreshed = await refreshRequest();
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(refreshed).toBeDefined();
    expect(refreshed!.status).toBe(200);
    const refreshedTokens = await refreshed!.json() as { refresh_token: string };

    const replay = await fetch(`${restartedServer.localOrigin}${restartedServer.oauthTokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: firstTokens.refresh_token,
        client_id: clientId,
      }),
    });
    expect(replay.status).toBe(400);

    const revoked = await fetch(`${restartedServer.localOrigin}${restartedServer.oauthRevokePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshedTokens.refresh_token,
      }),
    });
    expect(revoked.status).toBe(200);

    const afterRevoke = await fetch(`${restartedServer.localOrigin}${restartedServer.oauthTokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshedTokens.refresh_token,
        client_id: clientId,
      }),
    });
    expect(afterRevoke.status).toBe(400);
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
