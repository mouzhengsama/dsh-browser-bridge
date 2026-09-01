import path from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import type { ToolRegistry } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import {
  Config,
  apply,
  inject,
  name,
  resolvePluginBridgeConfig,
  type BridgeRuntimeLike,
  type DshBridgePluginConfig,
  type DshPluginContext,
} from '../src/dsh-plugin.js';
import { DesktopBrowserHost } from '../src/browser/desktop-host.js';
import { BridgeControlHttpService } from '../src/browser/control-http.js';
import type { BridgeRuntimeOptions } from '../src/runtime.js';
import type {
  BridgeConfig,
  BridgeConfigSnapshot,
  BridgeConfigUpdate,
  WorkspaceAdapter,
} from '../src/types.js';

// Plugin diagnostics intentionally follow DSH_HOME; keep test failures out of
// the real user profile.
process.env.DSH_HOME ??= await mkdtemp(join(tmpdir(), 'dsh-browser-bridge-test-'));

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

function fakeFileSystem(root: string): FileSystem {
  const target = {
    targetKey: 'workspace-root',
    displayPath: '.',
  } as unknown as FsTarget;
  return {
    resolve: vi.fn(async () => target),
    stat: vi.fn(async () => ({ type: 'directory' })),
    processPath: vi.fn(() => root),
  } as unknown as FileSystem;
}

function fakeAdapter(dispose = vi.fn(async () => undefined)): WorkspaceAdapter {
  return {
    workspaceRoot: process.cwd(),
    dispose,
  } as unknown as WorkspaceAdapter;
}

