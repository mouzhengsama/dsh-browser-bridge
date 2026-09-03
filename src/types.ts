export type TunnelProviderId =
  | 'none'
  | 'cloudflare'
  | 'cloudflare-named'
  | 'ngrok'
  | 'localtunnel';

export interface CapabilityConfig {
  read: boolean;
  write: boolean;
  command: boolean;
  lsp: boolean;
  progress: boolean;
}

export interface BridgeLimits {
  requestBodyLimit: string;
  requestsPerMinute: number;
  maxConcurrentRequests: number;
  maxReadBytes: number;
  maxSearchResults: number;
  maxCommandOutputBytes: number;
  defaultCommandWaitMs: number;
  maxCommandWaitMs: number;
}

export type CommandRuntimeId = 'auto' | 'dsh' | 'local';

export interface LanguageServerConfig {
  id: string;
  extensions: string[];
  command: string;
  args: string[];
  languageId?: string | undefined;
  initializationOptions?: unknown | undefined;
}

export interface TunnelConfig {
  provider: TunnelProviderId;
  cloudflareNamedDomain?: string | undefined;
  cloudflareNamedTokenKey?: string | undefined;
  cloudflareEdgeBindAddress?: string | undefined;
  cloudflareEdgeAuthority?: string | undefined;
  cloudflaredHttpProxy?: string | undefined;
  ngrokDomain?: string | undefined;
  ngrokUseHttpProxy: boolean;
  localtunnelHost?: string | undefined;
  localtunnelHttpProxy?: string | undefined;
  localtunnelSubdomain?: string | undefined;
  startupTimeoutMs: number;
  publicHealthTimeoutMs: number;
  cloudflaredPath: string;
  ngrokPath: string;
}

export interface BridgeTunnelConfigSnapshot {
  provider: TunnelProviderId;
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
}

export interface BridgeConfigSnapshot {
  editable: boolean;
  allowSecretPathOnly: boolean;
  tunnel: BridgeTunnelConfigSnapshot;
  allowedOrigins: string[];
}

export interface BridgeConfigUpdate {
  allowSecretPathOnly?: boolean | undefined;
  allowedOrigins?: string[] | undefined;
  tunnel?: {
    provider?: TunnelProviderId | undefined;
    cloudflareNamedDomain?: string | undefined;
    cloudflareNamedToken?: string | undefined;
    cloudflareEdgeBindAddress?: string | undefined;
    cloudflareEdgeAuthority?: string | undefined;
    cloudflaredHttpProxy?: string | undefined;
    ngrokDomain?: string | undefined;
    ngrokUseHttpProxy?: boolean | undefined;
    localtunnelHost?: string | undefined;
    localtunnelHttpProxy?: string | undefined;
    localtunnelSubdomain?: string | undefined;
  };
}

export interface OAuthPairingCode {
  code: string;
  expiresAt: number;
}

export interface BridgeConfig {
  workspaceRoot: string;
  host: string;
  port: number;
  localConnectorPort: number;
  requireBearerToken: boolean;
  allowSecretPathOnly: boolean;
  allowedOrigins: string[];
  capabilities: CapabilityConfig;
  limits: BridgeLimits;
  tunnel: TunnelConfig;
  languageServers: LanguageServerConfig[];
  persistentMode: boolean;
  commandRuntime: CommandRuntimeId;
}

export interface BridgeProgress {
  stage: string;
  message: string;
  percent?: number | undefined;
  completed?: boolean | undefined;
  updatedAt: string;
}

export interface BridgeStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  localOrigin?: string | undefined;
  publicOrigin?: string | undefined;
  mcpUrl?: string | undefined;
  healthUrl?: string | undefined;
  tunnelProvider: TunnelProviderId;
  startedAt?: string | undefined;
  error?: string | undefined;
}

export interface BridgeConnectionInfo {
  state: BridgeStatus['state'];
  tunnelProvider: TunnelProviderId;
  connectionTarget?: 'local' | 'public' | undefined;
  mcpUrl?: string | undefined;
  healthUrl?: string | undefined;
  publicOrigin?: string | undefined;
  bearerToken?: string | undefined;
  instructions: string;
}

export interface BridgeEvent {
  type: 'status' | 'progress' | 'log';
  status?: BridgeStatus | undefined;
  progress?: BridgeProgress | undefined;
  message?: string | undefined;
  at: string;
}

export interface VersionedFile {
  path: string;
  version: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number | undefined;
}

export interface TextSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface PatchResult {
  changed: Array<{
    path: string;
    operation: 'create' | 'update' | 'delete';
    version?: string;
  }>;
}

export interface RunCommandOptions {
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  waitMs?: number | undefined;
}

export interface LspQueryOptions {
  operation: 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover';
  path: string;
  line: number;
  character: number;
}

export interface CommandOutput {
  commandId: string;
  command: string;
  status: 'running' | 'exited' | 'failed';
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  output: string;
  offset: number;
  nextOffset: number;
  baseOffset: number;
  truncatedBeforeOffset: boolean;
  startedAt: string;
  endedAt?: string | undefined;
}

export interface WorkspaceAdapter {
  readonly workspaceRoot: string;
  listFiles(patterns?: string[], limit?: number): Promise<WorkspaceEntry[]>;
  listDirectory(directory?: string, depth?: number, limit?: number): Promise<WorkspaceEntry[]>;
  searchText(
    query: string,
    options?: {
      isRegex?: boolean | undefined;
      caseSensitive?: boolean | undefined;
      include?: string[] | undefined;
      limit?: number | undefined;
    },
  ): Promise<TextSearchMatch[]>;
  readFile(filePath: string, startLine?: number, endLine?: number): Promise<VersionedFile>;
  applyPatch(patch: string, expectedVersions?: Record<string, string>): Promise<PatchResult>;
  runCommand(options: RunCommandOptions): Promise<CommandOutput>;
  getCommandOutput(commandId: string, offset?: number, waitMs?: number): Promise<CommandOutput>;
  sendCommandInput(commandId: string, input: string, close?: boolean): Promise<CommandOutput>;
  terminateCommand(commandId: string): Promise<CommandOutput>;
  getDiagnostics(filePath?: string, waitMs?: number): Promise<unknown>;
  queryLsp?(options: LspQueryOptions): Promise<unknown>;
  reportProgress(progress: Omit<BridgeProgress, 'updatedAt'>): BridgeProgress;
  getProgress(): BridgeProgress | undefined;
  dispose(): Promise<void>;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
