import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  loadConfig,
  resolveDefaultConfigPath,
} from './config.js';
import { BridgeRuntime } from './runtime.js';
import { KeyringSecretStore } from './security/secrets.js';
import { TunnelManager } from './tunnel/manager.js';

const execFileAsync = promisify(execFile);

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function resolveConfig(args: string[]) {
  const workspace = path.resolve(valueAfter(args, '--workspace') ?? process.cwd());
  const configPath = path.resolve(valueAfter(args, '--config') ?? resolveDefaultConfigPath(workspace));
  return { configPath, config: await loadConfig(configPath, workspace) };
}

async function installCloudflared(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The automatic Winget installer is only available on Windows');
  }
  const result = await execFileAsync('winget', [
    'install',
    '--id',
    'Cloudflare.cloudflared',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

async function main(): Promise<void> {
  const [command = 'start', ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    process.stdout.write([
      'dsh-bridge start [--workspace path] [--config path]',
      'dsh-bridge status [--workspace path] [--config path]',
      'dsh-bridge check [--workspace path] [--config path]',
      'dsh-bridge reset-path [--workspace path] [--config path]',
      'dsh-bridge install-cloudflared',
      '',
    ].join('\n'));
    return;
  }
  if (command === 'install-cloudflared') {
    await installCloudflared();
    return;
  }

  const { configPath, config } = await resolveConfig(args);
  const secrets = new KeyringSecretStore(config.workspaceRoot);
  if (command === 'status') {
    print({
      configPath,
      workspaceRoot: config.workspaceRoot,
      config,
    });
    return;
  }
  if (command === 'check') {
    const manager = new TunnelManager(config.tunnel, secrets);
    print(await manager.checkInstalled());
    return;
  }
  if (command === 'reset-path') {
    await secrets.delete('mcp-path-secret');
    process.stdout.write('MCP secret path reset. Start Bridge to generate a new protected URL.\n');
    return;
  }
  if (command !== 'start') {
    throw new Error(`Unknown command "${command}"`);
  }

  const runtime = new BridgeRuntime({ config, secrets });
  runtime.subscribe((event) => {
    if (event.type === 'status' && event.status) {
      process.stderr.write(`[bridge] ${event.status.state}\n`);
    }
  });
  const status = await runtime.start();
  print(status);
  const stop = async (): Promise<void> => {
    await runtime.dispose();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  await new Promise<void>(() => undefined);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
