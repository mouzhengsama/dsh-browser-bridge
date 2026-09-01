import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { FileSystem } from '@deepseek-ai/dsh-fs';
import { defineTool, type ToolRegistry } from '@deepseek-ai/dsh-tools';
import { BridgeControlHttpService } from './browser/control-http.js';
import { DesktopBrowserHost } from './browser/desktop-host.js';
import type { BridgeHttpCarrier } from './http/server.js';
import {
  BridgeRuntime,
  type BridgeRuntimeOptions,
} from './runtime.js';
import { LocalWorkspaceAdapter } from './workspace/adapter.js';
import { DshWorkspaceAdapter } from './workspace/dsh-adapter.js';
import {
  loadExistingConfig,
  resolveDefaultConfigPath,
  saveConfig,
} from './config.js';
import { BUILT_IN_ORIGINS } from './links.js';
import type {
  BridgeConfig,
  BridgeConnectionInfo,
  BridgeStatus,
  CapabilityConfig,
  LanguageServerConfig,
  TunnelConfig,
  WorkspaceAdapter,
} from './types.js';

export const name = 'dsh-browser-bridge';
export const inject = ['tools', 'webServer', 'fs'] as const;

export interface DshBridgePluginConfig {
  requireBearerToken: boolean;
  allowedOrigins: string[];
  localConnectorPort: number;
  capabilities: CapabilityConfig;
  limits: BridgeConfig['limits'];
  tunnel: TunnelConfig;
  languageServers: LanguageServerConfig[];
  persistentMode: boolean;
  commandRuntime: 'auto' | 'dsh' | 'local';
}

const capabilitiesConfig = {
  read: Schema.boolean().default(true),
  write: Schema.boolean().default(false),
  command: Schema.boolean().default(false),
  lsp: Schema.boolean().default(true),
  progress: Schema.boolean().default(true),
};

const limitsConfig = {
  requestBodyLimit: Schema.string().default('1mb'),
  requestsPerMinute: Schema.natural().min(1).default(120),
  maxConcurrentRequests: Schema.natural().min(1).default(4),
  maxReadBytes: Schema.natural().min(1).default(512 * 1024),
  maxSearchResults: Schema.natural().min(1).default(200),
  maxCommandOutputBytes: Schema.natural().min(1).default(2 * 1024 * 1024),
  defaultCommandWaitMs: Schema.natural().default(30_000),
  maxCommandWaitMs: Schema.natural().min(1).default(120_000),
};

const languageServerConfig = {
  id: Schema.string().required(),
  extensions: Schema.array(Schema.string().required()).min(1).required(),
  command: Schema.string().required(),
  args: Schema.array(Schema.string()).default([]),
  languageId: Schema.string(),
  initializationOptions: Schema.any(),
};

const tunnelConfig = {
  provider: Schema.union([
    'cloudflare',
    'cloudflare-named',
    'ngrok',
    'none',
  ]).default('none'),
  cloudflareNamedDomain: Schema.string(),
  cloudflareNamedTokenKey: Schema.string().default('cloudflare-tunnel-token'),
  ngrokDomain: Schema.string(),
  ngrokUseHttpProxy: Schema.boolean().default(false),
  startupTimeoutMs: Schema.natural().min(1).default(20_000),
  publicHealthTimeoutMs: Schema.natural().min(1).default(20_000),
  cloudflaredPath: Schema.string().default('cloudflared'),
  ngrokPath: Schema.string().default('ngrok'),
};

const connectorConfig = {
  localConnectorPort: Schema.natural().default(0),
};

const commandRuntimeConfig = Schema.union([
  'auto',
  'dsh',
  'local',
]).default('auto');

