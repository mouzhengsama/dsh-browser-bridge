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

    const loaded = await loadExistingConfig(configPath);
    expect(loaded).toBeDefined();
    if (!loaded) return;
    expect(loaded.tunnel.cloudflareNamedDomain).toBeUndefined();
    expect(loaded.tunnel.ngrokDomain).toBeUndefined();
    expect(loaded.tunnel.localtunnelHost).toBeUndefined();
    expect(loaded.tunnel.localtunnelSubdomain).toBeUndefined();
  });

  it('accepts a valid Cloudflare Edge bind address and rejects invalid values', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-bridge-'));
    directories.push(workspace);
    const configPath = resolveDefaultConfigPath(workspace);
    const config = defaultConfig(workspace);
    config.tunnel.cloudflareEdgeBindAddress = '192.168.10.161';
    await saveConfig(configPath, config);

    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: { cloudflareEdgeBindAddress: '192.168.10.161' },
    });

    config.tunnel.cloudflareEdgeBindAddress = 'not-an-ip';
    await saveConfig(configPath, config);
    await expect(loadExistingConfig(configPath)).rejects.toThrow(
      /Cloudflare Edge bind address must be an IPv4 address/,
    );

    config.tunnel.cloudflareEdgeBindAddress = '';
    await saveConfig(configPath, config);
    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: { cloudflareEdgeBindAddress: undefined },
    });
  });

  it('accepts a valid Cloudflare Edge authority and rejects invalid values', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-bridge-'));
    directories.push(workspace);
    const configPath = resolveDefaultConfigPath(workspace);
    const config = defaultConfig(workspace);
    config.tunnel.cloudflaredHttpProxy = 'http://127.0.0.1:7897';
    config.tunnel.cloudflareEdgeAuthority = 'region1.v2.argotunnel.com:7844';
    await saveConfig(configPath, config);

    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: { cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844' },
    });

    config.tunnel.cloudflareEdgeAuthority = 'https://region1.v2.argotunnel.com:7844/';
    await saveConfig(configPath, config);
    await expect(loadExistingConfig(configPath)).rejects.toThrow(
      /Cloudflare Edge authority must be host:port/,
    );

    config.tunnel.cloudflaredHttpProxy = '';
    config.tunnel.cloudflareEdgeAuthority = '';
    await saveConfig(configPath, config);
    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: { cloudflareEdgeAuthority: undefined },
    });
  });

  it('requires the Cloudflare HTTP proxy and Edge authority to be configured together', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-browser-bridge-'));
    directories.push(workspace);
    const configPath = resolveDefaultConfigPath(workspace);
    const config = defaultConfig(workspace);
    config.tunnel.cloudflaredHttpProxy = 'http://127.0.0.1:7897';
    await saveConfig(configPath, config);

    await expect(loadExistingConfig(configPath)).rejects.toThrow(
      /Cloudflare HTTP proxy and Cloudflare Edge authority must be configured together/,
    );

    config.tunnel.cloudflareEdgeAuthority = 'region1.v2.argotunnel.com:7844';
    await saveConfig(configPath, config);
    await expect(loadExistingConfig(configPath)).resolves.toMatchObject({
      tunnel: {
        cloudflaredHttpProxy: 'http://127.0.0.1:7897',
        cloudflareEdgeAuthority: 'region1.v2.argotunnel.com:7844',
      },
    });
  });
});
