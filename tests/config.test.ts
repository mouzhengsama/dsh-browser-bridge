import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadExistingConfig,
  resolveDefaultConfigPath,
  saveConfig,
} from '../src/config.js';
import { BUILT_IN_ORIGINS } from '../src/links.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('Bridge configuration persistence', () => {
  it('uses local-only mode as the standalone default', () => {
    expect(defaultConfig(process.cwd()).tunnel.provider).toBe('none');
  });

  it('preflights the exact built-in web agent origins', () => {
    expect(defaultConfig(process.cwd()).allowedOrigins).toEqual([...BUILT_IN_ORIGINS]);
  });

  it('uses an ephemeral local connector port by default', () => {
    expect(defaultConfig(process.cwd()).localConnectorPort).toBe(0);
  });

  it('keeps the workspace config absent until saved and restores non-secret tunnel settings', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-bridge-'));
    directories.push(workspace);
    const configPath = resolveDefaultConfigPath(workspace);

    await expect(loadExistingConfig(configPath)).resolves.toBeUndefined();

    const config = defaultConfig(workspace);
    config.tunnel.provider = 'cloudflare-named';
    config.tunnel.cloudflareNamedDomain = 'mcp.example.com';
    await saveConfig(configPath, config);

    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      workspaceRoot: workspace,
      tunnel: {
        provider: 'cloudflare-named',
        cloudflareNamedDomain: 'mcp.example.com',
      },
    });
  });

  it('tolerates empty tunnel domains left behind by older save cycles', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-bridge-'));
    directories.push(workspace);
    const configPath = resolveDefaultConfigPath(workspace);
    const config = defaultConfig(workspace);
    config.tunnel.cloudflareNamedDomain = '';
    config.tunnel.ngrokDomain = '';
    await saveConfig(configPath, config);

    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: {
        cloudflareNamedDomain: undefined,
        ngrokDomain: undefined,
      },
    });
  });
});
