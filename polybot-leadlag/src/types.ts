export type BotMode = 'dry-run' | 'paper' | 'live';

export type Coin = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export type Duration = '5m' | '15m';

export type Side = 'UP' | 'DOWN';

export interface TokenBook {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  spread: number;
  timestamp: number;
}

export interface ClobToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface GammaMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  active: boolean;
  closed: boolean;
}

export interface ClobMarket {
  conditionId: string;
  marketSlug: string;
  question: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  endDateIso?: string | null;
  minimumOrderSize: number;
  tokens: ClobToken[];
}

export interface OrderbookSnapshot {
  tokenId: string;
  assetId: string;
  market: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
  tickSize: string;
  minOrderSize: string;
  hash: string;
}

export interface TrackedMarket {
  conditionId: string;
  slug: string;
  question: string;
  coin: Coin;
  duration: Duration;
  startTime: number;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  minOrderSize: number;
  baseline?: number;
  baselineCapturedAt?: number;
}

export interface OpenPosition {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  coin: Coin;
  duration: Duration;
  side: Side;
  tokenId: string;
  upTokenId: string;
  downTokenId: string;
  baseline: number;
  stake: number;
  entryPrice: number;
  shares: number;
  openedAt: number;
  endTime: number;
  mode: BotMode;
  settledAt?: number;
  payout?: number;
  realizedPnl?: number;
}

export interface StoredState {
  createdAt: number;
  updatedAt: number;
  paperBalance: number;
  baselines: Record<string, { value: number; capturedAt: number }>;
  positions: OpenPosition[];
}

export interface ExternalPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface CryptoPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface SignalCandidate {
  side: Side;
  ask: number;
  askSize: number;
  spread: number;
  impliedProb: number;
  edge: number;
  marketMid: number;
  marketLag: number;
  chainlinkDeltaBps: number;
  binanceDeltaBps: number;
  binancePulseBps: number;
  leadGapBps: number;
}
