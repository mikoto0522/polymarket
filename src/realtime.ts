import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { CryptoPrice, OrderbookSnapshot } from './types.js';

const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const LIVE_WS = 'wss://ws-live-data.polymarket.com';
const BINANCE_WS = 'wss://stream.binance.com:443/stream';

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
      // close handler drives reconnects
    });
    this.ws.on('pong', () => {
      // ping loop is only for Polymarket sockets
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

  setPing(enabled: boolean): void {
    if (!enabled) {
      this.stopPing();
      return;
    }
    this.startPing();
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
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
  private readonly chainlinkSocket: ManagedSocket;
  private readonly binanceSocket: ManagedSocket;
  private readonly marketTokens = new Set<string>();
  private readonly chainlinkSymbols = new Set<string>();
  private readonly binanceSymbols = new Set<string>();
  private marketReady = false;
  private chainlinkReady = false;
  private binanceReady = false;
  private marketInitialized = false;

  constructor() {
    super();

    this.marketSocket = new ManagedSocket({
      url: MARKET_WS,
      onOpen: () => {
        this.marketReady = true;
        this.marketInitialized = false;
        this.marketSocket.setPing(true);
        this.flushMarketSubscriptions();
        this.emit('marketConnected');
      },
      onMessage: (raw) => this.handleMarketMessage(raw),
    });

    this.chainlinkSocket = new ManagedSocket({
      url: LIVE_WS,
      onOpen: () => {
        this.chainlinkReady = true;
        this.chainlinkSocket.setPing(true);
        this.flushChainlinkSubscriptions();
        this.emit('chainlinkConnected');
      },
      onMessage: (raw) => this.handleChainlinkMessage(raw),
    });

    this.binanceSocket = new ManagedSocket({
      url: BINANCE_WS,
      onOpen: () => {
        this.binanceReady = true;
        this.flushBinanceSubscriptions();
        this.emit('binanceConnected');
      },
      onMessage: (raw) => this.handleBinanceMessage(raw),
    });
  }

  async connect(timeoutMs = 15000): Promise<void> {
    const waiters = [
      onceConnected(this, 'marketConnected'),
      onceConnected(this, 'binanceConnected'),
    ];

    this.marketSocket.connect();
    this.chainlinkSocket.connect();
    this.binanceSocket.connect();

    await promiseWithTimeout(Promise.all(waiters).then(() => undefined), timeoutMs, 'WebSocket timeout');
  }

  disconnect(): void {
    this.marketReady = false;
    this.chainlinkReady = false;
    this.binanceReady = false;
    this.marketInitialized = false;
    this.marketSocket.disconnect();
    this.chainlinkSocket.disconnect();
    this.binanceSocket.disconnect();
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
      const lower = symbol.toLowerCase();
      if (!this.binanceSymbols.has(lower)) {
        this.binanceSymbols.add(lower);
        changed = true;
      }
    }
    if (changed) {
      this.flushBinanceSubscriptions();
    }
  }

  subscribeCryptoChainlinkPrices(symbols: string[]): void {
    let changed = false;
    for (const symbol of symbols) {
      const lower = symbol.toLowerCase();
      if (!this.chainlinkSymbols.has(lower)) {
        this.chainlinkSymbols.add(lower);
        changed = true;
      }
    }
    if (changed) {
      this.flushChainlinkSubscriptions();
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

  private flushChainlinkSubscriptions(): void {
    if (!this.chainlinkReady || this.chainlinkSymbols.size === 0) return;

    const subscriptions = [...this.chainlinkSymbols].map((symbol) => ({
      topic: 'crypto_prices_chainlink',
      type: '*',
      filters: JSON.stringify({ symbol }),
    }));

    this.chainlinkSocket.sendJson({
      action: 'subscribe',
      subscriptions,
    });
  }

  private flushBinanceSubscriptions(): void {
    if (!this.binanceReady || this.binanceSymbols.size === 0) return;

    this.binanceSocket.sendJson({
      method: 'SUBSCRIBE',
      params: [...this.binanceSymbols].map((symbol) => `${symbol}@trade`),
      id: Date.now(),
    });
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

  private handleChainlinkMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record || record.topic !== 'crypto_prices_chainlink') return;
    const payload = asRecord(record.payload);
    if (!payload) return;

    const price = parseRtdsPrice(payload);
    if (!price) return;
    this.emit('chainlinkPrice', price);
  }

  private handleBinanceMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record) return;
    if ('result' in record) return;

    const stream = stringValue(record.stream);
    const data = asRecord(record.data);
    if (!stream || !data) return;
    if (!stream.endsWith('@trade')) return;

    const symbol = stringValue(data.s);
    const price = numberValue(data.p);
    const eventTime = numberValue(data.E);
    if (!symbol || !Number.isFinite(price) || price <= 0) return;

    this.emit('binancePrice', {
      symbol: symbol.toLowerCase(),
      price,
      timestamp: eventTime || Date.now(),
    } satisfies CryptoPrice);
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

function parseRtdsPrice(payload: Record<string, unknown>): CryptoPrice | null {
  const symbol = stringValue(payload.symbol).toLowerCase();
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
