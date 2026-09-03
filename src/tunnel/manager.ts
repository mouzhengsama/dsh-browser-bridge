import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import net from 'node:net';
import type { Socket } from 'node:net';
import type { TunnelConfig, TunnelProviderId } from '../types.js';
import type { SecretStore } from '../types.js';

export interface TunnelHandle {
  provider: TunnelProviderId;
  publicOrigin: string;
  waitForExit?: (() => Promise<TunnelExit>) | undefined;
  close(): Promise<void>;
}

export interface TunnelExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TunnelProcess {
  child: ChildProcessWithoutNullStreams;
  output: AsyncIterable<string>;
}

export interface ParsedProxyTarget {
  host: string;
  port: number;
  protocol: 'http:' | 'https:';
  authorization?: string | undefined;
}

export interface LocaltunnelClient {
  url: string;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

interface LocaltunnelRegistration {
  id: string;
  ip?: string | undefined;
  port: number;
  url: string;
  max_conn_count?: number | undefined;
}

class HeaderHostTransformer extends Transform {
  private replaced = false;

  constructor(private readonly host: string) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    if (this.replaced) {
      callback(null, chunk);
      return;
    }
    const text = chunk.toString('latin1');
    const replaced = text.replace(/(\r\n[Hh]ost: )\S+/, (_match, prefix: string) => {
      this.replaced = true;
      return `${prefix}${this.host}`;
    });
    callback(null, Buffer.from(replaced, 'latin1'));
  }
}

interface LocaltunnelSocketPair {
  remote: Socket;
  local: Socket;
}

type LocaltunnelFactory = (options: {
  port: number;
  host?: string | undefined;
  subdomain?: string | undefined;
  local_host?: string | undefined;
}) => Promise<LocaltunnelClient>;

const require = createRequire(import.meta.url);
const defaultLocaltunnel: LocaltunnelFactory = require('localtunnel');

export type TunnelProcessFactory = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
) => TunnelProcess;

const HTTP_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const;

function processEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function disabledHttpProxyEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    HTTP_PROXY_ENV_KEYS.map((key) => [key, undefined]),
  );
}

async function* readLines(stream: Readable): AsyncGenerator<string> {
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk.toString();
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      yield line;
    }
  }
  if (pending) {
    yield pending;
  }
}

async function* mergeOutput(
  streams: Readable[],
): AsyncGenerator<string> {
  const iterators = streams.map((stream) => readLines(stream)[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<string> }>>();
  const schedule = (index: number): void => {
    pending.set(index, iterators[index]!.next().then((result) => ({ index, result })));
  };
  iterators.forEach((_iterator, index) => schedule(index));

  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);
      if (result.done) {
        continue;
      }
      schedule(index);
      yield result.value;
    }
  } finally {
    await Promise.allSettled(iterators.map((iterator) => iterator.return?.(undefined)));
  }
}

export function spawnTunnelProcess(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): TunnelProcess {
  const child = spawn(command, args, {
    env: processEnvironment(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  child.once('error', () => undefined);
  return { child, output: mergeOutput([child.stdout, child.stderr]) };
}

function closeProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    const graceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      forceTimer = setTimeout(finish, 500);
    }, 2_000);

    child.once('close', finish);
    child.once('error', finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    child.kill();
  });
}

interface ProcessExit {
  error?: Error;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessExitWatch {
  promise: Promise<ProcessExit>;
  cleanup(): void;
}

interface ManagedTunnelExitWatch extends ProcessExitWatch {
  cancel(): void;
}

function watchManagedProcessExit(
  child: ChildProcessWithoutNullStreams,
): ManagedTunnelExitWatch {
  const watch = watchProcessExit(child);
  let cancelled = false;
  return {
    promise: watch.promise.then(exit => {
      if (cancelled) return new Promise<TunnelExit>(() => undefined);
      return exit;
    }),
    cleanup: watch.cleanup,
    cancel: () => {
      cancelled = true;
      watch.cleanup();
    },
  };
}

function watchProcessExit(child: ChildProcessWithoutNullStreams): ProcessExitWatch {
  let onError: ((error: Error) => void) | undefined;
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const promise = new Promise<ProcessExit>((resolve) => {
    onError = (error) => resolve({ error, code: null, signal: null });
    onClose = (code, signal) => resolve({ code, signal });
    child.once('error', onError);
    child.once('close', onClose);
  });
  return {
    promise,
    cleanup: () => {
      if (onError) child.off('error', onError);
      if (onClose) child.off('close', onClose);
    },
  };
}

interface TunnelWaitEvent {
  kind: 'output' | 'exit' | 'timeout';
  result?: IteratorResult<string>;
  exit?: ProcessExit;
}

function extractHttpsUrl(line: string): string | undefined {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0]?.replace(/[),.]+$/, '');
}

