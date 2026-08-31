import type {
  BridgeConfig,
  BridgeProgress,
  PatchResult,
  RunCommandOptions,
  TextSearchMatch,
  VersionedFile,
  WorkspaceAdapter,
  WorkspaceEntry,
} from '../types.js';
import { CommandManager } from '../commands/manager.js';
import { LanguageServerManager } from '../lsp/manager.js';
import { WorkspaceFiles } from './files.js';
import { WorkspacePatchApplier } from './patch.js';

export class LocalWorkspaceAdapter implements WorkspaceAdapter {
  readonly workspaceRoot: string;
  private readonly files: WorkspaceFiles;
  private readonly patches: WorkspacePatchApplier;
  private readonly commands: CommandManager;
  private readonly languageServers: LanguageServerManager;
  private progress?: BridgeProgress;

  private constructor(private readonly config: BridgeConfig) {
    this.workspaceRoot = config.workspaceRoot;
    this.files = new WorkspaceFiles(config.workspaceRoot, config.limits);
    this.patches = new WorkspacePatchApplier(this.files.paths);
    this.commands = new CommandManager(this.files.paths, config.limits);
    this.languageServers = new LanguageServerManager(this.files, config.languageServers);
  }

  static async create(config: BridgeConfig): Promise<LocalWorkspaceAdapter> {
    const adapter = new LocalWorkspaceAdapter(config);
    await adapter.files.initialize();
    return adapter;
  }

  listFiles(patterns?: string[], limit?: number): Promise<WorkspaceEntry[]> {
    return this.files.listFiles(patterns, limit);
  }

  listDirectory(directory?: string, depth?: number, limit?: number): Promise<WorkspaceEntry[]> {
    return this.files.listDirectory(directory, depth, limit);
  }

  searchText(
    query: string,
    options?: {
      isRegex?: boolean | undefined;
      caseSensitive?: boolean | undefined;
      include?: string[] | undefined;
      limit?: number | undefined;
    },
  ): Promise<TextSearchMatch[]> {
    return this.files.searchText(query, options);
  }

  readFile(filePath: string, startLine?: number, endLine?: number): Promise<VersionedFile> {
    return this.files.readFile(filePath, startLine, endLine);
  }

  applyPatch(patch: string, expectedVersions?: Record<string, string>): Promise<PatchResult> {
    return this.patches.apply(patch, expectedVersions);
  }

  runCommand(options: RunCommandOptions) {
    return this.commands.run(options);
  }

  getCommandOutput(commandId: string, offset?: number, waitMs?: number) {
    return this.commands.getOutput(commandId, offset, waitMs);
  }

  sendCommandInput(commandId: string, input: string, close?: boolean) {
    return this.commands.sendInput(commandId, input, close);
  }

  terminateCommand(commandId: string) {
    return this.commands.terminate(commandId);
  }

  getDiagnostics(filePath?: string, waitMs?: number): Promise<unknown> {
    return this.languageServers.getDiagnostics(filePath, waitMs);
  }

  reportProgress(progress: Omit<BridgeProgress, 'updatedAt'>): BridgeProgress {
    this.progress = { ...progress, updatedAt: new Date().toISOString() };
    return this.progress;
  }

  getProgress(): BridgeProgress | undefined {
    return this.progress;
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.commands.dispose(),
      this.languageServers.dispose(),
    ]);
  }
}
