import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { BridgeConfig } from './types.js';
import { BUILT_IN_ORIGINS } from './links.js';

const capabilitySchema = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(false),
  command: z.boolean().default(false),
  lsp: z.boolean().default(true),
  progress: z.boolean().default(true),
});

const limitsSchema = z.object({
  requestBodyLimit: z.string().default('1mb'),
  requestsPerMinute: z.number().int().positive().default(120),
  maxConcurrentRequests: z.number().int().positive().default(4),
  maxReadBytes: z.number().int().positive().default(512 * 1024),
  maxSearchResults: z.number().int().positive().default(200),
  maxCommandOutputBytes: z.number().int().positive().default(2 * 1024 * 1024),
  defaultCommandWaitMs: z.number().int().nonnegative().default(30_000),
  maxCommandWaitMs: z.number().int().positive().default(120_000),
});

const languageServerSchema = z.object({
  id: z.string().min(1),
  extensions: z.array(z.string().min(1)).min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  languageId: z.string().min(1).optional(),
  initializationOptions: z.unknown().optional(),
});

const tunnelSchema = z.object({
  provider: z.enum([
    'none',
    'cloudflare',
    'cloudflare-named',
    'ngrok',
    'localtunnel',
  ]).default('none'),
  cloudflareNamedDomain: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  cloudflareNamedTokenKey: z.string().min(1).default('cloudflare-tunnel-token'),
  cloudflareEdgeBindAddress: z
    .string()
    .transform(value => value.trim() || undefined)
    .refine(value => value === undefined || net.isIPv4(value), {
      message: 'Cloudflare Edge bind address must be an IPv4 address',
    })
    .optional(),
  cloudflareEdgeAuthority: z
    .string()
    .transform(value => value.trim() || undefined)
    .refine(value => value === undefined || /^[^\s:/]+:\d+$/.test(value), {
      message: 'Cloudflare Edge authority must be host:port',
    })
    .optional(),
  cloudflaredHttpProxy: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  ngrokDomain: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  ngrokUseHttpProxy: z.boolean().default(false),
  localtunnelHost: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  localtunnelHttpProxy: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  localtunnelSubdomain: z
    .string()
    .transform(value => value.trim() || undefined)
    .optional(),
  startupTimeoutMs: z.number().int().positive().default(20_000),
  publicHealthTimeoutMs: z.number().int().positive().default(20_000),
  cloudflaredPath: z.string().min(1).default('cloudflared'),
  ngrokPath: z.string().min(1).default('ngrok'),
}).superRefine((value, ctx) => {
  if (Boolean(value.cloudflaredHttpProxy) !== Boolean(value.cloudflareEdgeAuthority)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.cloudflaredHttpProxy ? ['cloudflareEdgeAuthority'] : ['cloudflaredHttpProxy'],
      message: 'Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together',
    });
  }
});

const configSchema = z.object({
  workspaceRoot: z.string().min(1),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1024).max(65_535).default(48_271),
  localConnectorPort: z.number().int().min(0).max(65_535).default(0),
  requireBearerToken: z.boolean().default(false),
  allowSecretPathOnly: z.boolean().default(false),
  allowedOrigins: z.array(z.string()).default([...BUILT_IN_ORIGINS]),
  capabilities: capabilitySchema.default({
    read: true,
    write: false,
    command: false,
    lsp: true,
    progress: true,
  }),
  limits: limitsSchema.default({
    requestBodyLimit: '1mb',
    requestsPerMinute: 120,
    maxConcurrentRequests: 4,
    maxReadBytes: 512 * 1024,
    maxSearchResults: 200,
    maxCommandOutputBytes: 2 * 1024 * 1024,
    defaultCommandWaitMs: 30_000,
    maxCommandWaitMs: 120_000,
  }),
  tunnel: tunnelSchema.default({
    provider: 'none',
    cloudflareNamedTokenKey: 'cloudflare-tunnel-token',
    ngrokUseHttpProxy: false,
    startupTimeoutMs: 20_000,
    publicHealthTimeoutMs: 20_000,
    cloudflaredPath: 'cloudflared',
    ngrokPath: 'ngrok',
  }),
  languageServers: z.array(languageServerSchema).default([]),
  persistentMode: z.boolean().default(false),
  commandRuntime: z.enum(['auto', 'dsh', 'local']).default('auto'),
});

export function defaultConfig(workspaceRoot = process.cwd()): BridgeConfig {
  return configSchema.parse({ workspaceRoot: path.resolve(workspaceRoot) });
}

export function resolveDefaultConfigPath(workspaceRoot = process.cwd()): string {
  return path.join(path.resolve(workspaceRoot), '.dsh-bridge', 'config.json');
}

export async function loadConfig(
  configPath = resolveDefaultConfigPath(),
  workspaceRoot = process.cwd(),
): Promise<BridgeConfig> {
  const config = await loadExistingConfig(configPath);
  return config ?? defaultConfig(workspaceRoot);
}

export async function loadExistingConfig(configPath: string): Promise<BridgeConfig | undefined> {
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
    const parsed = configSchema.parse(raw);
    return {
      ...parsed,
      workspaceRoot: path.resolve(path.dirname(configPath), parsed.workspaceRoot),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function saveConfig(configPath: string, config: BridgeConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  const serializable = {
    ...config,
    workspaceRoot: path.relative(path.dirname(configPath), config.workspaceRoot) || '.',
  };
  await writeFile(configPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
}

export function parseConfig(value: unknown): BridgeConfig {
  const config = configSchema.parse(value);
  return { ...config, workspaceRoot: path.resolve(config.workspaceRoot) };
}