function normalizePublicOrigin(url: string): string {
  return url.replace(/\/+$/, '');
}

export function parseProxyTarget(proxyUrl: string): ParsedProxyTarget | undefined {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0) {
      return undefined;
    }
    let authorization: string | undefined;
    if (parsed.username || parsed.password) {
      const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
      authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    return {
      host: parsed.hostname,
      port,
      protocol: parsed.protocol,
      authorization,
    };
  } catch {
    return undefined;
  }
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function normalizeTunnelHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  return /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function proxyConnect(proxyUrl: string, authority: string): Promise<Socket> {
  const proxy = parseProxyTarget(proxyUrl);
  if (!proxy) {
    return Promise.reject(new Error('Invalid localtunnel HTTP proxy URL'));
  }
  const request = proxy.protocol === 'https:'
    ? httpsRequest({
      method: 'CONNECT',
      host: proxy.host,
      port: proxy.port,
      path: authority,
      headers: {
        Host: authority,
        ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}),
      },
    })
    : httpRequest({
      method: 'CONNECT',
      host: proxy.host,
      port: proxy.port,
      path: authority,
      headers: {
        Host: authority,
        ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}),
      },
    });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      request.destroy();
      reject(error);
    };
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`HTTP proxy CONNECT failed with ${response.statusCode ?? 'unknown status'}`));
        return;
      }
      socket.setKeepAlive(true);
      resolve(socket);
    });
    request.once('error', fail);
    request.end();
  });
}

class CloudflareEdgeProxyRelay {
  readonly #server: import('node:net').Server;
  readonly #closeAllConnections: (() => void) | undefined;
  readonly #connections = new Set<Socket>();
  #closed = false;

  constructor(
    private readonly proxyUrl: string,
    private readonly authority: string,
  ) {
    this.#server = net.createServer(socket => {
      void this.#openPair(socket);
    });
    this.#server.on('connection', socket => this.#connections.add(socket));
    this.#closeAllConnections = (this.#server as {
      closeAllConnections?: () => void;
    }).closeAllConnections?.bind(this.#server);
  }

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once('error', onError);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', onError);
        const address = this.#server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine Cloudflare edge relay port'));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    await new Promise<void>(resolve => {
      this.#server.close(() => resolve());
      this.#closeAllConnections?.();
    });
  }

  async #openPair(local: Socket): Promise<void> {
    let remote: Socket | undefined;
    try {
      remote = await proxyConnect(this.proxyUrl, this.authority);
      remote.pipe(local);
      local.pipe(remote);
      const closePair = (): void => {
        local.destroy();
        remote?.destroy();
        this.#connections.delete(local);
        this.#connections.delete(remote ?? local);
      };
      local.once('close', closePair);
      remote.once('close', closePair);
      local.once('error', closePair);
      remote.once('error', closePair);
    } catch {
      local.destroy();
      remote?.destroy();
      this.#connections.delete(local);
      this.#connections.delete(remote ?? local);
    }
  }
}

async function readJsonResponse(response: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`localtunnel server returned invalid JSON: ${body.slice(0, 200)}`);
  }
}

