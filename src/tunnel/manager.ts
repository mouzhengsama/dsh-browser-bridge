import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { TunnelConfig, TunnelProviderId } from '../types.js';
import type { SecretStore } from '../types.js';

export interface TunnelHandle {
  provider: TunnelProviderId;
  publicOrigin: string;
  close(): Promise<void>;
}

export interface TunnelProcess {
  child: ChildProcessWithoutNullStreams;
  output: AsyncIterable<string>;
}

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

function extractHttpsUrl(line: string): string | undefined {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0]?.replace(/[),.]+$/, '');
}

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export class TunnelManager {
  private readonly processFactory: TunnelProcessFactory;
  private active: TunnelHandle | undefined;

  constructor(
    private readonly config: TunnelConfig,
    private readonly secrets: SecretStore,
    processFactory: TunnelProcessFactory = spawnTunnelProcess,
  ) {
    this.processFactory = processFactory;
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
      default:
        throw new Error(`Unsupported tunnel provider: ${this.config.provider}`);
    }
  }

  private async startCloudflareQuick(localOrigin: string): Promise<TunnelHandle> {
    const process = this.processFactory(
      this.config.cloudflaredPath,
      ['tunnel', '--no-autoupdate', '--url', localOrigin],
    );
    const publicOrigin = await this.waitForOrigin(process, 'Cloudflare Quick Tunnel');
    return {
      provider: 'cloudflare',
      publicOrigin,
      close: () => closeProcess(process.child),
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
    const process = this.processFactory(
      this.config.cloudflaredPath,
      ['tunnel', '--no-autoupdate', 'run'],
      { TUNNEL_TOKEN: token },
    );
    await this.waitForProcessReady(process, 'Cloudflare Named Tunnel');
    return {
      provider: 'cloudflare-named',
      publicOrigin: `https://${normalizeDomain(domain)}`,
      close: () => closeProcess(process.child),
    };
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
    return {
      provider: 'ngrok',
      publicOrigin: `https://${normalizeDomain(domain)}`,
      close: () => closeProcess(process.child),
    };
  }

  private async waitForOrigin(process: TunnelProcess, label: string): Promise<string> {
    return this.consumeUntil(process, label, (line) => extractHttpsUrl(line));
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
