import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
  FsTargetKey,
  FsVersion,
  type FileSystem,
  type FsDirEntry,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
} from '@deepseek-ai/dsh-fs';
import type { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { DshWorkspaceAdapter } from '../src/workspace/dsh-adapter.js';

interface FixtureEntry {
  type: 'file' | 'directory' | 'other';
  content?: string;
  symlink?: boolean;
}

function target(relative: string): FsTarget {
  const normalized = relative.replace(/\\/g, '/') || '.';
  return {
    targetKey: FsTargetKey(normalized),
    displayPath: normalized,
  };
}

function fakeFileSystem(entries: Record<string, FixtureEntry>, root: string): FileSystem {
  const normalized = new Map(Object.entries(entries).map(([key, value]) => [
    key.replace(/\\/g, '/') || '.',
    value,
  ]));
  const resolvePath = (input: string): string => input.replace(/\\/g, '/') || '.';

  return {
    async resolve(input: string) {
      return target(resolvePath(input));
    },
    processPath(value: FsTarget) {
      return value.displayPath === '.'
        ? root
        : path.join(root, value.displayPath);
    },
    contains(parent: FsTarget, child: FsTarget) {
      return child.displayPath === parent.displayPath
        || child.displayPath.startsWith(`${parent.displayPath === '.' ? '' : `${parent.displayPath}/`}`);
    },
    async stat(value: FsTarget): Promise<FsInfo | undefined> {
      const entry = normalized.get(value.displayPath);
      return entry ? {
        type: entry.type,
        version: FsVersion(`v:${value.displayPath}`),
        ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '') } : {}),
      } : undefined;
    },
    async lstat(input: string): Promise<FsPathInfo | undefined> {
      const entryPath = resolvePath(input);
      const entry = normalized.get(entryPath);
      return entry ? {
        type: entry.symlink ? 'symlink' : entry.type,
        version: FsVersion(`v:${entryPath}`),
        ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '') } : {}),
      } : undefined;
    },
    async listDir(value: FsTarget): Promise<FsDirEntry[]> {
      const prefix = value.displayPath === '.' ? '' : `${value.displayPath}/`;
      const children = new Map<string, FixtureEntry>();
      for (const [entryPath, entry] of normalized) {
        if (!entryPath.startsWith(prefix) || entryPath === value.displayPath) continue;
        const remainder = entryPath.slice(prefix.length);
        if (!remainder || remainder.includes('/')) continue;
        children.set(remainder, entry);
      }
      return [...children].map(([name, entry]) => ({
        name,
        type: entry.type,
        target: target(`${prefix}${name}`),
        version: FsVersion(`v:${prefix}${name}`),
        ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '') } : {}),
      }));
    },
    async readText(value: FsTarget) {
      return normalized.get(value.displayPath)?.content ?? '';
    },
  } as unknown as FileSystem;
}

describe('DshWorkspaceAdapter', () => {
  it('falls back to the local command runtime when the dsh shell crashes on start', async () => {
    const root = process.cwd();
    const fs = fakeFileSystem({
      '.': { type: 'directory' },
      commands: { type: 'directory' },
    }, root);
    const diagnostics: Array<Record<string, unknown>> = [];
    const shell: ShellExecutor = {
      resolve: (request: Parameters<ShellExecutor['resolve']>[0]) => request,
      start: () => ({
        status: 'exited',
        exitCode: 3_221_225_794,
        signal: null,
        done: Promise.resolve({ outcome: { exitCode: 3_221_225_794, signal: null } }),
        readOutput: () => ({ delta: '', lossy: 0 }),
        kill: () => undefined,
      }),
    } as unknown as ShellExecutor;
    const ctx = {
      fs,
      get(service: string) {
        return service === 'shell' ? shell : undefined;
      },
    } as unknown as Context & { fs: FileSystem };
    const config = defaultConfig(root);
    config.commandRuntime = 'auto';
    const adapter = await DshWorkspaceAdapter.create(ctx, config, details => diagnostics.push(details));

    const first = await adapter.runCommand({
      command: 'echo bridge-fallback-ok',
      cwd: '.',
      waitMs: 100,
    });
    const completed = first.status === 'exited'
      ? first
      : await adapter.getCommandOutput(first.commandId, 0, 5_000);

    expect(completed.exitCode).toBe(0);
    expect(completed.output).toContain('bridge-fallback-ok');
    expect(diagnostics).toMatchObject([
      { reason: 'shell-start-crash', action: 'fallback-local' },
    ]);
    await expect(adapter.getCommandOutput(first.commandId, 0, 5_000)).resolves.toMatchObject({
      commandId: completed.commandId,
      status: 'exited',
      exitCode: 0,
    });
    await adapter.dispose();
  });

  it('lists root files without letting a large directory consume the result limit', async () => {
    const root = path.resolve('C:/workspace');
    const entries: Record<string, FixtureEntry> = {
      '.': { type: 'directory' },
      '.git': { type: 'directory' },
      '.git/config': { type: 'file', content: 'secret' },
      bulk: { type: 'directory' },
      'root.txt': { type: 'file', content: 'root' },
      link: { type: 'file', content: 'outside', symlink: true },
    };
    for (let index = 0; index < 150; index += 1) {
      entries[`bulk/${String(index).padStart(3, '0')}.txt`] = {
        type: 'file',
        content: String(index),
      };
    }
    const fs = fakeFileSystem(entries, root);
    const ctx = {
      fs,
      get: () => undefined,
    } as unknown as Context & { fs: FileSystem };
    const config = defaultConfig(root);
    config.limits.maxSearchResults = 2;
    const adapter = await DshWorkspaceAdapter.create(ctx, config);

    const files = await adapter.listFiles();
    expect(files.map((file) => file.path)).toEqual([
      'bulk/000.txt',
      'root.txt',
    ]);
    expect(files.map((file) => file.path)).not.toContain('.git/config');
    expect(files.map((file) => file.path)).not.toContain('link');
    await adapter.dispose();
  });

  it('supports root-level and recursive glob patterns', async () => {
    const root = path.resolve('C:/workspace');
    const fs = fakeFileSystem({
      '.': { type: 'directory' },
      'root.ts': { type: 'file', content: '' },
      src: { type: 'directory' },
      'src/main.ts': { type: 'file', content: '' },
      'src/readme.md': { type: 'file', content: '' },
    }, root);
    const ctx = { fs, get: () => undefined } as unknown as Context & { fs: FileSystem };
    const adapter = await DshWorkspaceAdapter.create(ctx, defaultConfig(root));

    expect((await adapter.listFiles(['**/*.ts'])).map((file) => file.path)).toEqual([
      'root.ts',
      'src/main.ts',
    ]);
    expect((await adapter.listFiles(['*.ts'])).map((file) => file.path)).toEqual([
      'root.ts',
    ]);
    await adapter.dispose();
  });
});