async function registerLocaltunnelThroughProxy(
  proxyUrl: string,
  registryUrl: URL,
): Promise<LocaltunnelRegistration> {
  const authority = registryUrl.hostname + (registryUrl.port ? `:${registryUrl.port}` : '');
    const socket = await proxyConnect(proxyUrl, authority);
    try {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = registryUrl.protocol === 'https:'
        ? httpsRequest({
          createConnection: () => require('node:tls').connect({
            socket,
            servername: registryUrl.hostname,
          }),
          protocol: 'https:',
          hostname: registryUrl.hostname,
          port: registryUrl.port || 443,
          path: `${registryUrl.pathname}${registryUrl.search}`,
          method: 'GET',
          headers: { Accept: 'application/json' },
        }, resolve)
        : httpRequest({
          createConnection: () => socket,
          protocol: 'http:',
          hostname: registryUrl.hostname,
          port: registryUrl.port || 80,
          path: `${registryUrl.pathname}${registryUrl.search}`,
          method: 'GET',
          headers: { Accept: 'application/json' },
        }, resolve);
      request.once('error', reject);
      request.end();
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`localtunnel registration failed with HTTP ${response.statusCode}`);
    }
    const value = await readJsonResponse(response);
    if (
      !value
      || typeof value !== 'object'
      || typeof (value as { id?: unknown }).id !== 'string'
      || typeof (value as { port?: unknown }).port !== 'number'
      || typeof (value as { url?: unknown }).url !== 'string'
    ) {
      throw new Error('localtunnel registration returned an incomplete tunnel description');
    }
    return value as LocaltunnelRegistration;
    } finally {
      // The HTTP response owns the connection after a successful request.
      // Destroy only when registration fails before response completion.
      if (!socket.destroyed && !socket.readableEnded) {
        socket.destroy();
      }
    }
}

class ProxiedLocaltunnelClient implements LocaltunnelClient {
  readonly url: string;
  private readonly sockets = new Set<LocaltunnelSocketPair>();
  private readonly reconnectTimers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly proxyUrl: string,
    registration: LocaltunnelRegistration,
    registryHost: URL,
    private readonly localHost: string,
    private readonly localPort: number,
    private readonly onUrlAssigned?: (url: string) => void,
  ) {
    this.url = registration.url;
    this.onUrlAssigned?.(this.url);
    const connectionCount = Math.max(1, registration.max_conn_count ?? 1);
    const remoteHost = registration.ip ?? registryHost.hostname;
    for (let index = 0; index < connectionCount; index += 1) {
      void this.openConnection(`${remoteHost}:${registration.port}`);
    }
  }

  on(event: 'error', listener: (error: Error) => void): unknown {
    void event;
    void listener;
    return this;
  }

  close(): void {
    this.closed = true;
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const pair of this.sockets) {
      pair.remote.destroy();
      pair.local.destroy();
    }
    this.sockets.clear();
  }

  private async openConnection(authority: string): Promise<void> {
    if (this.closed) return;
    let remote: Socket | undefined;
    let local: Socket | undefined;
    try {
      remote = await proxyConnect(this.proxyUrl, authority);
      local = await new Promise<Socket>((resolve, reject) => {
        const socket = netConnect(this.localPort, this.localHost);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
      const pair: LocaltunnelSocketPair = { remote, local };
      this.sockets.add(pair);
      this.pairSockets(pair, authority);
    } catch {
      remote?.destroy();
      local?.destroy();
      this.scheduleReconnect(authority);
    }
  }

  private pairSockets(pair: LocaltunnelSocketPair, authority: string): void {
    const { remote, local } = pair;
    let paired = false;
    const failPair = (): void => {
      if (this.closed) return;
      this.sockets.delete(pair);
      remote.destroy();
      local.destroy();
      this.scheduleReconnect(authority);
    };
    const onLocalConnect = (): void => {
      if (paired || this.closed) return;
      paired = true;
      remote.pipe(new HeaderHostTransformer(`${this.localHost}:${this.localPort}`)).pipe(local);
      local.pipe(remote);
    };
    const closePair = (): void => {
      if (this.closed) return; // close() performs the final cleanup.
      this.sockets.delete(pair);
      this.scheduleReconnect(authority);
    };
    onLocalConnect();
    remote.once('close', closePair);
    local.once('close', closePair);
    remote.once('error', failPair);
    local.once('error', failPair);
  }

  private scheduleReconnect(authority: string): void {
    if (this.closed || this.reconnectTimers.size >= 8) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(timer);
      void this.openConnection(authority);
    }, 500);
    this.reconnectTimers.add(timer);
  }
}

