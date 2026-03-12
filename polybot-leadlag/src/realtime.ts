import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { CryptoPrice, OrderbookSnapshot } from './types.js';

const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const LIVE_WS = 'wss://ws-live-data.polymarket.com';

interface ManagedSocketConfig {
  url: string;
  onOpen: () => void;
  onMessage: (raw: string) => void;
}

class ManagedSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private reconnectAttempts = 0;

  constructor(private readonly config: ManagedSocketConfig) {}

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.intentionalClose = false;
    this.ws = new WebSocket(this.config.url);
    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data: WebSocket.RawData) => this.config.onMessage(data.toString()));
    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', () => {
      // close handler will drive reconnects
    });
    this.ws.on('pong', () => {
      // ws client keeps connection alive; explicit ping loop is enough
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'client shutdown');
      this.ws = null;
    }
  }

  sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.startPing();
    this.config.onOpen();
  }

  private handleClose(): void {
    this.stopPing();
    this.ws = null;
    if (this.intentionalClose) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export class PolymarketRealtime extends EventEmitter {
  private readonly marketSocket: ManagedSocket;
  private readonly liveSocket: ManagedSocket;
  private readonly marketTokens = new Set<string>();
  private readonly liveBinanceSymbols = new Set<string>();
  private readonly liveChainlinkSymbols = new Set<string>();
  private marketReady = false;
  private liveReady = false;
  private marketInitialized = false;

  constructor() {
    super();
    this.marketSocket = new ManagedSocket({
      url: MARKET_WS,
      onOpen: () => {
        this.marketReady = true;
        this.marketInitialized = false;
        this.flushMarketSubscriptions();
        this.emit('marketConnected');
      },
      onMessage: (raw) => this.handleMarketMessage(raw),
    });

    this.liveSocket = new ManagedSocket({
      url: LIVE_WS,
      onOpen: () => {
        this.liveReady = true;
        this.flushLiveSubscriptions();
        this.emit('liveConnected');
      },
      onMessage: (raw) => this.handleLiveMessage(raw),
    });
  }

  async connect(timeoutMs = 15000): Promise<void> {
    const waiters = [
      onceConnected(this, 'marketConnected'),
      onceConnected(this, 'liveConnected'),
    ];

    this.marketSocket.connect();
    this.liveSocket.connect();

    await promiseWithTimeout(Promise.all(waiters).then(() => undefined), timeoutMs, 'WebSocket timeout');
  }

  disconnect(): void {
    this.marketReady = false;
    this.liveReady = false;
    this.marketInitialized = false;
    this.marketSocket.disconnect();
    this.liveSocket.disconnect();
  }

  subscribeMarkets(tokenIds: string[]): void {
    let changed = false;
    for (const tokenId of tokenIds) {
      if (!this.marketTokens.has(tokenId)) {
        this.marketTokens.add(tokenId);
        changed = true;
      }
    }
    if (changed) {
      this.flushMarketSubscriptions();
    }
  }

  subscribeCryptoPrices(symbols: string[]): void {
    let changed = false;
    for (const symbol of symbols) {
      if (!this.liveBinanceSymbols.has(symbol)) {
        this.liveBinanceSymbols.add(symbol);
        changed = true;
      }
    }
    if (changed) {
      this.flushLiveSubscriptions();
    }
  }

  subscribeCryptoChainlinkPrices(symbols: string[]): void {
    let changed = false;
    for (const symbol of symbols) {
      if (!this.liveChainlinkSymbols.has(symbol)) {
        this.liveChainlinkSymbols.add(symbol);
        changed = true;
      }
    }
    if (changed) {
      this.flushLiveSubscriptions();
    }
  }

  private flushMarketSubscriptions(): void {
    if (!this.marketReady || this.marketTokens.size === 0) return;
    const assetIds = [...this.marketTokens];
    if (!this.marketInitialized) {
      this.marketSocket.sendJson({
        type: 'MARKET',
        assets_ids: assetIds,
      });
      this.marketInitialized = true;
      return;
    }

    this.marketSocket.sendJson({
      operation: 'subscribe',
      assets_ids: assetIds,
    });
  }

  private flushLiveSubscriptions(): void {
    if (!this.liveReady) return;

    for (const symbol of this.liveBinanceSymbols) {
      this.liveSocket.sendJson({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices',
          type: '*',
          filters: JSON.stringify({ symbol }),
        }],
      });
    }

    for (const symbol of this.liveChainlinkSymbols) {
      this.liveSocket.sendJson({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: JSON.stringify({ symbol }),
        }],
      });
    }
  }

  private handleMarketMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const record = asRecord(item);
      if (!record || !('bids' in record || 'asks' in record)) continue;

      const book = parseOrderbook(record);
      if (!book.assetId) continue;
      this.emit('orderbook', book);
    }
  }

  private handleLiveMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record || !record.topic) return;
    if (record.topic !== 'crypto_prices' && record.topic !== 'crypto_prices_chainlink') return;

    const payload = asRecord(record.payload);
    if (!payload) return;

    const price = parseCryptoPrice(payload);
    if (!price) return;

    if (record.topic === 'crypto_prices') {
      this.emit('binancePrice', price);
    } else {
      this.emit('chainlinkPrice', price);
    }
  }
}

function parseOrderbook(payload: Record<string, unknown>): OrderbookSnapshot {
  const bids = Array.isArray(payload.bids) ? payload.bids : [];
  const asks = Array.isArray(payload.asks) ? payload.asks : [];

  return {
    tokenId: stringValue(payload.asset_id),
    assetId: stringValue(payload.asset_id),
    market: stringValue(payload.market),
    bids: bids.map(parseLevel).sort((a, b) => b.price - a.price),
    asks: asks.map(parseLevel).sort((a, b) => a.price - b.price),
    timestamp: normalizeTimestamp(payload.timestamp),
    tickSize: stringValue(payload.tick_size, '0.01'),
    minOrderSize: stringValue(payload.min_order_size, '1'),
    hash: stringValue(payload.hash),
  };
}

function parseLevel(input: unknown): { price: number; size: number } {
  const record = asRecord(input);
  if (!record) return { price: 0, size: 0 };
  return {
    price: numberValue(record.price),
    size: numberValue(record.size),
  };
}

function parseCryptoPrice(payload: Record<string, unknown>): CryptoPrice | null {
  const symbol = stringValue(payload.symbol);
  const price = numberValue(payload.value);
  if (!symbol || !Number.isFinite(price) || price <= 0) return null;
  return {
    symbol,
    price,
    timestamp: normalizeTimestamp(payload.timestamp),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTimestamp(value: unknown): number {
  const parsed = numberValue(value);
  if (!parsed) return Date.now();
  return parsed < 1e12 ? parsed * 1000 : parsed;
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function onceConnected(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}
