import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import type { BridgeHttpCarrier } from '../src/http/server.js';
import { BUILT_IN_ORIGINS } from '../src/links.js';
import { BridgeRuntime } from '../src/runtime.js';
import { MemorySecretStore } from '../src/security/secrets.js';
import type { WorkspaceAdapter } from '../src/types.js';

class RuntimeCarrier implements BridgeHttpCarrier {
  readonly host = '127.0.0.1' as const;
  disposedRoutes = 0;
  private route: Parameters<BridgeHttpCarrier['register']>[0] | undefined;
  private readonly server = createServer((req, res) => this.handle(req, res));

  constructor(private readonly requireHostAccess = false) {}

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Carrier is not listening');
    return address.port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, this.host, resolve));
  }

  register(route: Parameters<BridgeHttpCarrier['register']>[0]): () => void {
    if (this.route) throw new Error('Duplicate carrier route');
    this.route = route;
    return () => {
      if (this.route === route) {
        this.route = undefined;
        this.disposedRoutes += 1;
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
      if (
        this.requireHostAccess
        && pathname === `${route.path}/health`
        && req.headers['x-dsh-test-access'] !== 'ok'
      ) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      void route.handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

const runtimes: BridgeRuntime[] = [];
const carriers: RuntimeCarrier[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(carriers.splice(0).map((carrier) => carrier.close()));
});

function fakeAdapter(dispose = vi.fn(async () => undefined)): WorkspaceAdapter {
  return {
    workspaceRoot: process.cwd(),
    dispose,
  } as unknown as WorkspaceAdapter;
}

describe('BridgeRuntime', () => {
  it('treats a registered carrier route as locally ready without probing through host auth', async () => {
    const carrier = new RuntimeCarrier(true);
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.requireBearerToken = true;
    config.tunnel.provider = 'none';
    config.tunnel.publicHealthTimeoutMs = 250;
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    await expect(runtime.start()).resolves.toMatchObject({
      state: 'running',
      tunnelProvider: 'none',
    });
  });

  it('withholds credentials until running, rotates its path, and disposes once', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.requireBearerToken = true;
    config.tunnel.provider = 'none';
    config.tunnel.publicHealthTimeoutMs = 2_000;
    const secrets = new MemorySecretStore();
    const disposeAdapter = vi.fn(async () => undefined);
    const runtime = new BridgeRuntime({
      config,
      secrets,
      adapter: fakeAdapter(disposeAdapter),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    expect(await runtime.getConnectionInfo()).toMatchObject({
      state: 'stopped',
      tunnelProvider: 'none',
    });
    expect(await runtime.getConnectionInfo()).not.toHaveProperty('mcpUrl');
    expect(await runtime.getConnectionInfo()).not.toHaveProperty('bearerToken');

    const running = await runtime.start();
    const firstPath = secrets.values.get('mcp-path-secret');
    const token = secrets.values.get('bearer-token');
    expect(running.state).toBe('running');
    expect(firstPath).toBeTruthy();
    expect(token).toBeTruthy();
    expect(running.mcpUrl).toContain(`/mcp/${firstPath}`);
    expect(await runtime.getConnectionInfo()).toMatchObject({
      state: 'running',
      mcpUrl: running.mcpUrl,
      bearerToken: token,
    });
    expect((await fetch(running.healthUrl!, {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);

    await runtime.resetPath();
    expect(runtime.status.state).toBe('stopped');
    expect(secrets.values.has('mcp-path-secret')).toBe(false);
    const oldHealth = await fetch(running.healthUrl!, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    expect(oldHealth === undefined || oldHealth.status !== 200).toBe(true);

    const restarted = await runtime.start();
    expect(secrets.values.get('mcp-path-secret')).not.toBe(firstPath);
    expect(restarted.mcpUrl).not.toBe(running.mcpUrl);
    await runtime.dispose();
    await runtime.dispose();
    expect(disposeAdapter).toHaveBeenCalledTimes(1);
    await expect(runtime.start()).rejects.toThrow(/disposed/i);
  });

  it('cleans up the carrier route when tunnel startup fails', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'cloudflare';
    config.tunnel.cloudflaredPath = `missing-cloudflared-${Date.now()}`;
    config.tunnel.startupTimeoutMs = 250;
    config.tunnel.publicHealthTimeoutMs = 1_000;
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    await expect(runtime.start()).rejects.toThrow(/Cloudflare Quick Tunnel/i);
    expect(runtime.status.state).toBe('failed');
    expect(carrier.disposedRoutes).toBe(1);
  });

  it('persists editable tunnel settings without placing a named tunnel token in config', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'cloudflare';
    const secrets = new MemorySecretStore();
    const save = vi.fn(async () => undefined);
    const runtime = new BridgeRuntime({
      config,
      secrets,
      adapter: fakeAdapter(),
      httpCarrier: carrier,
      onConfigChanged: save,
    });
    runtimes.push(runtime);

    await expect(runtime.updateConfig({
      tunnel: {
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'https://mcp.example.com/',
        cloudflareNamedToken: 'named-token',
      },
    })).resolves.toMatchObject({
      editable: true,
      tunnel: {
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
        cloudflareNamedTokenConfigured: true,
      },
    });
    expect(secrets.values.get('cloudflare-tunnel-token')).toBe('named-token');
    expect(JSON.stringify(config)).not.toContain('named-token');
    expect(save).toHaveBeenCalledWith(config);

    await expect(runtime.updateConfig({ allowSecretPathOnly: true })).resolves.toMatchObject({
      editable: true,
      allowSecretPathOnly: true,
    });
    expect(config.allowSecretPathOnly).toBe(true);
    expect(save).toHaveBeenCalledWith(config);

    const localSnapshot = await runtime.updateConfig({
      allowedOrigins: ['https://custom.example'],
      tunnel: { provider: 'none' },
    });
    expect(localSnapshot.allowedOrigins).toEqual([
      'https://custom.example',
      ...BUILT_IN_ORIGINS,
    ]);
    await expect(runtime.updateConfig({
      allowedOrigins: ['https://evil.example/path'],
      tunnel: {},
    })).rejects.toThrow('Invalid allowed origin');
    await runtime.start();
    await expect(runtime.updateConfig({
      tunnel: { provider: 'cloudflare' },
    })).rejects.toThrow(/Stop Bridge before changing/i);
  });
});
