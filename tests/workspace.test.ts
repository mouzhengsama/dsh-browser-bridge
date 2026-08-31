import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { LocalWorkspaceAdapter } from '../src/workspace/adapter.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function fixture(): Promise<{ root: string; adapter: LocalWorkspaceAdapter }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src', 'note.txt'), 'one\ntwo\n', 'utf8');
  await writeFile(path.join(root, '.git', 'ignored.txt'), 'secret', 'utf8');
  const config = defaultConfig(root);
  config.capabilities.write = true;
  config.capabilities.command = true;
  const adapter = await LocalWorkspaceAdapter.create(config);
  return { root, adapter };
}

describe('LocalWorkspaceAdapter', () => {
  it('lists, searches, reads, and rejects workspace escapes', async () => {
    const { adapter } = await fixture();
    const files = await adapter.listFiles();
    expect(files.map((file) => file.path)).toContain('src/note.txt');
    expect(files.map((file) => file.path)).not.toContain('.git/ignored.txt');

    const matches = await adapter.searchText('TWO', { caseSensitive: false });
    expect(matches).toEqual([{
      path: 'src/note.txt',
      line: 2,
      column: 1,
      text: 'two',
    }]);

    const file = await adapter.readFile('src/note.txt');
    expect(file.content).toBe('one\ntwo\n');
    await expect(adapter.readFile('../outside.txt')).rejects.toThrow(/escapes/i);
    await adapter.dispose();
  });

  it('applies multi-file unified patches with versions and rollback protection', async () => {
    const { root, adapter } = await fixture();
    const before = await adapter.readFile('src/note.txt');
    const patch = [
      '--- a/src/note.txt',
      '+++ b/src/note.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+changed',
      '--- /dev/null',
      '+++ b/src/new.txt',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');

    const result = await adapter.applyPatch(patch, {
      'src/note.txt': before.version,
    });
    expect(result.changed).toHaveLength(2);
    expect(await readFile(path.join(root, 'src', 'note.txt'), 'utf8')).toBe('one\nchanged\n');
    expect(await readFile(path.join(root, 'src', 'new.txt'), 'utf8')).toBe('created\n');

    await expect(adapter.applyPatch(patch)).rejects.toThrow(/existing file|hunks/i);
    await adapter.dispose();
  });

  it('runs commands and returns output by byte offset', async () => {
    const { adapter } = await fixture();
    const command = `"${process.execPath}" -e "process.stdout.write('alpha'); setTimeout(() => process.stdout.write('beta'), 50)"`;
    const first = await adapter.runCommand({ command, waitMs: 500 });
    expect(first.output).toContain('alphabeta');
    expect(first.status).toBe('exited');
    const second = await adapter.getCommandOutput(first.commandId, first.nextOffset);
    expect(second.output).toBe('');
    await adapter.dispose();
  });
});
