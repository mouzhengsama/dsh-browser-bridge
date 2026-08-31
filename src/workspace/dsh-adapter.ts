import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyPatch as applyUnifiedPatch, parsePatch } from 'diff';
import type { Context } from '@deepseek-ai/cordis';
import { FsVersion } from '@deepseek-ai/dsh-fs';
import type {
  FileSystem,
  FsDirEntry,
  FsTarget,
} from '@deepseek-ai/dsh-fs';
import type {
  ShellExecutor,
  ShellProcess,
} from '@deepseek-ai/dsh-shell';
import { CommandManager } from '../commands/manager.js';
import { WorkspacePaths } from './paths.js';
import type { LspService } from '@deepseek-ai/dsh-lsp';
import type {
  BridgeConfig,
  BridgeProgress,
  CommandRuntimeId,
  CommandOutput,
  LspQueryOptions,
  PatchResult,
  RunCommandOptions,
  TextSearchMatch,
  VersionedFile,
  WorkspaceAdapter,
  WorkspaceEntry,
} from '../types.js';

const IGNORED_NAMES = new Set(['.git', '.dsh-bridge', 'node_modules']);

interface DshCommandRecord {
  id: string;
  command: string;
  process: ShellProcess;
  status: CommandOutput['status'];
  exitCode?: number | null;
  signal?: string | null;
  chunks: Buffer[];
  size: number;
  baseOffset: number;
  startedAt: string;
  endedAt?: string;
}

type CommandBackend = 'dsh' | 'local';

export type DshCommandDiagnostic = (details: Record<string, unknown>) => void;

interface DshContextServices extends Context {
  fs: FileSystem;
}

function relativePath(root: string, target: FsTarget, fs: FileSystem): string {
  const processPath = fs.processPath(target);
  const relative = path.relative(root, processPath).split(path.sep).join('/');
  return relative || '.';
}

