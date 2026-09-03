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
  allowSecretPathOnly: boolean;
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
    'localtunnel',
    'none',
  ]).default('none'),
  cloudflareNamedDomain: Schema.string(),
  cloudflareNamedTokenKey: Schema.string().default('cloudflare-tunnel-token'),
  cloudflareEdgeBindAddress: Schema.string(),
  cloudflareEdgeAuthority: Schema.string(),
  cloudflaredHttpProxy: Schema.string(),
  ngrokDomain: Schema.string(),
  ngrokUseHttpProxy: Schema.boolean().default(false),
  localtunnelHost: Schema.string(),
  localtunnelHttpProxy: Schema.string(),
  localtunnelSubdomain: Schema.string(),
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

const oauthPairingOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    expiresAt: { type: 'number', required: true },
  },
} as const;

export const Config = Schema.object({
  requireBearerToken: Schema.boolean().default(true),
  allowSecretPathOnly: Schema.boolean().default(false),
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
    cloudflareEdgeBindAddress: '',
    cloudflareEdgeAuthority: '',
    cloudflaredHttpProxy: '',
    ngrokDomain: '',
    ngrokUseHttpProxy: false,
    localtunnelHost: '',
    localtunnelHttpProxy: '',
    localtunnelSubdomain: '',
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
  createOAuthPairingCode(): import('./types.js').OAuthPairingCode;
  revokeAllOAuthGrants(): Promise<void>;
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
      enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'localtunnel'] as const,
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
      enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'localtunnel'] as const,
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

type ConfigToolOutput = {
  editable: boolean;
  allowSecretPathOnly: boolean;
  tunnelProvider: import('./types.js').TunnelProviderId;
  cloudflareNamedDomain: string;
  cloudflareNamedTokenConfigured: boolean;
  cloudflareEdgeBindAddress: string;
  cloudflareEdgeAuthority: string;
  cloudflaredHttpProxy: string;
  ngrokDomain: string;
  ngrokUseHttpProxy: boolean;
  localtunnelHost: string;
  localtunnelHttpProxy: string;
  localtunnelSubdomain: string;
  localServiceUrl: string;
  allowedOrigins: string[];
};

function configToolOutput(snapshot: import('./types.js').BridgeConfigSnapshot): ConfigToolOutput {
  return {
    editable: snapshot.editable,
    allowSecretPathOnly: snapshot.allowSecretPathOnly,
    tunnelProvider: snapshot.tunnel.provider,
    cloudflareNamedDomain: snapshot.tunnel.cloudflareNamedDomain,
    cloudflareNamedTokenConfigured: snapshot.tunnel.cloudflareNamedTokenConfigured,
    cloudflareEdgeBindAddress: snapshot.tunnel.cloudflareEdgeBindAddress,
    cloudflareEdgeAuthority: snapshot.tunnel.cloudflareEdgeAuthority,
    cloudflaredHttpProxy: snapshot.tunnel.cloudflaredHttpProxy,
    ngrokDomain: snapshot.tunnel.ngrokDomain,
    ngrokUseHttpProxy: snapshot.tunnel.ngrokUseHttpProxy,
    localtunnelHost: snapshot.tunnel.localtunnelHost,
    localtunnelHttpProxy: snapshot.tunnel.localtunnelHttpProxy,
    localtunnelSubdomain: snapshot.tunnel.localtunnelSubdomain,
    localServiceUrl: snapshot.tunnel.localServiceUrl,
    allowedOrigins: [...snapshot.allowedOrigins],
  };
}

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

const configOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    editable: { type: 'boolean', required: true },
    allowSecretPathOnly: { type: 'boolean', required: true },
    tunnelProvider: {
      type: 'string',
      enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'localtunnel'] as const,
      required: true,
    },
    cloudflareNamedDomain: { type: 'string', required: true },
    cloudflareNamedTokenConfigured: { type: 'boolean', required: true },
    cloudflareEdgeBindAddress: { type: 'string', required: true },
    cloudflareEdgeAuthority: { type: 'string', required: true },
    cloudflaredHttpProxy: { type: 'string', required: true },
    ngrokDomain: { type: 'string', required: true },
    ngrokUseHttpProxy: { type: 'boolean', required: true },
    localtunnelHost: { type: 'string', required: true },
    localtunnelHttpProxy: { type: 'string', required: true },
    localtunnelSubdomain: { type: 'string', required: true },
    localServiceUrl: { type: 'string', required: true },
    allowedOrigins: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
  },
} as const;

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
  // The secret-path switch is a runtime connector-compatibility choice, so
  // preserve the operator's saved value unless this overlay explicitly opts in.
  const configuredTunnel = configured.tunnel;
  const savedTunnel = savedConfig.tunnel;
  const overrideIfConfigured = <T>(
    profileValue: T | undefined,
    savedValue: T | undefined,
    isEmpty: (value: T | undefined) => boolean = value => value === undefined,
  ): T | undefined => (
    !isEmpty(profileValue) ? profileValue : savedValue
  );

  return {
    ...config,
    requireBearerToken: configured.requireBearerToken,
    allowSecretPathOnly: configured.allowSecretPathOnly || savedConfig.allowSecretPathOnly,
    allowedOrigins: [...configured.allowedOrigins],
    capabilities: { ...configured.capabilities },
    commandRuntime: configured.commandRuntime,
    tunnel: {
      ...savedTunnel,
      provider: configuredTunnel.provider !== 'none'
        ? configuredTunnel.provider
        : savedTunnel.provider,
      cloudflareNamedDomain: overrideIfConfigured(
        configuredTunnel.cloudflareNamedDomain,
        savedTunnel.cloudflareNamedDomain,
        value => value === undefined || value === '',
      ),
      cloudflareEdgeBindAddress: overrideIfConfigured(
        configuredTunnel.cloudflareEdgeBindAddress,
        savedTunnel.cloudflareEdgeBindAddress,
        value => value === undefined || value === '',
      ),
      cloudflareEdgeAuthority: overrideIfConfigured(
        configuredTunnel.cloudflareEdgeAuthority,
        savedTunnel.cloudflareEdgeAuthority,
        value => value === undefined || value === '',
      ),
      cloudflaredHttpProxy: overrideIfConfigured(
        configuredTunnel.cloudflaredHttpProxy,
        savedTunnel.cloudflaredHttpProxy,
        value => value === undefined || value === '',
      ),
      localtunnelHost: overrideIfConfigured(
        configuredTunnel.localtunnelHost,
        savedTunnel.localtunnelHost,
        value => value === undefined || value === '',
      ),
      localtunnelHttpProxy: overrideIfConfigured(
        configuredTunnel.localtunnelHttpProxy,
        savedTunnel.localtunnelHttpProxy,
        value => value === undefined || value === '',
      ),
      localtunnelSubdomain: overrideIfConfigured(
        configuredTunnel.localtunnelSubdomain,
        savedTunnel.localtunnelSubdomain,
        value => value === undefined || value === '',
      ),
      startupTimeoutMs: configuredTunnel.startupTimeoutMs !== 20_000
        ? configuredTunnel.startupTimeoutMs
        : savedTunnel.startupTimeoutMs,
      publicHealthTimeoutMs: configuredTunnel.publicHealthTimeoutMs !== 20_000
        ? configuredTunnel.publicHealthTimeoutMs
        : savedTunnel.publicHealthTimeoutMs,
    },
    localConnectorPort: configured.localConnectorPort,
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
    savedTunnelProvider: savedConfig?.tunnel.provider,
    overlayTunnelProvider: configured.tunnel.provider,
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
      onStartupDiagnostic: details => {
        void recordStartupDiagnostic('runtime', details);
      },
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

  tools.register(defineTool({
    name: 'bridge_config_get',
    description: 'Return editable Bridge connection and security settings.',
    parameters: {},
    output: {
      schema: configOutputSchema,
      render: renderJson,
    },
    async execute() {
      return configToolOutput(await runtime.getConfigSnapshot());
    },
  }));

  tools.register(defineTool({
    name: 'bridge_config_update',
    description:
      'Update Bridge settings while stopped. Set allowSecretPathOnly true to accept requests without an Authorization header while still rejecting an invalid token.',
    parameters: {
      allowSecretPathOnly: { type: 'boolean' },
      provider: {
        type: 'string',
        enum: ['none', 'cloudflare', 'cloudflare-named', 'ngrok'],
      },
      cloudflareNamedDomain: { type: 'string' },
      cloudflareNamedToken: { type: 'string' },
      cloudflareEdgeBindAddress: { type: 'string' },
      cloudflareEdgeAuthority: { type: 'string' },
      cloudflaredHttpProxy: { type: 'string' },
      ngrokDomain: { type: 'string' },
      ngrokUseHttpProxy: { type: 'boolean' },
      localtunnelHost: { type: 'string' },
      localtunnelHttpProxy: { type: 'string' },
      localtunnelSubdomain: { type: 'string' },
      allowedOrigins: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: configOutputSchema,
      render: renderJson,
    },
    async execute(args) {
      return configToolOutput(await runtime.updateConfig({
        ...(args.allowSecretPathOnly === undefined ? {} : { allowSecretPathOnly: args.allowSecretPathOnly }),
        ...(args.allowedOrigins === undefined ? {} : { allowedOrigins: args.allowedOrigins }),
        tunnel: {
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.cloudflareNamedDomain === undefined ? {} : { cloudflareNamedDomain: args.cloudflareNamedDomain }),
          ...(args.cloudflareNamedToken === undefined ? {} : { cloudflareNamedToken: args.cloudflareNamedToken }),
          ...(args.cloudflareEdgeBindAddress === undefined ? {} : { cloudflareEdgeBindAddress: args.cloudflareEdgeBindAddress }),
          ...(args.cloudflareEdgeAuthority === undefined ? {} : { cloudflareEdgeAuthority: args.cloudflareEdgeAuthority }),
          ...(args.cloudflaredHttpProxy === undefined ? {} : { cloudflaredHttpProxy: args.cloudflaredHttpProxy }),
          ...(args.ngrokDomain === undefined ? {} : { ngrokDomain: args.ngrokDomain }),
          ...(args.ngrokUseHttpProxy === undefined ? {} : { ngrokUseHttpProxy: args.ngrokUseHttpProxy }),
          ...(args.localtunnelHost === undefined ? {} : { localtunnelHost: args.localtunnelHost }),
          ...(args.localtunnelHttpProxy === undefined ? {} : { localtunnelHttpProxy: args.localtunnelHttpProxy }),
          ...(args.localtunnelSubdomain === undefined ? {} : { localtunnelSubdomain: args.localtunnelSubdomain }),
        },
      }));
    },
  }));

  tools.register(defineTool({
    name: 'bridge_oauth_pair',
    description: 'Create a short-lived pairing code for approving an OAuth MCP connector.',
    parameters: {},
    output: {
      schema: oauthPairingOutputSchema,
      render: renderJson,
    },
    async execute() {
      return runtime.createOAuthPairingCode();
    },
  }));

  tools.register(defineTool({
    name: 'bridge_oauth_revoke',
    description: 'Revoke all OAuth clients, authorization codes, pairing codes, and refresh tokens.',
    parameters: {},
    output: {
      schema: statusOutputSchema,
      render: renderJson,
    },
    async execute() {
      await runtime.revokeAllOAuthGrants();
      return statusToolOutput(runtime.status);
    },
  }));
}