export class TunnelManager {
  private readonly processFactory: TunnelProcessFactory;
  private active: TunnelHandle | undefined;
  readonly localtunnel: LocaltunnelFactory;

  constructor(
    private readonly config: TunnelConfig,
    private readonly secrets: SecretStore,
    processFactory: TunnelProcessFactory = spawnTunnelProcess,
  ) {
    this.processFactory = processFactory;
    this.localtunnel = defaultLocaltunnel;
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  async start(localOrigin: string): Promise<TunnelHandle> {
    if (this.active) {
      return this.active;
    }
    const handle = this.config.provider === 'none'
      ? {
        provider: 'none' as const,
        publicOrigin: localOrigin,
        waitForExit: undefined,
        close: async () => undefined,
      }
      : await this.startExternal(localOrigin);
    this.active = handle;
    return handle;
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.close();
  }

  async checkInstalled(): Promise<Record<'cloudflared' | 'ngrok', boolean>> {
    const [cloudflared, ngrok] = await Promise.all([
      this.commandAvailable(this.config.cloudflaredPath, ['--version']),
      this.commandAvailable(this.config.ngrokPath, ['version']),
    ]);
    return { cloudflared, ngrok };
  }

  private async startExternal(localOrigin: string): Promise<TunnelHandle> {
    switch (this.config.provider) {
      case 'cloudflare':
        return this.startCloudflareQuick(localOrigin);
      case 'cloudflare-named':
        return this.startCloudflareNamed(localOrigin);
      case 'ngrok':
        return this.startNgrok(localOrigin);
      case 'localtunnel':
        return this.startLocaltunnel(localOrigin);
      default:
        throw new Error(`Unsupported tunnel provider: ${this.config.provider}`);
    }
  }

  private async startCloudflareQuick(localOrigin: string): Promise<TunnelHandle> {
    const edgeArgs = this.config.cloudflareEdgeBindAddress
      ? ['--edge-bind-address', this.config.cloudflareEdgeBindAddress]
      : [];
    const relay = this.config.cloudflaredHttpProxy
      ? await this.startCloudflareEdgeRelay()
      : undefined;
    const edgeOverride = relay ? ['--edge', relay.authority] : [];
    const process = this.processFactory(
      this.config.cloudflaredPath,
      [
        'tunnel', '--protocol', 'http2', '--no-autoupdate',
        ...edgeArgs, ...edgeOverride, '--url', localOrigin,
      ],
      undefined,
    );
    const publicOrigin = await this.waitForQuickTunnel(process, 'Cloudflare Quick Tunnel');
    const exitWatch = watchManagedProcessExit(process.child);
    return {
      provider: 'cloudflare',
      publicOrigin,
      waitForExit: () => exitWatch.promise,
      close: async () => {
        exitWatch.cancel();
        await closeProcess(process.child);
        await relay?.close();
      },
    };
  }

  private async startCloudflareNamed(localOrigin: string): Promise<TunnelHandle> {
    const domain = this.config.cloudflareNamedDomain;
    if (!domain) {
      throw new Error('Cloudflare Named Tunnel requires cloudflareNamedDomain');
    }
    const tokenKey = this.config.cloudflareNamedTokenKey ?? 'cloudflare-tunnel-token';
    const token = await this.secrets.get(tokenKey);
    if (!token) {
      throw new Error(`Cloudflare Named Tunnel token is missing from secret storage key "${tokenKey}"`);
    }
    const edgeArgs = this.config.cloudflareEdgeBindAddress
      ? ['--edge-bind-address', this.config.cloudflareEdgeBindAddress]
      : [];
    const relay = this.config.cloudflaredHttpProxy
      ? await this.startCloudflareEdgeRelay()
      : undefined;
    const edgeOverride = relay ? ['--edge', relay.authority] : [];
    const process = this.processFactory(
      this.config.cloudflaredPath,
      ['tunnel', '--protocol', 'http2', '--no-autoupdate', ...edgeArgs, ...edgeOverride, 'run'],
      { TUNNEL_TOKEN: token },
    );
    await this.waitForProcessReady(process, 'Cloudflare Named Tunnel');
    const exitWatch = watchManagedProcessExit(process.child);
    return {
      provider: 'cloudflare-named',
      publicOrigin: `https://${normalizeDomain(domain)}`,
      waitForExit: () => exitWatch.promise,
      close: async () => {
        exitWatch.cancel();
        await closeProcess(process.child);
        await relay?.close();
      },
    };
  }

  private async startCloudflareEdgeRelay(): Promise<
    { authority: string; close(): Promise<void> }
  > {
    if (!this.config.cloudflareEdgeAuthority) {
      throw new Error(
        'Cloudflare HTTP proxy requires a cloudflareEdgeAuthority such as region1.v2.argotunnel.com:7844',
      );
    }
    const relay = new CloudflareEdgeProxyRelay(
      this.config.cloudflaredHttpProxy!,
      this.config.cloudflareEdgeAuthority,
    );
    const authority = await relay.listen();
    return { authority, close: () => relay.close() };
  }

  private async startNgrok(localOrigin: string): Promise<TunnelHandle> {
    const domain = this.config.ngrokDomain;
    if (!domain) {
      throw new Error('ngrok requires ngrokDomain');
    }
    const process = this.processFactory(
      this.config.ngrokPath,
      ['http', `--url=${normalizeDomain(domain)}`, localOrigin, '--log=stdout', '--log-format=json'],
      this.config.ngrokUseHttpProxy ? undefined : disabledHttpProxyEnvironment(),
    );
    await this.waitForProcessReady(process, 'ngrok');
    const exitWatch = watchManagedProcessExit(process.child);
    return {
      provider: 'ngrok',
      publicOrigin: `https://${normalizeDomain(domain)}`,
      waitForExit: () => exitWatch.promise,
      close: async () => {
        exitWatch.cancel();
        await closeProcess(process.child);
      },
    };
  }

  private async startLocaltunnel(localOrigin: string): Promise<TunnelHandle> {
    const target = new URL(localOrigin);
    if (target.protocol !== 'http:') {
      throw new Error('localtunnel requires an HTTP local origin');
    }
    let fallbackForwardedHost: string | undefined;
    const forwardedHost = () => fallbackForwardedHost;
    const forwardingServer = createHttpServer((req, res) => {
      void this.forwardHttpRequest(req, res, target, forwardedHost);
    });
    forwardingServer.on('upgrade', (req, socket) => {
      this.forwardWebSocketUpgrade(req, socket as Socket, target, forwardedHost);
    });
    await new Promise<void>((resolve, reject) => {
      forwardingServer.once('error', reject);
      forwardingServer.listen(0, '127.0.0.1', () => resolve());
    });
    const forwardingPort = this.serverPort(forwardingServer);
    const closeForwardingServer = async (): Promise<void> => {
      await new Promise<void>(resolve => {
        forwardingServer.close(() => resolve());
        forwardingServer.closeAllConnections?.();
      });
    };

    const host = normalizeTunnelHost(this.config.localtunnelHost);
    const registryUrl = new URL(`${host ?? 'https://localtunnel.me'}/${this.config.localtunnelSubdomain ?? '?new'}`);
    const attempts = this.config.localtunnelHttpProxy ? 3 : 1;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let client: LocaltunnelClient;
      try {
        if (this.config.localtunnelHttpProxy) {
          const registration = await registerLocaltunnelThroughProxy(
            this.config.localtunnelHttpProxy,
            registryUrl,
          );
          fallbackForwardedHost = new URL(registration.url).host;
          client = new ProxiedLocaltunnelClient(
            this.config.localtunnelHttpProxy,
            registration,
            new URL(host ?? 'https://localtunnel.me'),
            '127.0.0.1',
            forwardingPort,
          );
        } else {
          client = await this.localtunnel({
            port: forwardingPort,
            ...(host ? { host } : {}),
            ...(this.config.localtunnelSubdomain
              ? { subdomain: this.config.localtunnelSubdomain }
              : {}),
            local_host: '127.0.0.1',
          });
          fallbackForwardedHost = new URL(client.url).host;
        }
        return {
          provider: 'localtunnel',
          publicOrigin: normalizePublicOrigin(client.url),
          waitForExit: undefined,
          close: async () => {
            client.close();
            await closeForwardingServer();
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === attempts) break;
        await new Promise(resolve => setTimeout(resolve, 750 * attempt));
      }
    }
    await closeForwardingServer();
    throw new Error(`localtunnel failed after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`);
  }

  private serverPort(server: import('node:http').Server): number {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to determine local forwarding port');
    }
    return address.port;
  }

