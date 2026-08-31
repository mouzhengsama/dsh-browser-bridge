import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { BridgeLimits, TextSearchMatch, VersionedFile, WorkspaceEntry } from '../types.js';
import { WorkspacePaths } from './paths.js';

const DEFAULT_IGNORES = ['.git/**', '.dsh-bridge/**', 'node_modules/**'];

export function fileVersion(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function clampLimit(requested: number | undefined, configured: number): number {
  return Math.max(1, Math.min(requested ?? configured, configured));
}

export class WorkspaceFiles {
  readonly paths: WorkspacePaths;

  constructor(
    workspaceRoot: string,
    private readonly limits: BridgeLimits,
  ) {
    this.paths = new WorkspacePaths(workspaceRoot);
  }

  async initialize(): Promise<void> {
    await this.paths.initialize();
  }

  async listFiles(patterns = ['**/*'], requestedLimit?: number): Promise<WorkspaceEntry[]> {
    const limit = clampLimit(requestedLimit, this.limits.maxSearchResults);
    const entries = await fg(patterns, {
      cwd: this.paths.root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: DEFAULT_IGNORES,
      unique: true,
    });

    const result: WorkspaceEntry[] = [];
    for (const entry of entries.sort()) {
      if (result.length >= limit) {
        break;
      }
      const safePath = await this.paths.resolve(this.paths.toRelative(entry), { mustExist: true });
      const stats = await lstat(safePath);
      if (!stats.isSymbolicLink() && stats.isFile()) {
        result.push({ path: this.paths.toRelative(safePath), type: 'file', size: stats.size });
      }
    }
    return result;
  }

  async listDirectory(directory = '.', depth = 2, requestedLimit?: number): Promise<WorkspaceEntry[]> {
    const root = await this.paths.resolve(directory, { mustExist: true });
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Not a directory: "${directory}"`);
    }

    const limit = clampLimit(requestedLimit, this.limits.maxSearchResults);
    const maxDepth = Math.max(0, Math.min(depth, 10));
    const result: WorkspaceEntry[] = [];

    const visit = async (current: string, currentDepth: number): Promise<void> => {
      if (result.length >= limit || currentDepth > maxDepth) {
        return;
      }
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (result.length >= limit) {
          return;
        }
        if (entry.name === '.git' || entry.name === '.dsh-bridge' || entry.name === 'node_modules') {
          continue;
        }
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          result.push({ path: this.paths.toRelative(absolute), type: 'directory' });
          await visit(absolute, currentDepth + 1);
        } else if (entry.isFile()) {
          const stats = await lstat(absolute);
          result.push({ path: this.paths.toRelative(absolute), type: 'file', size: stats.size });
        }
      }
    };

    await visit(root, 0);
    return result;
  }

  async readFile(filePath: string, startLine = 1, endLine?: number): Promise<VersionedFile> {
    const absolute = await this.paths.resolve(filePath, { mustExist: true });
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      throw new Error(`Not a file: "${filePath}"`);
    }
    if (stats.size > this.limits.maxReadBytes) {
      throw new Error(
        `File is ${stats.size} bytes; maximum readable size is ${this.limits.maxReadBytes} bytes`,
      );
    }

    const buffer = await readFile(absolute);
    if (buffer.includes(0)) {
      throw new Error(`Binary files cannot be read as text: "${filePath}"`);
    }
    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/);
    const first = Math.max(1, startLine);
    const requestedEnd = Math.max(first, endLine ?? lines.length);
    const last = Math.min(requestedEnd, lines.length);

    return {
      path: this.paths.toRelative(absolute),
      version: fileVersion(buffer),
      content: lines.slice(first - 1, last).join('\n'),
      startLine: first,
      endLine: last,
      totalLines: lines.length,
      truncated: first > 1 || last < lines.length,
    };
  }

  async searchText(
    query: string,
    options: {
      isRegex?: boolean | undefined;
      caseSensitive?: boolean | undefined;
      include?: string[] | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<TextSearchMatch[]> {
    if (!query) {
      throw new Error('Search query must not be empty');
    }
    const limit = clampLimit(options.limit, this.limits.maxSearchResults);
    const flags = options.caseSensitive ? 'g' : 'gi';
    const pattern = options.isRegex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const files = await this.listFiles(options.include ?? ['**/*'], this.limits.maxSearchResults);
    const matches: TextSearchMatch[] = [];

    for (const file of files) {
      if (matches.length >= limit || file.size === undefined || file.size > this.limits.maxReadBytes) {
        continue;
      }
      const absolute = await this.paths.resolve(file.path, { mustExist: true });
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) {
        continue;
      }
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index] ?? '';
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null && matches.length < limit) {
          matches.push({
            path: file.path,
            line: index + 1,
            column: match.index + 1,
            text: line,
          });
          if (match[0] === '') {
            pattern.lastIndex += 1;
          }
        }
      }
    }
    return matches;
  }
}
