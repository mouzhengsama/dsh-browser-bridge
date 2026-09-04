import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import type { BridgeHttpCarrier } from '../src/http/server.js';
import { BUILT_IN_ORIGINS } from '../src/links.js';
import { BridgeRuntime } from '../src/runtime.js';
import { MemorySecretStore } from '../src/security/secrets.js';
import { parseProxyTarget } from '../src/tunnel/manager.js';
import type { WorkspaceAdapter } from '../src/types.js';
import type { TunnelManager, TunnelHandle } from '../src/tunnel/manager.js';

class RuntimeCarrier implements BridgeHttpCarrier {
  readonly host = '127.0.0.1' as const;
 disposedRoutes = 0;
  private routes: Array<Parameters<BridgeHttpCarrier['register']>[0]> = [];
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
    const duplicate = this.routes.find((entry) => entry.kind === route.kind && entry.path === route.path);
    if (duplicate) throw new Error(`Duplicate carrier route for ${route.kind} ${route.path}`);
    this.routes.push(route);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = this.routes.indexOf(route);
      if (index >= 0) {
        this.routes.splice(index, 1);
        this.disposedRoutes += 1;
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

describe('parseProxyTarget', () => {
  it('parses an HTTP proxy URL with host and port', () => {
    const result = parseProxyTarget('http://127.0.0.1:7897');
    expect(result).toEqual({
      host: '127.0.0.1',
      port: 7897,
      protocol: 'http:',
      authorization: undefined,
    });
  });

  it('parses an HTTPS proxy URL with host and port', () => {
    const result = parseProxyTarget('https://127.0.0.1:7897');
    expect(result).toEqual({
      host: '127.0.0.1',
      port: 7897,
      protocol: 'https:',
      authorization: undefined,
    });
  });

  it('parses an HTTP proxy URL with Basic auth', () => {
    const result = parseProxyTarget('http://user:pass@127.0.0.1:7897');
    expect(result).toMatchObject({
      host: '127.0.0.1',
      port: 7897,
      protocol: 'http:',
    });
    expect(result?.authorization).toMatch(/^Basic /);
  });

  it('returns undefined for unsupported protocols', () => {
    expect(parseProxyTarget('socks5://127.0.0.1:1080')).toBeUndefined();
    expect(parseProxyTarget('ftp://127.0.0.1:21')).toBeUndefined();
  });

  it('returns undefined for malformed URLs', () => {
    expect(parseProxyTarget('not-a-url')).toBeUndefined();
    expect(parseProxyTarget('')).toBeUndefined();
  });
});

function fakeAdapter(dispose = vi.fn(async () => undefined)): WorkspaceAdapter {
  return {
    workspaceRoot: process.cwd(),
    dispose,
  } as unknown as WorkspaceAdapter;
}

function patchRuntimeTunnel(runtime: BridgeRuntime, tunnel: Partial<TunnelHandle>): void {
  const tunnelManagerStub = {
    start: async (): Promise<TunnelHandle> => ({
      provider: 'cloudflare-named',
      publicOrigin: 'https://public-health.test',
      ...(tunnel.waitForExit ? { waitForExit: tunnel.waitForExit } : {}),
      close: async () => undefined,
    }),
    stop: async () => undefined,
  };
  Object.defineProperty(runtime, 'tunnel', {
    configurable: true,
    get: () => tunnelManagerStub,
    set: () => undefined,
  });
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
    expect(await runtime.getConnectionInfo()).not.toHaveProperty('localPairingToken');
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
   expect(carrier.disposedRoutes).toBe(11);
  });

