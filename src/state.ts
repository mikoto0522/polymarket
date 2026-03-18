import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotMode, OpenPosition, StoredState } from './types.js';

export class StateStore {
  private readonly filePath: string;
  private state: StoredState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string, mode: BotMode, paperBalance: number) {
    this.filePath = path.join(dataDir, `${mode}.state.json`);
    this.state = this.load() || {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      paperBalance,
      baselines: {},
      positions: [],
    };
  }

  getPaperBalance(): number {
    return this.state.paperBalance;
  }

  setPaperBalance(value: number): void {
    this.state.paperBalance = value;
    this.scheduleSave();
  }

  getBaseline(conditionId: string): { value: number; capturedAt: number } | undefined {
    return this.state.baselines[conditionId];
  }

  setBaseline(conditionId: string, value: number, capturedAt: number): void {
    this.state.baselines[conditionId] = { value, capturedAt };
    this.scheduleSave();
  }

  getOpenPositions(): OpenPosition[] {
    return this.state.positions.filter((pos) => !pos.settledAt);
  }

  hasOpenPosition(conditionId: string): boolean {
    return this.getOpenPositions().some((pos) => pos.conditionId === conditionId);
  }

  addPosition(position: OpenPosition): void {
    this.state.positions.push(position);
    this.scheduleSave();
  }

  settlePosition(id: string, payout: number, realizedPnl: number): void {
    const pos = this.state.positions.find((item) => item.id === id);
    if (!pos || pos.settledAt) return;
    pos.payout = payout;
    pos.realizedPnl = realizedPnl;
    pos.settledAt = Date.now();
    this.scheduleSave();
  }

  getState(): StoredState {
    return this.state;
  }

  private load(): StoredState | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as StoredState;
    } catch {
      return null;
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 50);
  }

  private save(): void {
    this.state.updatedAt = Date.now();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}
