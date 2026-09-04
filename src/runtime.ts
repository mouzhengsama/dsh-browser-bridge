import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ensureSecret, KeyringSecretStore } from './security/secrets.js';
import { FileSecretStore } from './security/file-secrets.js';
import { BUILT_IN_ORIGINS } from './links.js';
import { BridgeHttpServer, type BridgeHttpCarrier } from './http/server.js';
import { normalizeOrigin } from './http/security.js';
import { LocalWorkspaceAdapter } from './workspace/adapter.js';
import { TunnelManager, type TunnelHandle, type TunnelExit } from './tunnel/manager.js';
import type {
  BridgeConfig,
  BridgeConfigSnapshot,
  BridgeConfigUpdate,
  BridgeConnectionInfo,
  BridgeEvent,
  BridgeProgress,
  BridgeStatus,
  SecretStore,
  WorkspaceAdapter,
} from './types.js';

const MCP_PATH_SECRET = 'mcp-path-secret';
const BEARER_TOKEN = 'bearer-token';
const OAUTH_SIGNING_KEY = 'oauth-signing-key';
const LOCAL_PAIRING_TOKEN_SECRET = 'local-pairing-token';

export interface BridgeRuntimeOptions {
  config: BridgeConfig;
  secrets?: SecretStore;
  oauthSecretStore?: SecretStore;
  adapter?: WorkspaceAdapter;
  httpCarrier?: BridgeHttpCarrier | undefined;
  onAccessLog?: ((event: import('./http/server.js').BridgeHttpAccessEvent) => void) | undefined;
  onConfigChanged?: ((config: BridgeConfig) => Promise<void>) | undefined;
  onStartupDiagnostic?: ((details: Record<string, unknown>) => void) | undefined;
  tunnelFactory?: (config: BridgeConfig['tunnel'], secrets: SecretStore) => TunnelManager;
}

export class BridgeRuntime {
  readonly config: BridgeConfig;
  readonly adapterPromise: Promise<WorkspaceAdapter>;
  readonly secrets: SecretStore;
  private readonly oauthSecretStore: SecretStore;
  private readonly httpCarrier: BridgeHttpCarrier | undefined;
  private readonly onAccessLog: ((event: import('./http/server.js').BridgeHttpAccessEvent) => void) | undefined;
  private readonly onConfigChanged: ((config: BridgeConfig) => Promise<void>) | undefined;
  private readonly onStartupDiagnostic: ((details: Record<string, unknown>) => void) | undefined;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();
  private readonly tunnelFactory: ((config: BridgeConfig['tunnel'], secrets: SecretStore) => TunnelManager) | undefined;
  private http: BridgeHttpServer | undefined;
  private tunnel: TunnelManager | undefined;
  private adapterValue: WorkspaceAdapter | undefined;
  private statusValue: BridgeStatus;
  private startPromise: Promise<BridgeStatus> | undefined;
  private disposePromise: Promise<void> | undefined;
  private tunnelMonitor: { cancel(): void } | undefined;

  constructor(options: BridgeRuntimeOptions) {
    this.config = options.config;
    this.secrets = options.secrets ?? new KeyringSecretStore(options.config.workspaceRoot);
    this.oauthSecretStore = options.oauthSecretStore ?? new FileSecretStore({
      rootDir: this.config.workspaceRoot,
      keyring: this.secrets,
    });
    this.httpCarrier = options.httpCarrier;
    this.onAccessLog = options.onAccessLog;
    this.onConfigChanged = options.onConfigChanged;
    this.onStartupDiagnostic = options.onStartupDiagnostic;
    this.tunnelFactory = options.tunnelFactory;
    this.adapterPromise = options.adapter
      ? Promise.resolve(options.adapter)
      : LocalWorkspaceAdapter.create(options.config);
    void this.adapterPromise.then((adapter) => {
      this.adapterValue = adapter;
    });
    this.statusValue = {
      state: 'stopped',
      tunnelProvider: options.config.tunnel.provider,
    };
  }

  get status(): BridgeStatus {
    return this.statusValue;
  }