  it('marks the runtime failed when a verified tunnel exits unexpectedly', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'cloudflare-named';
    config.tunnel.cloudflareNamedDomain = 'public-health.test';
    config.tunnel.publicHealthTimeoutMs = 1_000;
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
      tunnelFactory: () => ({
        start: async (): Promise<TunnelHandle> => ({
          provider: 'cloudflare-named',
          publicOrigin: 'https://public-health.test',
          waitForExit: () => Promise.resolve({ code: 19, signal: null }),
          close: async () => undefined,
        }),
        stop: async () => undefined,
      }) as unknown as TunnelManager,
    });
    runtimes.push(runtime);

    await expect(runtime.start()).resolves.toMatchObject({
      state: 'running',
      publicOrigin: 'https://public-health.test',
    });
    await vi.waitFor(() => {
      expect(runtime.status.state).toBe('failed');
      expect(runtime.status.error).toContain('Tunnel exited unexpectedly');
    });
    await vi.waitFor(() => {
      expect(carrier.disposedRoutes).toBeGreaterThan(0);
    });
  });

  it('tolerates transient public health failures before failing a verified tunnel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'cloudflare-named';
    config.tunnel.cloudflareNamedDomain = 'public-health.test';
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
      tunnelFactory: () => ({
        start: async (): Promise<TunnelHandle> => ({
          provider: 'cloudflare-named',
          publicOrigin: 'https://public-health.test',
          close: async () => undefined,
        }),
      }) as unknown as TunnelManager,
    });
    runtimes.push(runtime);

    let publicHealthAvailable = true;
    const runtimeWithProbe = runtime as unknown as {
      waitForHealth: (url: string, timeoutMs: number, bearerToken?: string) => Promise<void>;
      probeCount: number;
    };
    Object.defineProperty(runtimeWithProbe, 'probeCount', {
      configurable: true,
      writable: true,
      value: 0,
    });
    vi.spyOn(runtimeWithProbe, 'waitForHealth').mockImplementation(async () => {
      runtimeWithProbe.probeCount += 1;
      if (!publicHealthAvailable) throw new Error('probe failed');
    });

    await expect(runtime.start()).resolves.toMatchObject({
      state: 'running',
      publicOrigin: 'https://public-health.test',
    });

    try {
      publicHealthAvailable = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.status.state).toBe('running');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtime.status.state).toBe('running');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtimeWithProbe.probeCount).toBe(4);
      expect(runtime.status.state).toBe('failed');
      expect(runtime.status.error).toContain('probe failed');
    } finally {
      vi.useRealTimers();
    }
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

  it('validates and clears the cloudflared HTTP proxy setting', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'none';
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    await expect(runtime.updateConfig({
      tunnel: { cloudflaredHttpProxy: 'not-a-url' },
    })).rejects.toThrow('cloudflared HTTP proxy must be a valid URL');

    await expect(runtime.updateConfig({
      tunnel: { cloudflaredHttpProxy: 'http://127.0.0.1:7897' },
    })).rejects.toThrow(
      'Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together',
    );

    await expect(runtime.updateConfig({
      tunnel: {
        cloudflaredHttpProxy: 'http://127.0.0.1:7897',
        cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844',
      },
    })).resolves.toMatchObject({
      tunnel: {
        cloudflaredHttpProxy: 'http://127.0.0.1:7897',
        cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844',
      },
    });

    await expect(runtime.updateConfig({
      tunnel: { cloudflaredHttpProxy: '' },
    })).rejects.toThrow(
      'Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together',
    );

    await expect(runtime.updateConfig({
      tunnel: { cloudflaredHttpProxy: '', cloudflareEdgeAuthority: '' },
    })).resolves.toMatchObject({
      tunnel: { cloudflaredHttpProxy: '' },
    });
    expect(config.tunnel.cloudflaredHttpProxy).toBeUndefined();
  });

  it('validates and clears the Cloudflare Edge authority setting', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'none';
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    await expect(runtime.updateConfig({
      tunnel: { cloudflareEdgeAuthority: 'not-host-port' },
    })).rejects.toThrow('Cloudflare Edge authority must be host:port');

    await expect(runtime.updateConfig({
      tunnel: { cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844' },
    })).rejects.toThrow(
      'Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together',
    );

    await expect(runtime.updateConfig({
      tunnel: {
        cloudflaredHttpProxy: 'http://127.0.0.1:7897',
        cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844',
      },
    })).resolves.toMatchObject({
      tunnel: { cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844' },
    });

    await expect(runtime.updateConfig({
      tunnel: { cloudflaredHttpProxy: '', cloudflareEdgeAuthority: '' },
    })).resolves.toMatchObject({
      tunnel: { cloudflareEdgeAuthority: '' },
    });
    expect(config.tunnel.cloudflareEdgeAuthority).toBeUndefined();
  });

  it('validates and clears the localtunnel HTTP proxy setting', async () => {
    const carrier = new RuntimeCarrier();
    await carrier.start();
    carriers.push(carrier);
    const config = defaultConfig(process.cwd());
    config.host = carrier.host;
    config.port = carrier.port;
    config.tunnel.provider = 'none';
    const runtime = new BridgeRuntime({
      config,
      secrets: new MemorySecretStore(),
      adapter: fakeAdapter(),
      httpCarrier: carrier,
    });
    runtimes.push(runtime);

    await expect(runtime.updateConfig({
      tunnel: { localtunnelHttpProxy: 'not-a-url' },
    })).rejects.toThrow('localtunnel HTTP proxy must be a valid URL');

    await expect(runtime.updateConfig({
      tunnel: { localtunnelHttpProxy: 'http://127.0.0.1:7897' },
    })).resolves.toMatchObject({
      tunnel: { localtunnelHttpProxy: 'http://127.0.0.1:7897' },
    });

    await expect(runtime.updateConfig({
      tunnel: { localtunnelHttpProxy: '' },
    })).resolves.toMatchObject({
      tunnel: { localtunnelHttpProxy: '' },
    });
    expect(config.tunnel.localtunnelHttpProxy).toBeUndefined();
  });
});