function validateRelativePath(input: string | undefined): string {
  const value = input ?? '.';
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error(`Absolute paths are not allowed: "${value}"`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Path escapes the workspace: "${value}"`);
  }
  return normalized || '.';
}

function clampLimit(requested: number | undefined, configured: number): number {
  return Math.max(1, Math.min(requested ?? configured, configured));
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAny(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(
    pattern.replace(/\\/g, '/'),
  ).test(pathname));
}

function normalizePatchPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '/dev/null') {
    return undefined;
  }
  const normalized = value.replace(/\\/g, '/').replace(/^(?:a|b)\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')) {
    throw new Error(`Invalid patch path: "${value}"`);
  }
  return validateRelativePath(normalized);
}

function patchTarget(patch: ReturnType<typeof parsePatch>[number]): {
  path: string;
  operation: 'create' | 'update' | 'delete';
} {
  const oldPath = normalizePatchPath(patch.oldFileName);
  const newPath = normalizePatchPath(patch.newFileName);
  if (!oldPath && !newPath) {
    throw new Error('A patch cannot use /dev/null for both paths');
  }
  if (oldPath && newPath && oldPath !== newPath) {
    throw new Error(`File renames are not supported: "${oldPath}" -> "${newPath}"`);
  }
  if (!oldPath) return { path: newPath!, operation: 'create' };
  if (!newPath) return { path: oldPath, operation: 'delete' };
  return { path: newPath, operation: 'update' };
}

function outputStatus(record: DshCommandRecord): void {
  if (record.process.status === 'running') {
    record.status = 'running';
    return;
  }
  record.status = record.process.status === 'killed' ? 'failed' : 'exited';
  record.exitCode = record.process.exitCode;
  record.signal = record.process.signal;
  record.endedAt ??= new Date().toISOString();
}

export class DshWorkspaceAdapter implements WorkspaceAdapter {
  readonly workspaceRoot: string;
  private readonly commands = new Map<string, DshCommandRecord>();
  private readonly commandOwners = new Map<string, CommandBackend>();
  private readonly commandRuntime: CommandRuntimeId;
  private readonly localCommands?: CommandManager;
  private readonly localCommandPaths?: WorkspacePaths;
  private progress?: BridgeProgress;

  private constructor(
    private readonly fs: FileSystem,
    private readonly shell: ShellExecutor | undefined,
    private readonly lsp: LspService | undefined,
    private readonly config: BridgeConfig,
    private readonly rootTarget: FsTarget,
    workspaceRoot: string,
    commandRuntime: CommandRuntimeId,
    private readonly onDiagnostic?: DshCommandDiagnostic,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.commandRuntime = commandRuntime;
    if (commandRuntime !== 'dsh') {
      this.localCommandPaths = new WorkspacePaths(workspaceRoot);
      this.localCommands = new CommandManager(
        this.localCommandPaths,
        config.limits,
      );
    }
  }

  static async create(
    ctx: DshContextServices,
    config: BridgeConfig,
    onDiagnostic?: DshCommandDiagnostic,
  ): Promise<DshWorkspaceAdapter> {
    const rootTarget = await ctx.fs.resolve('.');
    const rootInfo = await ctx.fs.stat(rootTarget);
    if (!rootInfo || rootInfo.type !== 'directory') {
      throw new Error('dsh fs workspace root is not a directory');
    }
    const adapter = new DshWorkspaceAdapter(
      ctx.fs,
      ctx.get('shell') as ShellExecutor | undefined,
      ctx.get('lsp') as LspService | undefined,
      config,
      rootTarget,
      ctx.fs.processPath(rootTarget),
      config.commandRuntime,
      onDiagnostic,
    );
    return adapter;
  }

  async listFiles(patterns = ['**/*'], requestedLimit?: number): Promise<WorkspaceEntry[]> {
    const limit = clampLimit(requestedLimit, this.config.limits.maxSearchResults);
    const result: WorkspaceEntry[] = [];
    await this.walk('.', 100, limit, async (relative, entry) => {
      if (entry.type === 'file' && matchesAny(relative, patterns)) {
        result.push({
          path: relative,
          type: 'file',
          ...(entry.size === undefined ? {} : { size: entry.size }),
        });
        return true;
      }
      return false;
    });
    return result.sort((left, right) => left.path.localeCompare(right.path));
  }

  async listDirectory(directory = '.', depth = 2, requestedLimit?: number): Promise<WorkspaceEntry[]> {
    const root = validateRelativePath(directory);
    await this.assertNotSymlink(root);
    const target = await this.resolveInside(root);
    const info = await this.fs.stat(target);
    if (!info || info.type !== 'directory') {
      throw new Error(`Not a directory: "${directory}"`);
    }
    const limit = clampLimit(requestedLimit, this.config.limits.maxSearchResults);
    const result: WorkspaceEntry[] = [];
    await this.walk(root, Math.max(0, Math.min(depth, 10)), limit, async (relative, entry) => {
      if (entry.type !== 'directory' && entry.type !== 'file') {
        return false;
      }
      result.push({
        path: relative,
        type: entry.type === 'directory' ? 'directory' : 'file',
        ...(entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {}),
      });
      return true;
    });
    return result;
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
    const limit = clampLimit(options.limit, this.config.limits.maxSearchResults);
    const flags = options.caseSensitive ? 'g' : 'gi';
    const pattern = options.isRegex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const files = await this.listFiles(options.include ?? ['**/*'], this.config.limits.maxSearchResults);
    const matches: TextSearchMatch[] = [];
    for (const file of files) {
      if (matches.length >= limit || file.size === undefined || file.size > this.config.limits.maxReadBytes) {
        continue;
      }
      const target = await this.resolveInside(file.path);
      const content = await this.fs.readText(target);
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex += 1) {
        const line = lines[lineIndex] ?? '';
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null && matches.length < limit) {
          matches.push({
            path: file.path,
            line: lineIndex + 1,
            column: match.index + 1,
            text: line,
          });
          if (match[0] === '') pattern.lastIndex += 1;
        }
      }
    }
    return matches;
  }

  async readFile(filePath: string, startLine = 1, endLine?: number): Promise<VersionedFile> {
    const safePath = validateRelativePath(filePath);
    await this.assertNotSymlink(safePath);
    const target = await this.resolveInside(safePath);
    const info = await this.fs.stat(target);
    if (!info || info.type !== 'file') {
      throw new Error(`Not a file: "${filePath}"`);
    }
    if (info.size !== undefined && info.size > this.config.limits.maxReadBytes) {
      throw new Error(
        `File is ${info.size} bytes; maximum readable size is ${this.config.limits.maxReadBytes} bytes`,
      );
    }
    const content = await this.fs.readText(target);
    const lines = content.split(/\r?\n/);
    const first = Math.max(1, startLine);
    const requestedEnd = Math.max(first, endLine ?? lines.length);
    const last = Math.min(requestedEnd, lines.length);
    return {
      path: relativePath(this.workspaceRoot, target, this.fs),
      version: String(info.version),
      content: lines.slice(first - 1, last).join('\n'),
      startLine: first,
      endLine: last,
      totalLines: lines.length,
      truncated: first > 1 || last < lines.length,
    };
  }

  async applyPatch(patchText: string, expectedVersions: Record<string, string> = {}): Promise<PatchResult> {
    const patches = parsePatch(patchText);
    if (patches.length === 0) {
      throw new Error('Patch did not contain any file changes');
    }
    const seen = new Set<string>();
    const prepared: Array<{
      path: string;
      operation: 'create' | 'update';
      target: FsTarget;
      expected?: { version: string };
      content: string;
    }> = [];

    for (const patch of patches) {
      const targetInfo = patchTarget(patch);
      if (seen.has(targetInfo.path)) {
        throw new Error(`Patch changes the same file more than once: "${targetInfo.path}"`);
      }
      seen.add(targetInfo.path);
      if (targetInfo.operation === 'delete') {
        throw new Error(
          `dsh fs does not expose file deletion; cannot delete "${targetInfo.path}" through the Bridge`,
        );
      }

      await this.assertNotSymlink(targetInfo.path, true);
      const target = await this.resolveInside(targetInfo.path);
      const info = await this.fs.stat(target);
      if (targetInfo.operation === 'create' && info) {
        throw new Error(`Cannot create an existing file: "${targetInfo.path}"`);
      }
      if (targetInfo.operation === 'update' && (!info || info.type !== 'file')) {
        throw new Error(`Cannot patch a missing file: "${targetInfo.path}"`);
      }
      const expected = expectedVersions[targetInfo.path];
      if (expected && (!info || String(info.version) !== expected)) {
        throw new Error(`Version mismatch for "${targetInfo.path}"`);
      }
      const source = info ? await this.fs.readText(target) : '';
      const applied = applyUnifiedPatch(source, patch);
      if (applied === false) {
        throw new Error(`Patch hunks did not apply cleanly to "${targetInfo.path}"`);
      }
      prepared.push({
        path: targetInfo.path,
        operation: targetInfo.operation,
        target,
        ...(info ? { expected: { version: String(info.version) } } : {}),
        content: applied,
      });
    }

    const changed: PatchResult['changed'] = [];
    for (const change of prepared) {
      const outcome = await this.fs.writeText(
        change.target,
        change.content,
        change.expected
          ? { kind: 'replaceIfVersion', version: FsVersion(change.expected.version) }
          : { kind: 'createIfAbsent' },
      );
      changed.push({
        path: change.path,
        operation: change.operation,
        version: String(outcome.version),
      });
    }
    return { changed };
  }

  async runCommand(options: RunCommandOptions): Promise<CommandOutput> {
    if (!options.command.trim()) {
      throw new Error('Command must not be empty');
    }
    const cwd = validateRelativePath(options.cwd);
    await this.assertNotSymlink(cwd);
    const cwdTarget = await this.resolveInside(cwd);
    const cwdInfo = await this.fs.stat(cwdTarget);
    if (!cwdInfo || cwdInfo.type !== 'directory') {
      throw new Error(`Command cwd is not a directory: "${cwd}"`);
    }
    if (this.commandRuntime === 'local') {
      return this.runLocal(options, cwd);
    }
    if (!this.shell) {
      if (this.commandRuntime === 'auto' && this.localCommands) {
        return this.runLocal(options, cwd);
      }
      throw new Error('dsh shell service is not available');
    }
    const spec = this.shell.resolve({
      command: options.command,
      workdir: this.fs.processPath(cwdTarget),
      env: options.env,
      timeoutMs: this.config.limits.maxCommandWaitMs,
    });
    const process = this.shell.start(spec);
    const id = randomUUID();
    const record: DshCommandRecord = {
      id,
      command: options.command,
      process,
      status: 'running',
      chunks: [],
      size: 0,
      baseOffset: 0,
      startedAt: new Date().toISOString(),
    };
    this.commands.set(id, record);
    void process.done.then(() => {
      this.drain(record);
      outputStatus(record);
    });
    try {
      await this.waitFor(record, Math.max(0, Math.min(
        options.waitMs ?? this.config.limits.defaultCommandWaitMs,
        this.config.limits.maxCommandWaitMs,
      )));
      if (this.isWindowsInitializationCrash(record)) {
        this.commands.delete(id);
        this.onDiagnostic?.({
          reason: 'shell-start-crash',
          exitCode: record.exitCode,
          signal: record.signal,
          action: this.localCommands ? 'fallback-local' : 'failed',
        });
        if (this.localCommands) {
          return this.runLocal(options, cwd, id);
        }
      }
      return this.snapshot(record, 0);
    } catch (error) {
      this.commands.delete(id);
      if (this.localCommands) {
        this.onDiagnostic?.({
          reason: 'shell-start-error',
          action: 'fallback-local',
          message: error instanceof Error ? error.message : String(error),
        });
        return this.runLocal(options, cwd, id);
      }
      throw error;
    }
  }

  async getCommandOutput(commandId: string, offset = 0, waitMs = 0): Promise<CommandOutput> {
    if (this.commandOwners.get(commandId) === 'local') {
      return this.localCommands!.getOutput(commandId, offset, waitMs);
    }
    const record = this.requireCommand(commandId);
    await this.waitFor(record, Math.max(0, Math.min(waitMs, this.config.limits.maxCommandWaitMs)));
    return this.snapshot(record, offset);
  }

  async sendCommandInput(_commandId: string, _input: string, _close = false): Promise<CommandOutput> {
    if (this.commandOwners.get(_commandId) === 'local') {
      return this.localCommands!.sendInput(_commandId, _input, _close);
    }
    throw new Error('dsh shell process handles do not expose interactive stdin');
  }

  async terminateCommand(commandId: string): Promise<CommandOutput> {
    if (this.commandOwners.get(commandId) === 'local') {
      return this.localCommands!.terminate(commandId);
    }
    const record = this.requireCommand(commandId);
    if (record.process.status === 'running') {
      record.process.kill();
      await record.process.done;
    }
    return this.snapshot(record, record.baseOffset);
  }

  async getDiagnostics(filePath?: string): Promise<unknown> {
    return {
      available: false,
      path: filePath,
      diagnostics: [],
      message: this.lsp
        ? 'dsh lsp exposes semantic navigation through lsp_query; diagnostics are not part of its public service contract'
        : 'dsh lsp service is not available',
    };
  }

  async queryLsp(options: LspQueryOptions): Promise<unknown> {
    if (!this.lsp) {
      throw new Error('dsh lsp service is not available');
    }
    const safePath = validateRelativePath(options.path);
    await this.assertNotSymlink(safePath);
    await this.resolveInside(safePath);
    return this.lsp.query({
      operation: options.operation,
      filePath: safePath,
      position: {
        line: Math.max(0, options.line - 1),
        character: Math.max(0, options.character - 1),
      },
      workspaceRoot: this.workspaceRoot,
    });
  }

  reportProgress(progress: Omit<BridgeProgress, 'updatedAt'>): BridgeProgress {
    this.progress = { ...progress, updatedAt: new Date().toISOString() };
    return this.progress;
  }

  getProgress(): BridgeProgress | undefined {
    return this.progress;
  }

  async dispose(): Promise<void> {
    const running = [...this.commands.values()].filter((record) => record.process.status === 'running');
    for (const record of running) record.process.kill();
    await Promise.all(running.map((record) => record.process.done));
    this.commands.clear();
    await this.localCommands?.dispose();
  }

  private async runLocal(
    options: RunCommandOptions,
    cwd: string,
    preferredId?: string,
  ): Promise<CommandOutput> {
    if (!this.localCommands) {
      throw new Error('local command runtime is not available');
    }
    void cwd;
    const output = await this.localCommands.run(options);
    if (preferredId) {
      this.localCommands.renameCommand(output.commandId, preferredId);
      this.commandOwners.set(preferredId, 'local');
      return {
        ...output,
        commandId: preferredId,
      };
    }
    this.commandOwners.set(output.commandId, 'local');
    return output;
  }

  private isWindowsInitializationCrash(record: DshCommandRecord): boolean {
    if (record.process.status === 'running' || record.signal) return false;
    if (record.exitCode !== 3_221_225_794 && record.exitCode !== -1_073_741_502) return false;
    return record.size === 0 && record.chunks.every(chunk => chunk.length === 0);
  }

  private async walk(
    root: string,
    maxDepth: number,
    limit: number,
    visit: (relative: string, entry: FsDirEntry) => Promise<boolean>,
  ): Promise<void> {
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let matched = 0;
    for (let index = 0; index < queue.length && matched < limit; index += 1) {
      const current = queue[index]!;
      if (current.depth > maxDepth) {
        continue;
      }
      const target = await this.resolveInside(current.directory);
      const entries = await this.fs.listDir(target);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (IGNORED_NAMES.has(entry.name) || entry.type === 'other') {
          continue;
        }
        const relative = current.directory === '.'
          ? entry.name
          : `${current.directory}/${entry.name}`;
        const pathInfo = await this.fs.lstat(relative);
        if (!pathInfo || pathInfo.type === 'symlink' || pathInfo.type === 'other') {
          continue;
        }
        if (await visit(relative, entry)) {
          matched += 1;
          if (matched >= limit) {
            return;
          }
        }
        if (entry.type === 'directory' && current.depth < maxDepth) {
          queue.push({ directory: relative, depth: current.depth + 1 });
        }
      }
    }
  }

  private async assertNotSymlink(relative: string, allowMissing = false): Promise<void> {
    const info = await this.fs.lstat(relative);
    if (!info && allowMissing) {
      return;
    }
    if (!info) {
      throw new Error(`Path does not exist: "${relative}"`);
    }
    if (info.type === 'symlink') {
      throw new Error(`Symbolic links are not allowed: "${relative}"`);
    }
  }

  private async resolveInside(relative: string): Promise<FsTarget> {
    const target = await this.fs.resolve(relative);
    if (!this.fs.contains(this.rootTarget, target)) {
      throw new Error(`Path resolves outside the workspace: "${relative}"`);
    }
    return target;
  }

  private async waitFor(record: DshCommandRecord, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (record.process.status === 'running' && Date.now() < deadline) {
      this.drain(record);
      await Promise.race([
        record.process.done,
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now()))),
      ]);
    }
    this.drain(record);
    outputStatus(record);
  }

  private drain(record: DshCommandRecord): void {
    const read = record.process.readOutput();
    if (read.delta) {
      const buffer = Buffer.from(read.delta);
      record.chunks.push(buffer);
      record.size += buffer.length;
      while (record.size > this.config.limits.maxCommandOutputBytes && record.chunks.length > 0) {
        const first = record.chunks[0]!;
        const excess = record.size - this.config.limits.maxCommandOutputBytes;
        if (first.length <= excess) {
          record.chunks.shift();
          record.size -= first.length;
          record.baseOffset += first.length;
        } else {
          record.chunks[0] = first.subarray(excess);
          record.size -= excess;
          record.baseOffset += excess;
        }
      }
    }
  }

  private snapshot(record: DshCommandRecord, requestedOffset: number): CommandOutput {
    this.drain(record);
    outputStatus(record);
    const endOffset = record.baseOffset + record.size;
    const offset = Math.max(record.baseOffset, Math.min(requestedOffset, endOffset));
    const output = Buffer.concat(record.chunks).subarray(offset - record.baseOffset).toString('utf8');
    return {
      commandId: record.id,
      command: record.command,
      status: record.status,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      output,
      offset,
      nextOffset: endOffset,
      baseOffset: record.baseOffset,
      truncatedBeforeOffset: requestedOffset < record.baseOffset,
      startedAt: record.startedAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    };
  }

  private requireCommand(commandId: string): DshCommandRecord {
    const record = this.commands.get(commandId);
    if (!record) throw new Error(`Unknown command ID: "${commandId}"`);
    return record;
  }
}
