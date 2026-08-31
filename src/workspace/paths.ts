import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new WorkspacePathError(`No existing parent found for "${candidate}"`);
      }
      current = parent;
    }
  }
}

export class WorkspacePaths {
  readonly root: string;
  private realRoot?: string;

  constructor(workspaceRoot: string) {
    this.root = path.resolve(workspaceRoot);
  }

  async initialize(): Promise<void> {
    this.realRoot = await realpath(this.root);
  }

  toRelative(absolutePath: string): string {
    return path.relative(this.root, absolutePath).split(path.sep).join('/');
  }

  async resolve(inputPath = '.', options: { mustExist?: boolean } = {}): Promise<string> {
    if (path.isAbsolute(inputPath)) {
      throw new WorkspacePathError(`Absolute paths are not allowed: "${inputPath}"`);
    }

    const candidate = path.resolve(this.root, inputPath);
    if (!isInside(this.root, candidate)) {
      throw new WorkspacePathError(`Path escapes the workspace: "${inputPath}"`);
    }

    const realRoot = this.realRoot ?? await realpath(this.root);
    this.realRoot = realRoot;

    try {
      const resolved = await realpath(candidate);
      if (!isInside(realRoot, resolved)) {
        throw new WorkspacePathError(`Path resolves outside the workspace: "${inputPath}"`);
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      if (options.mustExist) {
        throw new WorkspacePathError(`Path does not exist: "${inputPath}"`);
      }

      const existingParent = await nearestExistingParent(candidate);
      const resolvedParent = await realpath(existingParent);
      if (!isInside(realRoot, resolvedParent)) {
        throw new WorkspacePathError(`Parent resolves outside the workspace: "${inputPath}"`);
      }
      return candidate;
    }
  }
}