  private async forwardHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    target: URL,
    fallbackHost: () => string | undefined,
  ): Promise<void> {
    const headers = { ...req.headers };
    const host = this.publicForwardedHost(headers) ?? fallbackHost();
    if (host) {
      headers['x-forwarded-host'] = host;
      headers['x-forwarded-proto'] = 'https';
    }
    headers.host = target.host;
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
    };
    const upstream = httpRequest(options, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    req.pipe(upstream);
    await new Promise<void>((resolve, reject) => {
      upstream.once('response', () => resolve());
      upstream.once('error', reject);
      res.once('close', reject);
    });
  }

  private forwardWebSocketUpgrade(
    req: IncomingMessage,
    socket: Socket,
    target: URL,
    fallbackHost: () => string | undefined,
  ): void {
    const headers = { ...req.headers };
    const host = this.publicForwardedHost(headers) ?? fallbackHost();
    if (host) {
      headers['x-forwarded-host'] = host;
      headers['x-forwarded-proto'] = 'https';
    }
    const upstream = httpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
    });
    upstream.once('upgrade', (res, upstreamSocket) => {
      socket.write(
        `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}\r\n` +
        Object.entries(res.headers)
          .filter(([_key, value]) => value !== undefined)
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n') + '\r\n\r\n',
      );
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.once('error', () => socket.destroy());
    upstream.end();
  }

  private publicForwardedHost(headers: Record<string, unknown>): string | undefined {
    const forwarded = headers['x-forwarded-host'];
    const value = Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded;
    return typeof value === 'string' && value.trim()
      ? value.split(',')[0]?.trim()
      : undefined;
  }

  private async waitForOrigin(process: TunnelProcess, label: string): Promise<string> {
    return this.consumeUntil(process, label, (line) => extractHttpsUrl(line));
  }

  private async waitForQuickTunnel(process: TunnelProcess, label: string): Promise<string> {
    let output = '';
    let publicOrigin: string | undefined;
    let edgeRegistered = false;
    const iterator = process.output[Symbol.asyncIterator]();
    const exitWatch = watchProcessExit(process.child);
    const deadline = Date.now() + this.config.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let timeout: NodeJS.Timeout | undefined;
        const next = await Promise.race([
          iterator.next().then((result): TunnelWaitEvent => ({ kind: 'output', result })),
          exitWatch.promise.then((exit): TunnelWaitEvent => ({ kind: 'exit', exit })),
          new Promise<TunnelWaitEvent>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (next.kind === 'exit' && next.exit) {
          const detail = next.exit.error ? `: ${next.exit.error.message}` : '';
          throw new Error(`${label} exited before becoming ready${detail}`);
        }
        if (next.kind === 'timeout') break;
        if (next.result?.done) {
          const exit = await exitWatch.promise;
          const detail = exit.error ? `: ${exit.error.message}` : '';
          throw new Error(`${label} exited before becoming ready${detail}`);
        }

        const line = next.result?.value;
        if (line === undefined) {
          const exit = await exitWatch.promise;
          const detail = exit.error ? `: ${exit.error.message}` : '';
          throw new Error(`${label} exited before becoming ready${detail}`);
        }
        output = `${output}\n${line}`.slice(-16_384);
        publicOrigin ??= extractHttpsUrl(line);
        if (/registered tunnel connection/i.test(line)) {
          edgeRegistered = true;
        }
        if (publicOrigin && edgeRegistered) {
          void this.drainIterator(iterator);
          return publicOrigin;
        }
      }
    } finally {
      exitWatch.cleanup();
      if (!publicOrigin || !edgeRegistered) {
        await closeProcess(process.child);
        await iterator.return?.(undefined);
      }
    }

    const missing = !publicOrigin
      ? 'a public URL'
      : 'a tunnel connection';
    throw new Error(
      `${label} did not register ${missing} within ${this.config.startupTimeoutMs}ms: ${output}`,
    );
  }

  private async waitForProcessReady(process: TunnelProcess, label: string): Promise<void> {
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      await closeProcess(process.child);
      throw new Error(`${label} exited before becoming ready`);
    }

    let output = '';
    let ready = false;
    const iterator = process.output[Symbol.asyncIterator]();
    const exitWatch = watchProcessExit(process.child);
    const deadline = Date.now() + this.config.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let timeout: NodeJS.Timeout | undefined;
        const next = await Promise.race([
          iterator.next().then((result) => ({ kind: 'output' as const, result })),
          exitWatch.promise.then((exit) => ({ kind: 'exit' as const, exit })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
          }),
        ]);
        if (timeout) clearTimeout(timeout);

        if (next.kind === 'exit') {
          const detail = next.exit.error ? `: ${next.exit.error.message}` : '';
          throw new Error(`${label} exited before becoming ready${detail}`);
        }
        if (next.kind === 'timeout') {
          break;
        }
        if (next.result.done) {
          const exit = await exitWatch.promise;
          const detail = exit.error ? `: ${exit.error.message}` : '';
          throw new Error(`${label} exited before becoming ready${detail}`);
        }

        output = `${output}\n${next.result.value}`.slice(-16_384);
        if (this.isReadyLine(label, next.result.value)) {
          ready = true;
          void this.drainIterator(iterator);
          return;
        }
      }
    } finally {
      exitWatch.cleanup();
      if (!ready) {
        await closeProcess(process.child);
        await iterator.return?.(undefined);
      }
    }

    throw new Error(`${label} did not become ready within ${this.config.startupTimeoutMs}ms: ${output}`);
  }

  private isReadyLine(label: string, line: string): boolean {
    const normalized = line.toLowerCase();
    if (label === 'ngrok') {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const message = [
          parsed.msg,
          parsed.event,
          parsed.status,
        ].filter((value): value is string => typeof value === 'string').join(' ');
        if (/started tunnel|online|ready|connected/i.test(message)) return true;
      } catch {
        // ngrok can emit non-JSON startup lines before its structured log.
      }
      return /started tunnel|online|ready|connected/i.test(normalized);
    }
    return /registered tunnel connection|ready|connected/i.test(normalized);
  }

  private async consumeUntil(
    process: TunnelProcess,
    label: string,
    parser: (line: string) => string | undefined,
  ): Promise<string> {
    let output = '';
    const deadline = Date.now() + this.config.startupTimeoutMs;
    const iterator = process.output[Symbol.asyncIterator]();
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timeout: NodeJS.Timeout | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<string>>((resolve) => {
          timeout = setTimeout(
            () => resolve({ done: true, value: undefined as never }),
            remaining,
          );
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (next.done) {
        break;
      }
      output = `${output}\n${next.value}`.slice(-16_384);
      const origin = parser(next.value);
      if (origin) {
        void this.drainIterator(iterator);
        return origin;
      }
      if (process.child.exitCode !== null) {
        break;
      }
    }
    await closeProcess(process.child);
    await iterator.return?.(undefined);
    throw new Error(`${label} did not provide a public URL within ${this.config.startupTimeoutMs}ms: ${output}`);
  }

  private async drainIterator(iterator: AsyncIterator<string>): Promise<void> {
    try {
      while (!(await iterator.next()).done) {
        // Tunnel processes can log for their entire lifetime; keep both pipes flowing.
      }
    } catch {
      // Process readiness and exit checks report actionable startup failures.
    }
  }

  private async commandAvailable(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
    });
  }
}