  private configuredLocalServiceUrl(): string {
    const port = this.config.localConnectorPort > 0
      ? this.config.localConnectorPort
      : this.statusValue.localOrigin !== undefined
        ? Number(new URL(this.statusValue.localOrigin).port)
        : undefined;
    return `http://127.0.0.1:${port ?? this.config.port}`;
  }

  private effectiveAllowedOrigins(): string[] {
    return [...new Set([
      ...this.config.allowedOrigins,
      ...BUILT_IN_ORIGINS,
    ])];
  }

  async getConfigSnapshot(): Promise<BridgeConfigSnapshot> {
    const tokenKey = this.config.tunnel.cloudflareNamedTokenKey ?? 'cloudflare-tunnel-token';
    const token = await this.secrets.get(tokenKey);
    return {
      editable: this.statusValue.state === 'stopped' || this.statusValue.state === 'failed',
      allowSecretPathOnly: this.config.allowSecretPathOnly,
      tunnel: {
        provider: this.config.tunnel.provider,
        cloudflareNamedDomain: this.config.tunnel.cloudflareNamedDomain ?? '',
        cloudflareNamedTokenConfigured: Boolean(token),
        cloudflareEdgeBindAddress: this.config.tunnel.cloudflareEdgeBindAddress ?? '',
        cloudflareEdgeAuthority: this.config.tunnel.cloudflareEdgeAuthority ?? '',
        cloudflaredHttpProxy: this.config.tunnel.cloudflaredHttpProxy ?? '',
        ngrokDomain: this.config.tunnel.ngrokDomain ?? '',
        ngrokUseHttpProxy: this.config.tunnel.ngrokUseHttpProxy,
        localtunnelHost: this.config.tunnel.localtunnelHost ?? '',
        localtunnelHttpProxy: this.config.tunnel.localtunnelHttpProxy ?? '',
        localtunnelSubdomain: this.config.tunnel.localtunnelSubdomain ?? '',
        localServiceUrl: this.configuredLocalServiceUrl(),
      },
      allowedOrigins: this.effectiveAllowedOrigins(),
    };
  }

