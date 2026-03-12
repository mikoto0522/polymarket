import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ReplayEvent<T = Record<string, unknown>> {
  ts: number;
  type: string;
  payload: T;
}

export class ReplayRecorder {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private readonly tickMinMs: number;
  private readonly lastTickAt = new Map<string, number>();

  constructor(baseDir: string, replayDir: string, enabled: boolean, tickMinMs: number) {
    this.enabled = enabled;
    this.tickMinMs = tickMinMs;

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(baseDir, replayDir);
    this.filePath = path.join(dir, `run-${runId}.jsonl`);

    if (this.enabled) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  record<T extends Record<string, unknown>>(type: string, payload: T): void {
    if (!this.enabled) return;
    const event: ReplayEvent<T> = {
      ts: Date.now(),
      type,
      payload,
    };
    fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n');
  }

  recordTick<T extends Record<string, unknown>>(bucket: string, key: string, payload: T): void {
    if (!this.enabled) return;
    const id = `${bucket}:${key}`;
    const now = Date.now();
    const last = this.lastTickAt.get(id) || 0;
    if (now - last < this.tickMinMs) return;
    this.lastTickAt.set(id, now);
    this.record(bucket, payload);
  }

  getPath(): string {
    return this.filePath;
  }
}