export const Config = Schema.object({
  requireBearerToken: Schema.boolean().default(true),
  allowedOrigins: Schema.array(Schema.string()).default([...BUILT_IN_ORIGINS]),
  ...connectorConfig,
  capabilities: Schema.object(capabilitiesConfig).default({
    read: true,
    write: false,
    command: false,
    lsp: true,
    progress: true,
  }),
  limits: Schema.object(limitsConfig).default({
    requestBodyLimit: '1mb',
    requestsPerMinute: 120,
    maxConcurrentRequests: 4,
    maxReadBytes: 512 * 1024,
    maxSearchResults: 200,
    maxCommandOutputBytes: 2 * 1024 * 1024,
    defaultCommandWaitMs: 30_000,
    maxCommandWaitMs: 120_000,
  }),
  tunnel: Schema.object(tunnelConfig).default({
    provider: 'none',
    cloudflareNamedDomain: '',
    cloudflareNamedTokenKey: 'cloudflare-tunnel-token',
    ngrokDomain: '',
    ngrokUseHttpProxy: false,
    startupTimeoutMs: 20_000,
    publicHealthTimeoutMs: 20_000,
    cloudflaredPath: 'cloudflared',
    ngrokPath: 'ngrok',
  }),
  languageServers: Schema.array(Schema.object(languageServerConfig)).default([]),
  persistentMode: Schema.boolean().default(false),
  commandRuntime: commandRuntimeConfig,
});

export interface DshWebServer extends BridgeHttpCarrier {}

export interface DshPluginContext extends Context {
  readonly fs: FileSystem;
  readonly tools: ToolRegistry;
  readonly webServer: DshWebServer;
}

export interface BridgeRuntimeLike {
  readonly status: BridgeStatus;
  start(): Promise<BridgeStatus>;
  stop(): Promise<void>;
  resetPath(): Promise<void>;
  getConnectionInfo(): Promise<BridgeConnectionInfo>;
  getConfigSnapshot(): Promise<import('./types.js').BridgeConfigSnapshot>;
  updateConfig(
    update: import('./types.js').BridgeConfigUpdate,
  ): Promise<import('./types.js').BridgeConfigSnapshot>;
  dispose(): Promise<void>;
}

export interface DshBridgePluginDependencies {
  createAdapter?: (
    ctx: DshPluginContext,
    config: BridgeConfig,
  ) => Promise<WorkspaceAdapter>;
  createRuntime?: (options: BridgeRuntimeOptions) => BridgeRuntimeLike;
  createBrowserHost?: (port: number) => DesktopBrowserHost;
  createControlService?: (
    runtime: BridgeRuntimeLike,
    browser: DesktopBrowserHost,
  ) => BridgeControlHttpService;
}

const statusOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: {
      type: 'string',
      enum: ['stopped', 'starting', 'running', 'stopping', 'failed'] as const,
      required: true,
    },
    localOrigin: { type: 'string' },
    publicOrigin: { type: 'string' },
    mcpUrl: { type: 'string' },
    healthUrl: { type: 'string' },
    tunnelProvider: {
      type: 'string',
      enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok'] as const,
      required: true,
    },
    startedAt: { type: 'string' },
    error: { type: 'string' },
  },
} as const;

const connectionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: {
      type: 'string',
      enum: ['stopped', 'starting', 'running', 'stopping', 'failed'] as const,
      required: true,
    },
    tunnelProvider: {
      type: 'string',
      enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok'] as const,
      required: true,
    },
    mcpUrl: { type: 'string' },
    healthUrl: { type: 'string' },
    publicOrigin: { type: 'string' },
    bearerToken: { type: 'string' },
    instructions: { type: 'string', required: true },
  },
} as const;

type StatusToolOutput = {
  state: BridgeStatus['state'];
  tunnelProvider: BridgeStatus['tunnelProvider'];
  localOrigin?: string;
  publicOrigin?: string;
  mcpUrl?: string;
  healthUrl?: string;
  startedAt?: string;
  error?: string;
};

type ConnectionToolOutput = {
  state: BridgeConnectionInfo['state'];
  tunnelProvider: BridgeConnectionInfo['tunnelProvider'];
  connectionTarget?: 'local' | 'public';
  mcpUrl?: string;
  healthUrl?: string;
  publicOrigin?: string;
  bearerToken?: string;
  instructions: string;
};

