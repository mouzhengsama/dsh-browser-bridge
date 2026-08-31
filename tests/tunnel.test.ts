import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
      fakeProcess(['INF https://example.trycloudflare.com'])
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
        "process.stderr.write('INF https://stderr.trycloudflare.com\\n'); setTimeout(() => {}, 10000)",
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
        return fakeProcess(['connected']);
      },
    );
    const handle = await manager.start('http://127.0.0.1:48271');
    expect(handle.publicOrigin).toBe('https://mcp.example.com');
    expect(captured?.args).not.toContain('secret-value');
    expect(captured?.env?.TUNNEL_TOKEN).toBe('secret-value');
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
});
