import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Coin, Duration, Side, TokenBook } from './types.js';

export interface MarketSnapshotRow {
  conditionId: string;
  slug: string;
  question: string;
  coin: Coin;
  duration: Duration;
  timestampMs: number;
  startTime: number;
  endTime: number;
  secondsTillEnd: number;
  baseline: number;
  baselineCapturedAt: number;
  binancePrice: number;
  chainlinkPrice: number;
  binanceAgeMs: number;
  chainlinkAgeMs: number;
  binanceDeltaBps: number;
  chainlinkDeltaBps: number;
  leadGapBps: number;
  binancePulseBps: number;
  up: TokenBook;
  down: TokenBook;
  preferredSide: Side | 'NA';
  preferredAsk: number;
  preferredEdge: number;
  preferredLag: number;
}

const HEADER = [
  'timestamp_ms',
  'condition_id',
  'slug',
  'coin',
  'duration',
  'question',
  'start_time',
  'end_time',
  'seconds_till_end',
  'baseline',
  'baseline_captured_at',
  'binance_price',
  'chainlink_price',
  'binance_age_ms',
  'chainlink_age_ms',
  'binance_delta_bps',
  'chainlink_delta_bps',
  'lead_gap_bps',
  'binance_pulse_bps',
  'up_bid',
  'up_ask',
  'up_bid_size',
  'up_ask_size',
  'up_spread',
  'down_bid',
  'down_ask',
  'down_bid_size',
  'down_ask_size',
  'down_spread',
  'sum_asks',
  'sum_bids',
  'mid_gap',
  'preferred_side',
  'preferred_ask',
  'preferred_edge',
  'preferred_lag',
];

export class MarketDataRecorder {
  private readonly enabled: boolean;
  private readonly minMs: number;
  private readonly runDir: string;
  private readonly lastWrittenAt = new Map<string, number>();
  private readonly streams = new Map<string, fs.WriteStream>();
  private readonly initialized = new Set<string>();

  constructor(baseDir: string, recorderDir: string, enabled: boolean, minMs: number) {
    this.enabled = enabled;
    this.minMs = minMs;
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    this.runDir = path.join(baseDir, recorderDir, `run-${runId}`);
    if (this.enabled) {
      fs.mkdirSync(this.runDir, { recursive: true });
    }
  }

  record(row: MarketSnapshotRow): void {
    if (!this.enabled) return;
    const last = this.lastWrittenAt.get(row.conditionId) || 0;
    if (row.timestampMs - last < this.minMs) return;
    this.lastWrittenAt.set(row.conditionId, row.timestampMs);

    const stream = this.getStream(row.conditionId, row.slug);
    if (!this.initialized.has(row.conditionId)) {
      stream.write(HEADER.join(',') + '\n');
      this.initialized.add(row.conditionId);
    }

    const sumAsks = safeAdd(row.up.bestAsk, row.down.bestAsk);
    const sumBids = safeAdd(row.up.bestBid, row.down.bestBid);
    const upMid = midpoint(row.up.bestBid, row.up.bestAsk);
    const downMid = midpoint(row.down.bestBid, row.down.bestAsk);
    const values = [
      row.timestampMs,
      row.conditionId,
      row.slug,
      row.coin,
      row.duration,
      row.question,
      row.startTime,
      row.endTime,
      row.secondsTillEnd.toFixed(3),
      row.baseline,
      row.baselineCapturedAt,
      row.binancePrice,
      row.chainlinkPrice,
      row.binanceAgeMs,
      row.chainlinkAgeMs,
      row.binanceDeltaBps,
      row.chainlinkDeltaBps,
      row.leadGapBps,
      row.binancePulseBps,
      row.up.bestBid,
      row.up.bestAsk,
      row.up.bidSize,
      row.up.askSize,
      row.up.spread,
      row.down.bestBid,
      row.down.bestAsk,
      row.down.bidSize,
      row.down.askSize,
      row.down.spread,
      sumAsks,
      sumBids,
      upMid - downMid,
      row.preferredSide,
      row.preferredAsk,
      row.preferredEdge,
      row.preferredLag,
    ];

    stream.write(values.map(csvValue).join(',') + '\n');
  }

  getRunDir(): string {
    return this.runDir;
  }

  async close(): Promise<void> {
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(streams.map((stream) => new Promise<void>((resolve) => stream.end(resolve))));
  }

  private getStream(conditionId: string, slug: string): fs.WriteStream {
    const existing = this.streams.get(conditionId);
    if (existing) return existing;
    const safeSlug = slug.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 120);
    const filePath = path.join(this.runDir, `${safeSlug}.csv`);
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.streams.set(conditionId, stream);
    return stream;
  }
}

function csvValue(value: string | number): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  const text = value ?? '';
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function midpoint(bid: number, ask: number): number {
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return 0;
}

function safeAdd(a: number, b: number): number {
  if (a > 0 && b > 0) return a + b;
  return 0;
}