function statusToolOutput(status: BridgeStatus): StatusToolOutput {
  return {
    state: status.state,
    tunnelProvider: status.tunnelProvider,
    ...(status.localOrigin === undefined ? {} : { localOrigin: status.localOrigin }),
    ...(status.publicOrigin === undefined ? {} : { publicOrigin: status.publicOrigin }),
    ...(status.mcpUrl === undefined ? {} : { mcpUrl: status.mcpUrl }),
    ...(status.healthUrl === undefined ? {} : { healthUrl: status.healthUrl }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

function connectionToolOutput(info: BridgeConnectionInfo): ConnectionToolOutput {
  return {
    state: info.state,
    tunnelProvider: info.tunnelProvider,
    instructions: info.instructions,
    ...(info.connectionTarget === undefined ? {} : { connectionTarget: info.connectionTarget }),
    ...(info.mcpUrl === undefined ? {} : { mcpUrl: info.mcpUrl }),
    ...(info.healthUrl === undefined ? {} : { healthUrl: info.healthUrl }),
    ...(info.publicOrigin === undefined ? {} : { publicOrigin: info.publicOrigin }),
    ...(info.bearerToken === undefined ? {} : { bearerToken: info.bearerToken }),
  };
}

function renderJson(
  _args: unknown,
  value: unknown,
): [{ type: 'text'; text: string }] {
  return [{
    type: 'text',
    text: JSON.stringify(value, null, 2) ?? 'null',
  }];
}

export async function recordStartupDiagnostic(
  stage: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordJsonlDiagnostic('browser-bridge-startup.jsonl', { stage, ...details });
}

export async function recordJsonlDiagnostic(
  fileName: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ...details,
    })}\n`;
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    await appendFile(join(dshHome, fileName), line, 'utf8');
  } catch {
    // Diagnostics must never turn a failed Bridge activation into a failed plugin load.
  }
}

function recordAccessDiagnostic(
  event: import('./http/server.js').BridgeHttpAccessEvent,
): void {
  void recordJsonlDiagnostic('browser-bridge-access.jsonl', {
    stage: 'mcp-access',
    ...event,
  });
}

export function resolvePluginBridgeConfig(
  configured: BridgeConfig,
  savedConfig: BridgeConfig | undefined,
): BridgeConfig {
  const config: BridgeConfig = {
    ...configured,
    ...(savedConfig ?? {}),
    workspaceRoot: configured.workspaceRoot,
    host: configured.host,
    port: configured.port,
  };

  if (!savedConfig) {
    return config;
  }

  // The DSH overlay is authoritative for security-sensitive lifecycle
  // defaults. Tunnel selection is operator state changed in the Bridge UI, so
  // a deliberately saved choice survives restarts instead of being reset.
  // Security and capability grants are overlay-authoritative too: a stale
  // workspace-local file must never silently narrow the configured contract
  // (or widen it after the profile has deliberately reduced access).
  return {
    ...config,
    requireBearerToken: configured.requireBearerToken,
    allowedOrigins: [...configured.allowedOrigins],
    capabilities: { ...configured.capabilities },
    commandRuntime: configured.commandRuntime,
    tunnel: savedConfig.tunnel,
    persistentMode: configured.persistentMode,
  };
}

export async function apply(
  ctx: Context,
  rawConfig: DshBridgePluginConfig,
  dependencies: DshBridgePluginDependencies = {},
): Promise<void> {
  await recordStartupDiagnostic('apply-start', {
    persistentMode: rawConfig.persistentMode,
    tunnelProvider: rawConfig.tunnel?.provider,
    rawCapabilities: rawConfig.capabilities,
    workspace: process.cwd(),
  });
  const pluginContext = ctx as DshPluginContext;
  const rootTarget = await pluginContext.fs.resolve('.');
  const rootInfo = await pluginContext.fs.stat(rootTarget);
  if (!rootInfo || rootInfo.type !== 'directory') {
    throw new Error('dsh fs workspace root is not a directory');
  }

  const configured: BridgeConfig = {
    workspaceRoot: pluginContext.fs.processPath(rootTarget),
    host: pluginContext.webServer.host,
    port: pluginContext.webServer.port,
    ...rawConfig,
  };
  const configPath = resolveDefaultConfigPath(configured.workspaceRoot);
  const savedConfig = await loadExistingConfig(configPath);
  const config = resolvePluginBridgeConfig(configured, savedConfig);
  await recordStartupDiagnostic('config-resolved', {
    capabilities: config.capabilities,
    commandRuntime: config.commandRuntime,
    tunnelProvider: config.tunnel.provider,
  });
  const createAdapter = dependencies.createAdapter
    ?? (async (
      adapterContext: DshPluginContext,
      bridgeConfig: BridgeConfig,
    ): Promise<WorkspaceAdapter> => {
      if (bridgeConfig.commandRuntime === 'local') {
        return LocalWorkspaceAdapter.create(bridgeConfig);
      }
      return DshWorkspaceAdapter.create(adapterContext, bridgeConfig, details => (
        void recordStartupDiagnostic('dsh-command-runtime', details)
      ));
    });
  const createRuntime = dependencies.createRuntime
    ?? ((options: BridgeRuntimeOptions) => new BridgeRuntime(options));

  let adapter: WorkspaceAdapter | undefined;
  let runtime: BridgeRuntimeLike | undefined;
  let control: BridgeControlHttpService | undefined;
  let unregisterControl: (() => void) | undefined;
  try {
    adapter = await createAdapter(pluginContext, config);
    runtime = createRuntime({
      config,
      adapter,
      httpCarrier: pluginContext.webServer,
      onAccessLog: recordAccessDiagnostic,
      onConfigChanged: nextConfig => saveConfig(configPath, nextConfig),
    });
    const activeRuntime = runtime;
    const browser = dependencies.createBrowserHost?.(config.port)
      ?? new DesktopBrowserHost(config.port);
    control = dependencies.createControlService?.(activeRuntime, browser)
      ?? new BridgeControlHttpService(activeRuntime, browser);
    unregisterControl = control.register(pluginContext.webServer);
    const activeControl = control;
    const activeUnregisterControl = unregisterControl;

    ctx.effect(() => async () => {
      activeUnregisterControl();
      await activeControl.dispose();
      await activeRuntime.dispose();
    }, name);

    registerControlTools(pluginContext.tools, activeRuntime);

    if (config.persistentMode) {
      await recordStartupDiagnostic('persistent-start', {
        tunnelProvider: config.tunnel.provider,
      });
      try {
        await activeRuntime.start();
        if (activeRuntime.status.state === 'running') {
          await recordStartupDiagnostic('persistent-complete', {
            state: activeRuntime.status.state,
            tunnelProvider: config.tunnel.provider,
            ...(activeRuntime.status.localOrigin === undefined
              ? {}
              : { localOrigin: activeRuntime.status.localOrigin }),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordStartupDiagnostic('persistent-failed', {
          state: activeRuntime.status.state,
          tunnelProvider: config.tunnel.provider,
          message,
        });
        console.error('[dsh-browser-bridge] persistent start failed', { message });
      }
    }
  } catch (error) {
    await recordStartupDiagnostic('apply-failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    unregisterControl?.();
    await control?.dispose();
    if (runtime) {
      await runtime.dispose();
    } else {
      await adapter?.dispose();
    }
    throw error;
  }
}

function registerControlTools(
  tools: ToolRegistry,
  runtime: BridgeRuntimeLike,
): void {
  tools.register(defineTool({
    name: 'bridge_status',
    description: 'Return the local Bridge lifecycle status.',
    parameters: {},
    output: {
      schema: statusOutputSchema,
      render: renderJson,
    },
    async execute() {
      return statusToolOutput(runtime.status);
    },
  }));

  tools.register(defineTool({
    name: 'bridge_start',
    description: 'Start the protected workspace MCP Bridge and its configured tunnel.',
    parameters: {},
    output: {
      schema: statusOutputSchema,
      render: renderJson,
    },
    async execute() {
      return statusToolOutput(await runtime.start());
    },
  }));

  tools.register(defineTool({
    name: 'bridge_stop',
    description: 'Stop the workspace MCP Bridge and its configured tunnel.',
    parameters: {},
    output: {
      schema: statusOutputSchema,
      render: renderJson,
    },
    async execute() {
      await runtime.stop();
      return statusToolOutput(runtime.status);
    },
  }));

  tools.register(defineTool({
    name: 'bridge_reset_path',
    description: 'Stop the Bridge and invalidate its secret MCP URL path.',
    parameters: {},
    output: {
      schema: statusOutputSchema,
      render: renderJson,
    },
    async execute() {
      await runtime.resetPath();
      return statusToolOutput(runtime.status);
    },
  }));

  tools.register(defineTool({
    name: 'bridge_connection_info',
    description: 'Return connector instructions and, only while running, protected connection details.',
    parameters: {},
    output: {
      schema: connectionOutputSchema,
      render: renderJson,
    },
    async execute() {
      return connectionToolOutput(await runtime.getConnectionInfo());
    },
  }));
}
