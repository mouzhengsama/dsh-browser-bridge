import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatch as applyUnifiedPatch, parsePatch } from 'diff';
import type { PatchResult } from '../types.js';
import { fileVersion } from './files.js';
import type { WorkspacePaths } from './paths.js';

interface PreparedChange {
  path: string;
  absolutePath: string;
  operation: 'create' | 'update' | 'delete';
  original: Buffer | undefined;
  nextContent: string | undefined;
}

function normalizePatchPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === '/dev/null') {
    return undefined;
  }
  const normalized = value.replace(/\\/g, '/').replace(/^(?:a|b)\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')) {
    throw new Error(`Invalid patch path: "${value}"`);
  }
  return normalized;
}

async function readExisting(absolutePath: string): Promise<Buffer | undefined> {
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Patch target is not a file: "${absolutePath}"`);
    }
    return await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function selectTarget(patch: ReturnType<typeof parsePatch>[number]): {
  targetPath: string;
  operation: PreparedChange['operation'];
} {
  const oldPath = normalizePatchPath(patch.oldFileName);
  const newPath = normalizePatchPath(patch.newFileName);
  if (!oldPath && !newPath) {
    throw new Error('A patch cannot use /dev/null for both paths');
  }
  if (oldPath && newPath && oldPath !== newPath) {
    throw new Error(`File renames are not supported in patches: "${oldPath}" -> "${newPath}"`);
  }
  if (!oldPath) {
    return { targetPath: newPath!, operation: 'create' };
  }
  if (!newPath) {
    return { targetPath: oldPath, operation: 'delete' };
  }
  return { targetPath: newPath, operation: 'update' };
}

export class WorkspacePatchApplier {
  constructor(private readonly paths: WorkspacePaths) {}

  async apply(patchText: string, expectedVersions: Record<string, string> = {}): Promise<PatchResult> {
    const patches = parsePatch(patchText);
    if (patches.length === 0) {
      throw new Error('Patch did not contain any file changes');
    }

    const prepared: PreparedChange[] = [];
    const seen = new Set<string>();

    for (const patch of patches) {
      const target = selectTarget(patch);
      if (seen.has(target.targetPath)) {
        throw new Error(`Patch changes the same file more than once: "${target.targetPath}"`);
      }
      seen.add(target.targetPath);

      const absolutePath = await this.paths.resolve(target.targetPath);
      const original = await readExisting(absolutePath);
      if (target.operation === 'create' && original) {
        throw new Error(`Cannot create an existing file: "${target.targetPath}"`);
      }
      if (target.operation !== 'create' && !original) {
        throw new Error(`Cannot patch a missing file: "${target.targetPath}"`);
      }
      if (original?.includes(0)) {
        throw new Error(`Binary files cannot be patched: "${target.targetPath}"`);
      }

      const expected = expectedVersions[target.targetPath];
      if (expected && original && fileVersion(original) !== expected) {
        throw new Error(`Version mismatch for "${target.targetPath}"`);
      }
      if (expected && !original) {
        throw new Error(`Expected version was supplied for new file "${target.targetPath}"`);
      }

      const source = original?.toString('utf8') ?? '';
      const applied = applyUnifiedPatch(source, patch);
      if (applied === false) {
        throw new Error(`Patch hunks did not apply cleanly to "${target.targetPath}"`);
      }

      let nextContent: string | undefined;
      if (target.operation !== 'delete') {
        nextContent = applied;
      }
      prepared.push({
        path: target.targetPath,
        absolutePath,
        operation: target.operation,
        original,
        nextContent,
      });
    }

    const committed: PreparedChange[] = [];
    try {
      for (const change of prepared) {
        const current = await readExisting(change.absolutePath);
        if (fileVersion(current ?? '') !== fileVersion(change.original ?? '')) {
          throw new Error(`File changed while patch was being applied: "${change.path}"`);
        }
        committed.push(change);
        if (change.operation === 'delete') {
          await rm(change.absolutePath);
        } else {
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          const temporary = `${change.absolutePath}.dsh-bridge-${randomBytes(6).toString('hex')}.tmp`;
          try {
            await writeFile(temporary, change.nextContent!, 'utf8');
            await rename(temporary, change.absolutePath);
          } finally {
            await rm(temporary, { force: true });
          }
        }
      }
    } catch (error) {
      for (const change of committed.reverse()) {
        if (change.original) {
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          await writeFile(change.absolutePath, change.original);
        } else {
          await rm(change.absolutePath, { force: true });
        }
      }
      throw error;
    }

    return {
      changed: prepared.map((change) => ({
        path: change.path,
        operation: change.operation,
        ...(change.nextContent === undefined ? {} : { version: fileVersion(change.nextContent) }),
      })),
    };
  }
}