  async updateConfig(update: BridgeConfigUpdate): Promise<BridgeConfigSnapshot> {
    if (this.statusValue.state !== 'stopped' && this.statusValue.state !== 'failed') {
      throw new Error('Stop Bridge before changing its tunnel settings');
    }
    const current = this.config.tunnel;
    const currentAllowSecretPathOnly = this.config.allowSecretPathOnly;
    let proposedAllowSecretPathOnly = currentAllowSecretPathOnly;
    const proposed: BridgeConfig['tunnel'] = { ...current };
    const tunnelUpdate = update.tunnel;
    const currentOrigins = this.config.allowedOrigins;
    let proposedOrigins = currentOrigins;
    if (tunnelUpdate?.provider !== undefined) {
      proposed.provider = tunnelUpdate.provider;
    }
    if (tunnelUpdate?.cloudflareNamedDomain !== undefined) {
      proposed.cloudflareNamedDomain = tunnelUpdate.cloudflareNamedDomain;
    }
    if (tunnelUpdate?.cloudflareEdgeBindAddress !== undefined) {
      proposed.cloudflareEdgeBindAddress = tunnelUpdate.cloudflareEdgeBindAddress;
    }
    if (tunnelUpdate?.cloudflareEdgeAuthority !== undefined) {
      proposed.cloudflareEdgeAuthority = tunnelUpdate.cloudflareEdgeAuthority;
    }
    if (tunnelUpdate?.cloudflaredHttpProxy !== undefined) {
      proposed.cloudflaredHttpProxy = tunnelUpdate.cloudflaredHttpProxy;
    }
    if (tunnelUpdate?.ngrokDomain !== undefined) {
      proposed.ngrokDomain = tunnelUpdate.ngrokDomain;
    }
    if (tunnelUpdate?.ngrokUseHttpProxy !== undefined) {
      proposed.ngrokUseHttpProxy = tunnelUpdate.ngrokUseHttpProxy;
    }
    if (tunnelUpdate?.localtunnelHost !== undefined) {
      proposed.localtunnelHost = tunnelUpdate.localtunnelHost;
    }
    if (tunnelUpdate?.localtunnelHttpProxy !== undefined) {
      proposed.localtunnelHttpProxy = tunnelUpdate.localtunnelHttpProxy;
    }
    if (tunnelUpdate?.localtunnelSubdomain !== undefined) {
      proposed.localtunnelSubdomain = tunnelUpdate.localtunnelSubdomain;
    }
    proposed.cloudflaredHttpProxy = this.normalizeHttpProxy(
      proposed.cloudflaredHttpProxy,
      'cloudflared HTTP proxy',
    );
    proposed.localtunnelHttpProxy = this.normalizeHttpProxy(
      proposed.localtunnelHttpProxy,
      'localtunnel HTTP proxy',
    );
    proposed.cloudflareNamedDomain = this.normalizeDomain(
      proposed.cloudflareNamedDomain,
      'Cloudflare Named Tunnel domain',
    );
    proposed.ngrokDomain = this.normalizeDomain(proposed.ngrokDomain, 'ngrok domain');
    proposed.cloudflareEdgeAuthority = this.normalizeEdgeAuthority(
      proposed.cloudflareEdgeAuthority,
    );
    if (Boolean(proposed.cloudflaredHttpProxy) !== Boolean(proposed.cloudflareEdgeAuthority)) {
      throw new Error(
        'Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together',
      );
    }
    if (proposed.provider === 'cloudflare-named' && !proposed.cloudflareNamedDomain) {
      throw new Error('Cloudflare Named Tunnel requires a public hostname');
    }
    if (proposed.provider === 'ngrok' && !proposed.ngrokDomain) {
      throw new Error('ngrok requires a reserved domain');
    }
    if (update.allowedOrigins !== undefined) {
      proposedOrigins = normalizeAllowedOrigins(update.allowedOrigins);
    }
    if (update.allowSecretPathOnly !== undefined) {
      proposedAllowSecretPathOnly = update.allowSecretPathOnly;
    }

    const tokenKey = proposed.cloudflareNamedTokenKey ?? 'cloudflare-tunnel-token';
    const tokenProvided = Object.prototype.hasOwnProperty.call(
      tunnelUpdate ?? {},
      'cloudflareNamedToken',
    );
    const previousToken = tokenProvided ? await this.secrets.get(tokenKey) : undefined;
    try {
      if (tokenProvided) {
        const token = tunnelUpdate?.cloudflareNamedToken?.trim() ?? '';
        if (token) {
          await this.secrets.set(tokenKey, token);
        } else {
          await this.secrets.delete(tokenKey);
        }
      }
      this.config.tunnel = proposed;
      this.config.allowSecretPathOnly = proposedAllowSecretPathOnly;
      this.config.allowedOrigins = proposedOrigins;
      await this.onConfigChanged?.(this.config);
      this.updateStatus({ tunnelProvider: proposed.provider, error: undefined });
      return this.getConfigSnapshot();
    } catch (error) {
      this.config.tunnel = current;
      this.config.allowSecretPathOnly = currentAllowSecretPathOnly;
      this.config.allowedOrigins = currentOrigins;
      if (tokenProvided) {
        if (previousToken) {
          await this.secrets.set(tokenKey, previousToken);
        } else {
          await this.secrets.delete(tokenKey);
        }
      }
      throw error;
    }
  }

