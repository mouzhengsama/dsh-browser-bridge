import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { get } from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../src/security/secrets.js';
import {
  spawnTunnelProcess,
  TunnelManager,
  type TunnelProcess,
} from '../src/tunnel/manager.js';
import type { TunnelConfig } from '../src/types.js';

function fakeProcess(lines: string[]): TunnelProcess {
  const script = [
    ...lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`),
    'setTimeout(() => {}, 10_000);',
  ].join('');
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = (async function* (): AsyncGenerator<string> {
    let pending = '';
    for await (const chunk of child.stdout) {
      pending += chunk.toString();
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        yield part;
      }
    }
  }());
  return { child: child as ChildProcessWithoutNullStreams, output };
}

function config(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    provider: 'cloudflare',
    cloudflareNamedTokenKey: 'test-token',
    ngrokUseHttpProxy: false,
    localtunnelHost: undefined,
    localtunnelSubdomain: undefined,
    startupTimeoutMs: 2_000,
    publicHealthTimeoutMs: 2_000,
    cloudflaredPath: 'cloudflared',
    ngrokPath: 'ngrok',
    ...overrides,
  };
}

async function namedTunnelSecrets(): Promise<MemorySecretStore> {
  const secrets = new MemorySecretStore();
  await secrets.set('test-token', 'secret-value');
  return secrets;
}

describe('TunnelManager', () => {
  it('parses a Cloudflare Quick Tunnel URL and closes the process', async () => {
    const manager = new TunnelManager(config(), new MemorySecretStore(), () => (
      fakeProcess([
        'INF https://example.trycloudflare.com',
        'INF Registered tunnel connection loc=...',
      ])
    ));
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://example.trycloudflare.com');
    await manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  it('parses a Cloudflare Quick Tunnel URL written to stderr', async () => {
    const manager = new TunnelManager(config(), new MemorySecretStore(), () => (
      spawnTunnelProcess(process.execPath, [
        '-e',
        "process.stderr.write('INF https://stderr.trycloudflare.com\\n'); " +
        "process.stderr.write('INF Registered tunnel connection loc=...\\n'); " +
        'setTimeout(() => {}, 10000)',
      ])
    ));
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://stderr.trycloudflare.com');
    await manager.stop();
  });

  it('keeps a Named Tunnel token out of argv', async () => {
    const secrets = await namedTunnelSecrets();
    let captured: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
      }),
      secrets,
      (_command, args, env) => {
        captured = {
          args,
          ...(env === undefined ? {} : { env }),
        };
        return fakeProcess(['registered tunnel connection']);
      },
    );
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://mcp.example.com');
    expect(captured?.args).not.toContain('secret-value');
    expect(captured?.env?.TUNNEL_TOKEN).toBe('secret-value');
    expect(captured?.args).toEqual([
      'tunnel', '--protocol', 'http2', '--no-autoupdate', 'run',
    ]);
    await manager.stop();
  });

  it('uses HTTP/2 for Quick Tunnels to avoid blocked QUIC networks', async () => {
    let capturedArgs: string[] | undefined;
    const manager = new TunnelManager(config(), new MemorySecretStore(), (_command, args) => {
      capturedArgs = args;
      return fakeProcess([
        'INF https://example.trycloudflare.com',
        'INF Registered tunnel connection loc=...',
      ]);
    });
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://example.trycloudflare.com');
    expect(capturedArgs).toEqual([
      'tunnel', '--protocol', 'http2', '--no-autoupdate',
      '--url', 'http://127.0.0.1:48271',
    ]);
    await manager.stop();
  });

  it('fails a Quick Tunnel that prints a URL without registering an edge connection', async () => {
    const manager = new TunnelManager(
      config({ startupTimeoutMs: 750 }),
      new MemorySecretStore(),
      () => fakeProcess(['INF https://example.trycloudflare.com']),
    );
    await expect(manager.start('http://127.0.0.1:48271'))
      .rejects.toThrow(/did not register a tunnel connection within \d+ms/);
    expect(manager.isRunning).toBe(false);
  });

  it('waits for a delayed Quick Tunnel ready signal', async () => {
    const manager = new TunnelManager(
      config({ startupTimeoutMs: 750 }),
      new MemorySecretStore(),
      () => spawnTunnelProcess(process.execPath, [
        '-e',
        "setTimeout(() => process.stdout.write('INF https://delayed.trycloudflare.com\\n'), 50); " +
        "setTimeout(() => process.stdout.write('INF Registered tunnel connection loc=...\\n'), 175); " +
        'setTimeout(() => {}, 10000)',
      ]),
    );
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://delayed.trycloudflare.com');
    await manager.stop();
  });

  it('binds Cloudflare Quick Tunnel traffic to a selected IPv4 address', async () => {
    let capturedArgs: string[] | undefined;
    const manager = new TunnelManager(
      config({ cloudflareEdgeBindAddress: '192.168.10.161' }),
      new MemorySecretStore(),
      (_command, args) => {
        capturedArgs = args;
        return fakeProcess([
          'INF https://bound.trycloudflare.com',
          'INF Registered tunnel connection loc=...',
        ]);
      },
    );
    await manager.start('http://127.0.0.1:48271');
    expect(capturedArgs).toContain('--edge-bind-address');
    expect(capturedArgs).toContain('192.168.10.161');
    await manager.stop();
  });

  it('binds Cloudflare Named Tunnel traffic to a selected IPv4 address', async () => {
    let capturedArgs: string[] | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
        cloudflareEdgeBindAddress: '192.168.10.161',
      }),
      await namedTunnelSecrets(),
      (_command, args) => {
        capturedArgs = args;
        return fakeProcess(['registered tunnel connection']);
      },
    );
    await manager.start('http://127.0.0.1:48271');
    expect(capturedArgs).toContain('--edge-bind-address');
    expect(capturedArgs).toContain('192.168.10.161');
    await manager.stop();
  });

  it('routes cloudflared Quick Tunnel through a configured HTTP proxy', async () => {
    const proxy = 'http://127.0.0.1:7897';
    const edgeAuthority = 'region1.v2.argotunnel.com:7844';
    let capturedArgs: string[] | undefined;
    const manager = new TunnelManager(
      config({ cloudflaredHttpProxy: proxy, cloudflareEdgeAuthority: edgeAuthority }),
      new MemorySecretStore(),
      (_command, args) => {
        capturedArgs = args;
        return fakeProcess([
          'INF https://proxied.trycloudflare.com',
          'INF Registered tunnel connection loc=...',
        ]);
      },
    );

    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://proxied.trycloudflare.com');
    expect(capturedArgs).not.toContain('--proxy');
    expect(capturedArgs).toContain('--edge');
    const edgeIndex = capturedArgs?.indexOf('--edge') ?? -1;
    expect(edgeIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs?.[edgeIndex + 1]).toMatch(/^127\.0\.0\.1:\d+$/);
    await manager.stop();
  });

  it('routes cloudflared Named Tunnel through a configured HTTP proxy while retaining its token', async () => {
    const proxy = 'http://127.0.0.1:7897';
    const edgeAuthority = 'region1.v2.argotunnel.com:7844';
    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
        cloudflaredHttpProxy: proxy,
        cloudflareEdgeAuthority: edgeAuthority,
      }),
      await namedTunnelSecrets(),
      (_command, args, env) => {
        capturedArgs = args;
        capturedEnv = env;
        return fakeProcess(['registered tunnel connection']);
      },
    );

    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://mcp.example.com');
    expect(capturedArgs).not.toContain('--proxy');
    expect(capturedArgs).toContain('--edge');
    expect(capturedEnv?.TUNNEL_TOKEN).toBe('secret-value');
    expect(Object.keys(capturedEnv ?? {}).filter(key => /proxy/i.test(key))).toEqual([]);
    await manager.stop();
  });

  it('waits for a delayed Named Tunnel ready signal', async () => {
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
        startupTimeoutMs: 500,
      }),
      await namedTunnelSecrets(),
      () => spawnTunnelProcess(process.execPath, [
        '-e',
        "setTimeout(() => process.stdout.write('connected\\n'), 100); setTimeout(() => {}, 10000)",
      ]),
    );
    const startedAt = Date.now();
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
    expect(handle.publicOrigin).toBe('https://mcp.example.com');
    await manager.stop();
  });

  it('reports an unexpected post-startup Named Tunnel exit', async () => {
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
      }),
      await namedTunnelSecrets(),
      () => spawnTunnelProcess(process.execPath, [
        '-e',
        "process.stdout.write('registered tunnel connection\\n'); " +
        'setTimeout(() => process.exit(23), 50)',
      ]),
    );

    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.waitForExit).toBeTypeOf('function');
    await expect(handle.waitForExit!()).resolves.toMatchObject({ code: 23 });
    expect(manager.isRunning).toBe(true);
    await manager.stop();
  });

  it('fails when a fixed tunnel exits before ready', async () => {
    const manager = new TunnelManager(
      config({
        provider: 'ngrok',
        ngrokDomain: 'bridge.ngrok-free.dev',
        startupTimeoutMs: 1_000,
      }),
      new MemorySecretStore(),
      () => spawnTunnelProcess(process.execPath, [
        '-e',
        "process.stderr.write('startup failed\\n'); setTimeout(() => process.exit(17), 25)",
      ]),
    );
    await expect(manager.start('http://127.0.0.1:48271'))
      .rejects.toThrow(/ngrok exited before becoming ready/);
    expect(manager.isRunning).toBe(false);
  });

  it('fails when a fixed tunnel never reports ready', async () => {
    const manager = new TunnelManager(
      config({
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
        startupTimeoutMs: 75,
      }),
      await namedTunnelSecrets(),
      () => fakeProcess(['still starting']),
    );
    await expect(manager.start('http://127.0.0.1:48271'))
      .rejects.toThrow(/did not become ready within 75ms/);
    expect(manager.isRunning).toBe(false);
  });

  it('clears HTTP proxy variables for ngrok by default', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'ngrok',
        ngrokDomain: 'bridge.ngrok-free.dev',
      }),
      new MemorySecretStore(),
      (_command, _args, env) => {
        capturedEnv = env;
        return fakeProcess(['ready']);
      },
    );

    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://bridge.ngrok-free.dev');
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]) {
      expect(capturedEnv).toHaveProperty(key, undefined);
    }
    await manager.stop();
  });

  it('inherits the process environment when ngrok HTTP proxy use is enabled', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'ngrok',
        ngrokDomain: 'bridge.ngrok-free.dev',
        ngrokUseHttpProxy: true,
      }),
      new MemorySecretStore(),
      (_command, _args, env) => {
        capturedEnv = env;
        return fakeProcess(['ready']);
      },
    );

    await manager.start('http://127.0.0.1:48271');
    expect(capturedEnv).toBeUndefined();
    await manager.stop();
  });

  it('starts localtunnel through a loopback forwarding adapter', async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        host: _request.headers.host,
        forwardedHost: _request.headers['x-forwarded-host'],
        forwardedProto: _request.headers['x-forwarded-proto'],
      }));
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;

    let capturedOptions: {
      port: number;
      host?: string | undefined;
      subdomain?: string | undefined;
      local_host?: string | undefined;
    } | undefined;
    const manager = new TunnelManager(
      config({
        provider: 'localtunnel',
        localtunnelHost: 'tunnel.example.com',
        localtunnelSubdomain: 'dshmcp',
      }),
      new MemorySecretStore(),
      () => {
        throw new Error('localtunnel should not spawn a process');
      },
    );

    const originalLocaltunnel = (manager as unknown as {
      localtunnel: (options: {
        port: number;
        host?: string;
        subdomain?: string;
        local_host?: string;
      }) => Promise<{
        url: string;
        close(): void;
        on(event: 'error', listener: (error: Error) => void): unknown;
      }>;
    }).localtunnel;
    (manager as unknown as { localtunnel: unknown }).localtunnel = async (
      options: Parameters<typeof originalLocaltunnel>[0],
    ) => {
      capturedOptions = options;
      let errorCallback: ((error: Error) => void) | undefined;
      return {
        url: 'https://dshmcp.loca.lt',
        close: () => undefined,
        on: (_event: 'error', listener: (error: Error) => void) => {
          errorCallback = listener;
        },
      };
    };

    const handle = await manager.start(`http://127.0.0.1:${targetPort}`);
    expect(handle.publicOrigin).toBe('https://dshmcp.loca.lt');
    expect(capturedOptions).toMatchObject({
      host: 'https://tunnel.example.com',
      subdomain: 'dshmcp',
      local_host: '127.0.0.1',
    });

    const proxyPort = capturedOptions?.port;
    expect(proxyPort).toBeTypeOf('number');
    const forwarded = await new Promise<{ host: unknown; forwardedHost: unknown; forwardedProto: unknown }>(resolve => {
      get(`http://127.0.0.1:${proxyPort}/mcp/test`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(JSON.parse(body)));
      });
    });
    expect(forwarded.host).toBe(`127.0.0.1:${targetPort}`);
    expect(forwarded.forwardedHost).toBe('dshmcp.loca.lt');
    expect(forwarded.forwardedProto).toBe('https');

    await manager.stop();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await expect(new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${proxyPort}/`, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }).once('error', reject);
    })).rejects.toThrow();
  });

  it('registers and forwards localtunnel traffic through an HTTP CONNECT proxy', async () => {
    const proxy = createServer();
    proxy.on('connect', (request, socket) => {
      const authority = request.url ?? '';
      const [host, portText] = authority.split(':');
      const upstream = net.connect(Number(portText), host);
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    const registry = createServer((request, response) => {
      if (request.url === '/dshmcp') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'dshmcp',
          ip: '127.0.0.1',
          port: assignedTunnelPort,
          url: 'https://dshmcp.loca.lt',
          max_conn_count: 1,
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const registryPort = (registry.address() as { port: number }).port;
    type ForwardedRequest = {
      host: string | undefined;
      forwardedHost: string | undefined;
      path: string;
    };
    let resolveForwardedRequest: (value: ForwardedRequest) => void = () => undefined;
    const forwardedRequest = new Promise<ForwardedRequest>((resolve) => {
      resolveForwardedRequest = resolve;
    });
    const target = createServer((request, response) => {
      const headerValue = (value: string | string[] | undefined): string | undefined =>
        Array.isArray(value) ? value[0] : value;
      resolveForwardedRequest({
        host: headerValue(request.headers.host),
        forwardedHost: headerValue(request.headers['x-forwarded-host']),
        path: request.url ?? '/',
      });
      response.writeHead(200);
      response.end('forwarded');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;

    let remoteConnected = false;
    let resolveRequest: (v: { host: string | undefined; path: string }) => void = () => undefined;
    const tunnelServer = net.createServer();
    tunnelServer.on('connection', (socket) => {
      remoteConnected = true;
      // Wait briefly for the proxied tunnel to be fully piped before sending test traffic.
      setTimeout(() => {
        socket.write('GET /forwarded HTTP/1.1\r\nHost: dshmcp.loca.lt\r\nConnection: close\r\n\r\n');
      }, 100);
      let reqData = '';
      socket.on('data', (chunk) => { reqData += chunk.toString(); });
      socket.on('end', () => {
        const hostMatch = reqData.match(/\r\n[Hh]ost: ([^\r\n]+)/);
        if (hostMatch) resolveRequest({ host: hostMatch[1], path: reqData.match(/^GET (\S+)/)?.[1] ?? '/' });
      });
    });
    await new Promise<void>(resolve => tunnelServer.listen(0, '127.0.0.1', resolve));
    const assignedTunnelPort = (tunnelServer.address() as { port: number }).port;

    const manager = new TunnelManager(
      config({
        provider: 'localtunnel',
        localtunnelHost: `http://127.0.0.1:${registryPort}`,
        localtunnelSubdomain: 'dshmcp',
        localtunnelHttpProxy: `http://127.0.0.1:${proxyPort}`,
      }),
      new MemorySecretStore(),
    );

    const handle = await manager.start(`http://127.0.0.1:${targetPort}`);
    expect(handle.publicOrigin).toBe('https://dshmcp.loca.lt');
    const forwarded = await Promise.race([
      forwardedRequest,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('forwarded request did not arrive in 3000ms')), 3_000)),
    ]);
    expect(remoteConnected).toBe(true);
    expect(forwarded.path).toBe('/forwarded');
    expect(forwarded.host).toBe(`127.0.0.1:${targetPort}`);
    expect(forwarded.forwardedHost).toBe('dshmcp.loca.lt');
    await manager.stop();

    await new Promise<void>(resolve => tunnelServer.close(() => resolve()));
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
  });

  it('retries proxied localtunnel registration after a transient failure', async () => {
    const proxy = createServer();
    proxy.on('connect', (request, socket) => {
      const [host, portText] = (request.url ?? '').split(':');
      const upstream = net.connect(Number(portText), host);
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    let registryAttempts = 0;
    const registry = createServer((request, response) => {
      registryAttempts += 1;
      if (registryAttempts === 1) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'dshmcp',
        ip: '127.0.0.1',
        port: remotePort,
        url: 'https://dshmcp-retried.loca.lt',
        max_conn_count: 1,
      }));
    });
    await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve));
    const registryPort = (registry.address() as { port: number }).port;

    const target = createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;

    const remote = net.createServer();
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const remotePort = (remote.address() as { port: number }).port;

    const manager = new TunnelManager(
      config({
        provider: 'localtunnel',
        localtunnelHost: `http://127.0.0.1:${registryPort}`,
        localtunnelSubdomain: 'dshmcp-retried',
        localtunnelHttpProxy: `http://127.0.0.1:${proxyPort}`,
      }),
      new MemorySecretStore(),
    );

    const handle = await manager.start(`http://127.0.0.1:${targetPort}`);
    expect(handle.publicOrigin).toBe('https://dshmcp-retried.loca.lt');
    expect(registryAttempts).toBe(2);

    await manager.stop();
    await new Promise<void>(resolve => remote.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
    await new Promise<void>(resolve => registry.close(() => resolve()));
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  });

  it('fails proxied localtunnel registration after three attempts', async () => {
    const proxy = createServer();
    proxy.on('connect', (_request, socket) => {
      socket.destroy();
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    const manager = new TunnelManager(
      config({
        provider: 'localtunnel',
        localtunnelHost: 'http://127.0.0.1:1',
        localtunnelSubdomain: 'dshmcp',
        localtunnelHttpProxy: `http://127.0.0.1:${proxyPort}`,
      }),
      new MemorySecretStore(),
    );

    await expect(manager.start('http://127.0.0.1:1'))
      .rejects.toThrow(/localtunnel failed after 3 attempt\(s\)/);
    expect(manager.isRunning).toBe(false);

    await new Promise<void>(resolve => proxy.close(() => resolve()));
  });
});
