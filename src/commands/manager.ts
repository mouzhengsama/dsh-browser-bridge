import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { BridgeLimits, CommandOutput, RunCommandOptions } from '../types.js';
import type { WorkspacePaths } from '../workspace/paths.js';

interface CommandRecord {
  id: string;
  command: string;
  child: ChildProcess;
  status: CommandOutput['status'];
  exitCode?: number | null;
  signal?: string | null;
  chunks: Buffer[];
  size: number;
  baseOffset: number;
  startedAt: string;
  endedAt?: string;
  completed: Promise<void>;
  resolveCompleted: () => void;
}

function boundedWait(waitMs: number | undefined, limits: BridgeLimits): number {
  return Math.max(0, Math.min(waitMs ?? limits.defaultCommandWaitMs, limits.maxCommandWaitMs));
}

export class CommandManager {
  private readonly commands = new Map<string, CommandRecord>();

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly limits: BridgeLimits,
  ) {}

  async run(options: RunCommandOptions): Promise<CommandOutput> {
    if (!options.command.trim()) {
      throw new Error('Command must not be empty');
    }
    const cwd = await this.paths.resolve(options.cwd ?? '.', { mustExist: true });
    const id = randomUUID();
    let resolveCompleted = (): void => undefined;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const child = spawn(options.command, {
      cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const record: CommandRecord = {
      id,
      command: options.command,
      child,
      status: 'running',
      chunks: [],
      size: 0,
      baseOffset: 0,
      startedAt: new Date().toISOString(),
      completed,
      resolveCompleted,
    };
    this.commands.set(id, record);

    const append = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      record.chunks.push(buffer);
      record.size += buffer.length;
      while (record.size > this.limits.maxCommandOutputBytes && record.chunks.length > 0) {
        const first = record.chunks[0]!;
        const excess = record.size - this.limits.maxCommandOutputBytes;
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
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    const settle = (
      status: CommandOutput['status'],
      exitCode?: number | null,
      signal?: string | null,
    ): void => {
      if (settled) return;
      settled = true;
      record.status = status;
      if (exitCode !== undefined) record.exitCode = exitCode;
      if (signal !== undefined) record.signal = signal;
      record.endedAt = new Date().toISOString();
      record.resolveCompleted();
    };
    child.on('error', (error) => {
      append(`\n[dsh-bridge] command failed: ${error.message}\n`);
      settle('failed', null, null);
    });
    child.on('close', (code, signal) => {
      settle('exited', code, signal);
    });

    await this.waitFor(record, boundedWait(options.waitMs, this.limits));
    return this.snapshot(record, 0);
  }

  async getOutput(commandId: string, offset = 0, waitMs = 0): Promise<CommandOutput> {
    const record = this.require(commandId);
    if (record.status === 'running') {
      await this.waitFor(record, boundedWait(waitMs, this.limits));
    }
    return this.snapshot(record, offset);
  }

  async sendInput(commandId: string, input: string, close = false): Promise<CommandOutput> {
    const record = this.require(commandId);
    if (record.status !== 'running' || !record.child.stdin) {
      throw new Error(`Command is not accepting input: "${commandId}"`);
    }
    if (input) {
      record.child.stdin.write(input);
    }
    if (close) {
      record.child.stdin.end();
    }
    return this.snapshot(record, record.baseOffset + record.size);
  }

  async terminate(commandId: string): Promise<CommandOutput> {
    const record = this.require(commandId);
    if (record.status === 'running') {
      record.child.kill();
      await this.waitFor(record, 5_000);
    }
    return this.snapshot(record, record.baseOffset);
  }

  renameCommand(oldId: string, newId: string): void {
    const record = this.require(oldId);
    if (this.commands.has(newId)) {
      throw new Error(`Command ID already exists: "${newId}"`);
    }
    this.commands.delete(oldId);
    record.id = newId;
    this.commands.set(newId, record);
  }

  async dispose(): Promise<void> {
    const running = [...this.commands.values()].filter((record) => record.status === 'running');
    for (const record of running) {
      record.child.kill();
    }
    await Promise.all(running.map((record) => this.waitFor(record, 5_000)));
    this.commands.clear();
  }

  private require(commandId: string): CommandRecord {
    const record = this.commands.get(commandId);
    if (!record) {
      throw new Error(`Unknown command ID: "${commandId}"`);
    }
    return record;
  }

  private async waitFor(record: CommandRecord, waitMs: number): Promise<void> {
    if (record.status !== 'running' || waitMs <= 0) {
      return;
    }
    await Promise.race([
      record.completed,
      new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
    ]);
  }

  private snapshot(record: CommandRecord, requestedOffset: number): CommandOutput {
    const endOffset = record.baseOffset + record.size;
    const offset = Math.max(record.baseOffset, Math.min(requestedOffset, endOffset));
    const buffer = Buffer.concat(record.chunks);
    const output = buffer.subarray(offset - record.baseOffset).toString('utf8');
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
}