  async getConnectionInfo(): Promise<BridgeConnectionInfo> {
    const base: BridgeConnectionInfo = {
      state: this.statusValue.state,
      tunnelProvider: this.statusValue.tunnelProvider,
      instructions: this.statusValue.state === 'running'
        ? this.config.allowSecretPathOnly
          ? 'Use the MCP URL with a Streamable HTTP MCP connector. Keep the secret URL private.'
          : 'Use the MCP URL with a Streamable HTTP MCP connector. Keep the URL and bearer token private.'
        : 'Start the Bridge first. Connection details are withheld until the Bridge is running.',
    };
    if (this.statusValue.state !== 'running') {
      return base;
    }

    const connection: BridgeConnectionInfo = {
      ...base,
      connectionTarget: this.statusValue.publicOrigin === undefined ? 'local' : 'public',
      ...(this.statusValue.mcpUrl ? { mcpUrl: this.statusValue.mcpUrl } : {}),
      ...(this.statusValue.healthUrl ? { healthUrl: this.statusValue.healthUrl } : {}),
      ...(this.statusValue.publicOrigin ? { publicOrigin: this.statusValue.publicOrigin } : {}),
    };
    if (this.config.requireBearerToken) {
      const bearerToken = await this.secrets.get(BEARER_TOKEN);
      if (bearerToken) {
        return { ...connection, bearerToken };
      }
    }
    return connection;
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<BridgeStatus> {
    if (this.disposePromise) {
      throw new Error('Bridge runtime has been disposed');
    }
    if (this.statusValue.state === 'running') {
      return this.statusValue;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<BridgeStatus> {
    let stage = 'initializing';
    this.updateStatus({
      state: 'starting',
      localOrigin: undefined,
      publicOrigin: undefined,
      mcpUrl: undefined,
      healthUrl: undefined,
      startedAt: undefined,
      error: undefined,
    });
    try {
      stage = 'waiting for workspace adapter';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
      const adapter = await this.adapterPromise;
      stage = 'loading MCP path secret';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
      const pathSecret = await ensureSecret(this.secrets, MCP_PATH_SECRET);
      stage = 'loading bearer token';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
      const bearerToken = this.config.requireBearerToken
        ? await ensureSecret(this.secrets, BEARER_TOKEN)
        : undefined;
      stage = 'registering MCP HTTP routes';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
      const oauthSigningKey = await ensureSecret(this.secrets, OAUTH_SIGNING_KEY);
      const localPairingToken = await ensureSecret(this.secrets, LOCAL_PAIRING_TOKEN_SECRET);
      const http = new BridgeHttpServer({
        config: this.config,
        adapter,
        secretPath: pathSecret,
        bearerToken,
        allowSecretPathOnly: this.config.allowSecretPathOnly,
        statelessMcp: true,
       localConnectorPort: this.config.localConnectorPort,
       localPairingToken,
        oauthSigningKey,
       oauthSecretStore: this.oauthSecretStore,
       ...(this.httpCarrier ? { carrier: this.httpCarrier } : {}),
       ...(this.onAccessLog ? { onAccessLog: this.onAccessLog } : {}),
      });
      await http.start();
      this.http = http;
      console.info('[dsh-browser-bridge] HTTP routes started', {
        localOrigin: http.localOrigin,
      });
      stage = 'checking local MCP health';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
      if (this.httpCarrier) {
        // DSH owns the carrier's authentication and network policy. Route
        // registration is the local-only readiness signal; probing it back
        // through the host server can fail for host-level reasons that do not
        // indicate the Bridge's own route is unavailable.
        await this.waitForLocalConnector(http);
      } else {
        await this.waitForHealth(
          http.localOrigin + http.healthPath,
          this.config.tunnel.publicHealthTimeoutMs,
          bearerToken,
        );
      }

      if (this.config.tunnel.provider === 'none') {
        const startedAt = new Date().toISOString();
        this.updateStatus({
          state: 'running',
          localOrigin: http.localOrigin,
          publicOrigin: http.localOrigin,
          mcpUrl: `${http.localOrigin}${http.mcpPath}`,
          healthUrl: `${http.localOrigin}${http.healthPath}`,
          tunnelProvider: 'none',
          startedAt,
          error: undefined,
        });
        console.info('[dsh-browser-bridge] local-only startup completed');
        return this.statusValue;
      }

      stage = 'starting tunnel';
      console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
    const tunnel = this.tunnelFactory
      ? this.tunnelFactory(this.config.tunnel, this.secrets)
      : new TunnelManager(this.config.tunnel, this.secrets);
    this.tunnel = tunnel;
    const publicTunnel = await tunnel.start(http.localOrigin);
    http.allowPublicOrigin(publicTunnel.publicOrigin);
    const publicHealth = `${publicTunnel.publicOrigin}${http.healthPath}`;
    let publicHealthWarning: string | undefined;
    let publicHealthVerified = false;
    if (!(this.httpCarrier && publicTunnel.provider === 'none')) {
        stage = 'checking public MCP health';
        console.info(`[dsh-browser-bridge] startup stage: ${stage}`);
        try {
          await this.waitForHealth(
            publicHealth,
            this.config.tunnel.publicHealthTimeoutMs,
            this.config.allowSecretPathOnly ? undefined : bearerToken,
          );
          publicHealthVerified = true;
        } catch (error) {
          // A public URL means the tunnel process registered successfully. If
          // only the local self-check cannot traverse TUN/proxy DNS, keep the
          // remote entry available instead of tearing it down.
          publicHealthWarning = error instanceof Error ? error.message : String(error);
          console.warn('[dsh-browser-bridge] public health check failed', {
            error: publicHealthWarning,
          });
        }
      }
      const startedAt = new Date().toISOString();
      this.updateStatus({
        state: 'running',
        localOrigin: http.localOrigin,
        publicOrigin: publicTunnel.publicOrigin,
        mcpUrl: `${publicTunnel.publicOrigin}${http.mcpPath}`,
        healthUrl: publicHealth,
        tunnelProvider: publicTunnel.provider,
        startedAt,
        ...(publicHealthWarning ? { error: publicHealthWarning } : { error: undefined }),
      });
     this.startTunnelMonitor(publicTunnel, publicHealth, publicHealthVerified, bearerToken);
     console.info('[dsh-browser-bridge] startup completed');
     this.onStartupDiagnostic?.({
       stage: 'runtime-started',
       tunnelProvider: this.statusValue.tunnelProvider,
       localOrigin: this.statusValue.localOrigin,
       publicOrigin: this.statusValue.publicOrigin,
        publicHealthVerified,
     });
      return this.statusValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dsh-browser-bridge] startup failed while ${stage}: ${message}`);
      await this.stopInternal();
      this.updateStatus({ state: 'failed', error: message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise && this.statusValue.state === 'starting') {
      try {
        await this.startPromise;
      } catch {
        // A failed start already tears down partially acquired resources.
      }
    }
    if (this.statusValue.state === 'stopped') {
      return;
    }
    this.updateStatus({ state: 'stopping' });
    await this.stopInternal();
    this.updateStatus({
      state: 'stopped',
      localOrigin: undefined,
      publicOrigin: undefined,
      mcpUrl: undefined,
      healthUrl: undefined,
      startedAt: undefined,
      error: undefined,
    });
  }

  reportProgress(progress: Omit<BridgeProgress, 'updatedAt'>): BridgeProgress {
    const adapter = this.getAdapterIfReady();
    if (!adapter) {
      throw new Error('Workspace adapter is not ready');
    }
    const value = adapter.reportProgress(progress);
    this.emit({ type: 'progress', progress: value, at: new Date().toISOString() });
    return value;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Continue with final cleanup after a failed in-flight start.
          }
        }
        await this.stop();
        const adapter = await this.adapterPromise;
        await adapter.dispose();
      })();
    }
    await this.disposePromise;
  }

  async resetPath(): Promise<void> {
    await this.stop();
    await this.secrets.delete(MCP_PATH_SECRET);
  }

  createOAuthPairingCode(): import('./types.js').OAuthPairingCode {
    if (!this.http) {
      throw new Error('Bridge is not running');
    }
    return this.http.createOAuthPairingCode();
  }

  async revokeAllOAuthGrants(): Promise<void> {
    await this.http?.revokeAllOAuthGrants();
  }

  private getAdapterIfReady(): WorkspaceAdapter | undefined {
    return this.adapterValue;
  }

  private async stopInternal(): Promise<void> {
    this.tunnelMonitor?.cancel();
    this.tunnelMonitor = undefined;
    await this.tunnel?.stop();
    this.tunnel = undefined;
    await this.http?.stop();
    this.http = undefined;
  }

  private normalizeDomain(value: string | undefined, label: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`${label} must be a valid hostname`);
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
    ) {
      throw new Error(`${label} must be an HTTPS hostname without a path`);
    }
    return parsed.host;
  }

  private normalizeEdgeAuthority(value: string | undefined): string | undefined {
    const trimmed = value?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!trimmed) return undefined;
    const match = trimmed.match(/^([^\s:/]+):(\d+)$/);
    if (!match || Number(match[2]) <= 0 || Number(match[2]) > 65_535) {
      throw new Error('Cloudflare Edge authority must be host:port');
    }
    return trimmed;
  }

  private normalizeHttpProxy(value: string | undefined, label: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`${label} must be a valid URL`);
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`${label} must be a valid URL`);
    }
    return parsed.toString().replace(/\/$/, '');
  }

  private updateStatus(status: Partial<BridgeStatus>): void {
    this.statusValue = { ...this.statusValue, ...status };
    this.emit({ type: 'status', status: this.statusValue, at: new Date().toISOString() });
  }

  private startTunnelMonitor(
    tunnel: TunnelHandle,
    healthUrl: string,
    healthVerifiedAtStartup: boolean,
    bearerToken: string | undefined,
  ): void {
    this.tunnelMonitor?.cancel();

    let cancelled = false;
    let healthTimer: NodeJS.Timeout | undefined;
    let healthCheckRunning = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      if (healthTimer) clearTimeout(healthTimer);
    };
    this.tunnelMonitor = { cancel };

    const fail = async (message: string): Promise<void> => {
      if (cancelled || this.statusValue.state !== 'running') return;
      cancel();
      console.error(`[dsh-browser-bridge] runtime became unhealthy: ${message}`);
      this.onStartupDiagnostic?.({
        stage: 'runtime-failed',
        tunnelProvider: this.statusValue.tunnelProvider,
        message,
      });
      this.updateStatus({ state: 'failed', error: message });
      try {
        await this.stopInternal();
      } catch (error) {
        console.error('[dsh-browser-bridge] failed to stop unhealthy runtime', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    if (tunnel.waitForExit) {
      void tunnel.waitForExit().then(
        (exit: TunnelExit) => {
          if (cancelled) return;
          const detail = exit.signal ?? exit.code ?? 'unknown status';
          void fail(`Tunnel exited unexpectedly (${detail})`);
        },
        error => {
          if (cancelled) return;
          void fail(`Tunnel exited unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    }

    const check = (): void => {
      if (cancelled || this.statusValue.state !== 'running') return;
      if (healthCheckRunning) {
        schedule(5_000);
        return;
      }
      healthCheckRunning = true;
      void this.waitForHealth(healthUrl, 10_000, this.config.allowSecretPathOnly ? undefined : bearerToken)
        .catch(error => {
          void fail(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          healthCheckRunning = false;
          if (!cancelled && this.statusValue.state === 'running') schedule(60_000);
        });
    };
    const schedule = (delayMs: number): void => {
      healthTimer = setTimeout(check, delayMs);
    };
    schedule(60_000);
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async waitForHealth(url: string, timeoutMs: number, bearerToken?: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'unknown error';
    while (Date.now() < deadline) {
      try {
        const response = await new Promise<{ statusCode: number | undefined }>((resolve, reject) => {
          const parsed = new URL(url);
          const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
          const req = requestFn({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            ...(bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {}),
            timeout: Math.min(2_000, Math.max(100, deadline - Date.now())),
          }, (res) => {
            res.resume();
            res.once('end', () => resolve({ statusCode: res.statusCode }));
          });
          req.once('error', reject);
          req.end();
        });
        if (response.statusCode === 200) {
          return;
        }
        lastError = `HTTP ${response.statusCode ?? 'unknown'}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Health check failed for ${url}: ${lastError}`);
  }

  private async waitForLocalConnector(http: BridgeHttpServer): Promise<void> {
    if (!http.localConnector.running) {
      throw new Error('Local connector is not running');
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (!http.localConnector.running) {
      throw new Error('Local connector stopped during startup');
    }
  }
}

function normalizeAllowedOrigins(values: string[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (!origin) {
      throw new Error(`Invalid allowed origin: "${value}"`);
    }
    origins.add(origin);
  }
  return [...origins].sort((left, right) => left.localeCompare(right));
}