function fakeRuntime(
  config: BridgeConfig,
  overrides: Partial<BridgeRuntimeLike> = {},
): BridgeRuntimeLike {
  const status = {
    state: 'stopped' as const,
    tunnelProvider: config.tunnel.provider,
  };
  return {
    status,
    start: vi.fn(async () => status),
    stop: vi.fn(async () => undefined),
    resetPath: vi.fn(async () => undefined),
    getConnectionInfo: vi.fn(async () => ({
      state: status.state,
      tunnelProvider: status.tunnelProvider,
      instructions: 'test instructions',
    })),
    getConfigSnapshot: vi.fn(async (): Promise<BridgeConfigSnapshot> => ({
      editable: true,
      allowSecretPathOnly: false,
      allowedOrigins: [],
      tunnel: {
        provider: status.tunnelProvider,
        cloudflareNamedDomain: '',
        cloudflareNamedTokenConfigured: false,
        ngrokDomain: '',
        ngrokUseHttpProxy: false,
        localServiceUrl: 'http://127.0.0.1:48271',
      },
    })),
    updateConfig: vi.fn(async (
      _update: BridgeConfigUpdate,
    ): Promise<BridgeConfigSnapshot> => ({
      editable: true,
      allowSecretPathOnly: false,
      allowedOrigins: [],
      tunnel: {
        provider: status.tunnelProvider,
        cloudflareNamedDomain: '',
        cloudflareNamedTokenConfigured: false,
        ngrokDomain: '',
        ngrokUseHttpProxy: false,
        localServiceUrl: 'http://127.0.0.1:48271',
      },
    })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeContext(root: string): {
  context: DshPluginContext;
  tools: RegisteredTool[];
  effects: Array<() => Promise<void>>;
  register: ReturnType<typeof vi.fn>;
  webServer: {
    host: '127.0.0.1';
    port: number;
    register: ReturnType<typeof vi.fn>;
  };
} {
  const tools: RegisteredTool[] = [];
  const register = vi.fn((definition: RegisteredTool) => {
    tools.push(definition);
    return vi.fn();
  });
  const effects: Array<() => Promise<void>> = [];
  const webServer = {
    host: '127.0.0.1' as const,
    port: 48_271,
    register: vi.fn(() => vi.fn()),
  };
  const context = {
    fs: fakeFileSystem(root),
    tools: { register } as unknown as ToolRegistry,
    webServer,
    effect: vi.fn((factory: () => () => Promise<void>) => {
      effects.push(factory());
      return undefined;
    }),
  } as unknown as DshPluginContext;
  return { context, tools, effects, register, webServer };
}

describe('dsh plugin entry point', () => {
  it('exports the namespace plugin contract without a default export', async () => {
    const module = await import('../src/dsh-plugin.js');

    expect(name).toBe('dsh-browser-bridge');
    expect(inject).toEqual(['tools', 'webServer', 'fs']);
    expect(module).not.toHaveProperty('default');
  });

  it('normalizes secure, non-persistent defaults through Config', () => {
    const config = Config({});

    expect(config).toMatchObject({
      requireBearerToken: true,
      localConnectorPort: 0,
      persistentMode: false,
      capabilities: {
        read: true,
        write: false,
        command: false,
        lsp: true,
        progress: true,
      },
      tunnel: {
        provider: 'none',
        cloudflaredPath: 'cloudflared',
        ngrokPath: 'ngrok',
        ngrokUseHttpProxy: false,
      },
    });
    expect(config.limits.requestsPerMinute).toBe(120);
  });

  it('passes the dsh workspace and web server into the runtime and registers controls', async () => {
    const root = path.resolve('C:/dsh-workspace');
    const fixture = fakeContext(root);
    const adapter = fakeAdapter();
    let receivedConfig: BridgeConfig | undefined;
    let receivedOptions: BridgeRuntimeOptions | undefined;
    const runtime = fakeRuntime(Config({}) as BridgeConfig);

    await apply(
      fixture.context,
      Config({}) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async (_ctx, config) => {
          receivedConfig = config;
          return adapter;
        }),
        createRuntime: vi.fn((options) => {
          receivedOptions = options;
          return runtime;
        }),
      },
    );

    expect(receivedConfig).toMatchObject({
      workspaceRoot: root,
      host: '127.0.0.1',
      port: 48_271,
    });
    expect(receivedOptions).toMatchObject({
      config: receivedConfig,
      adapter,
      httpCarrier: fixture.webServer,
    });
    expect(fixture.register).toHaveBeenCalledTimes(7);
    expect(fixture.tools.map((tool) => tool.name)).toEqual([
      'bridge_status',
      'bridge_start',
      'bridge_stop',
      'bridge_reset_path',
      'bridge_connection_info',
      'bridge_config_get',
      'bridge_config_update',
    ]);
    expect(fixture.context.effect).toHaveBeenCalledTimes(1);
  });

  it('starts the runtime when persistentMode is enabled', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const runtime = fakeRuntime(Config({}) as BridgeConfig);
    const start = vi.spyOn(runtime, 'start');

    await apply(
      fixture.context,
      Config({ persistentMode: true }) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter()),
        createRuntime: vi.fn(() => runtime),
      },
    );

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps the plugin loaded when persistent startup fails', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const runtime = fakeRuntime(Config({}) as BridgeConfig);
    const start = vi.spyOn(runtime, 'start').mockRejectedValue(new Error('tunnel offline'));

    await apply(
      fixture.context,
      Config({ persistentMode: true }) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter()),
        createRuntime: vi.fn(() => runtime),
      },
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(fixture.context.effect).toHaveBeenCalledTimes(1);
    expect(fixture.tools).toHaveLength(7);
  });

  it('keeps operator-selected tunnel settings across restarts', () => {
    const configured = Config({
      persistentMode: true,
      tunnel: { provider: 'none' },
    }) as BridgeConfig;
    const saved: BridgeConfig = {
      ...configured,
      persistentMode: false,
      tunnel: {
        ...configured.tunnel,
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
      },
    };

    const resolved = resolvePluginBridgeConfig(configured, saved);

    expect(resolved.tunnel.provider).toBe('cloudflare-named');
    expect(resolved.persistentMode).toBe(true);
    expect(resolved.tunnel.cloudflareNamedDomain).toBe('mcp.example.com');
  });

  it('keeps overlay security and capability grants authoritative over stale saved config', () => {
    const configured = Config({
      requireBearerToken: true,
      allowedOrigins: ['https://workbuddy.cn'],
      capabilities: {
        read: true,
        write: true,
        command: true,
        lsp: true,
        progress: true,
      },
      commandRuntime: 'auto',
      persistentMode: true,
      tunnel: { provider: 'none' },
    }) as BridgeConfig;
    const saved = {
      ...configured,
      requireBearerToken: false,
      allowedOrigins: ['https://example.com'],
      capabilities: {
        read: true,
        write: false,
        command: false,
        lsp: false,
        progress: false,
      },
      commandRuntime: 'local' as const,
    };

    const resolved = resolvePluginBridgeConfig(configured, saved);

    expect(resolved.requireBearerToken).toBe(true);
    expect(resolved.allowSecretPathOnly).toBe(false);
    expect(resolved.allowedOrigins).toEqual(['https://workbuddy.cn']);
    expect(resolved.capabilities).toEqual({
      read: true,
      write: true,
      command: true,
      lsp: true,
      progress: true,
    });
    expect(resolved.commandRuntime).toBe('auto');
  });

  it('preserves a saved secret-path connection switch across overlay defaults', () => {
    const configured = Config({
      requireBearerToken: true,
      allowSecretPathOnly: false,
      tunnel: { provider: 'none' },
    }) as BridgeConfig;
    const saved: BridgeConfig = {
      ...configured,
      allowSecretPathOnly: true,
    };

    const resolved = resolvePluginBridgeConfig(configured, saved);

    expect(resolved.allowSecretPathOnly).toBe(true);
  });

  it('creates and registers the desktop browser control service', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const runtime = fakeRuntime(Config({}) as BridgeConfig);
    const browser = new DesktopBrowserHost(48_271);
    const unregister = vi.fn();
    const control = {
      register: vi.fn(() => unregister),
      dispose: vi.fn(async () => undefined),
    } as unknown as BridgeControlHttpService;
    const createBrowserHost = vi.fn(() => browser);
    const createControlService = vi.fn(() => control);

    await apply(
      fixture.context,
      Config({}) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter()),
        createRuntime: vi.fn(() => runtime),
        createBrowserHost,
        createControlService,
      },
    );

    expect(createBrowserHost).toHaveBeenCalledWith(48_271);
    expect(createControlService).toHaveBeenCalledWith(runtime, browser);
    expect(control.register).toHaveBeenCalledWith(fixture.webServer);
    await fixture.effects[0]!();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(control.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up the runtime through the dsh effect and removes undefined fields from tool output', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const runtime = fakeRuntime(Config({}) as BridgeConfig);

    await apply(
      fixture.context,
      Config({}) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter()),
        createRuntime: vi.fn(() => runtime),
      },
    );

    for (const tool of fixture.tools) {
      const output = await tool.execute({}, undefined);
      expect(JSON.stringify(output)).not.toContain('undefined');
    }
    await fixture.effects[0]!();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('updates bridge settings through a local config tool', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const runtime = fakeRuntime(Config({}) as BridgeConfig, {
      getConfigSnapshot: vi.fn(async (): Promise<BridgeConfigSnapshot> => ({
        editable: true,
        allowSecretPathOnly: true,
        allowedOrigins: [],
        tunnel: {
          provider: 'cloudflare',
          cloudflareNamedDomain: '',
          cloudflareNamedTokenConfigured: false,
          ngrokDomain: '',
          ngrokUseHttpProxy: false,
          localServiceUrl: 'http://127.0.0.1:43131',
        },
      })),
      updateConfig: vi.fn(async (update: BridgeConfigUpdate): Promise<BridgeConfigSnapshot> => ({
        editable: true,
        allowSecretPathOnly: update.allowSecretPathOnly === true,
        allowedOrigins: [],
        tunnel: {
          provider: update.tunnel?.provider ?? 'none',
          cloudflareNamedDomain: '',
          cloudflareNamedTokenConfigured: false,
          ngrokDomain: '',
          ngrokUseHttpProxy: false,
          localServiceUrl: 'http://127.0.0.1:43131',
        },
      })),
    });

    await apply(
      fixture.context,
      Config({}) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter()),
        createRuntime: vi.fn(() => runtime),
      },
    );

    const update = fixture.tools.find((tool) => tool.name === 'bridge_config_update');
    expect(update).toBeDefined();
    await expect(update!.execute({
      allowSecretPathOnly: true,
      provider: 'cloudflare',
    }, undefined)).resolves.toMatchObject({
      allowSecretPathOnly: true,
      tunnelProvider: 'cloudflare',
    });
    expect(runtime.updateConfig).toHaveBeenCalledWith({
      allowSecretPathOnly: true,
      tunnel: { provider: 'cloudflare' },
    });
  });

  it('disposes an adapter if runtime creation fails', async () => {
    const fixture = fakeContext(path.resolve('C:/dsh-workspace'));
    const dispose = vi.fn(async () => undefined);

    await expect(apply(
      fixture.context,
      Config({}) as DshBridgePluginConfig,
      {
        createAdapter: vi.fn(async () => fakeAdapter(dispose)),
        createRuntime: vi.fn(() => {
          throw new Error('runtime creation failed');
        }),
      },
    )).rejects.toThrow('runtime creation failed');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(fixture.register).not.toHaveBeenCalled();
  });
});
