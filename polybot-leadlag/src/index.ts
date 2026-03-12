import { randomUUID } from 'node:crypto';
import { loadConfig, type Config } from './config.js';
import { LiveTradingClient } from './live.js';
import { Logger } from './logger.js';
import { fetchClobMarket, fetchGammaMarketBySlug } from './polymarket-api.js';
import { PolymarketRealtime } from './realtime.js';
import { ReplayRecorder } from './replay.js';
import { StateStore } from './state.js';
import type {
  Coin,
  CryptoPrice,
  Duration,
  GammaMarket,
  ExternalPrice,
  OpenPosition,
  OrderbookSnapshot,
  Side,
  SignalCandidate,
  TokenBook,
  TrackedMarket,
} from './types.js';

const BINANCE_SYMBOLS: Record<Coin, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

const CHAINLINK_SYMBOLS: Record<Coin, string> = {
  BTC: 'btc/usd',
  ETH: 'eth/usd',
  SOL: 'sol/usd',
  XRP: 'xrp/usd',
};

class LeadLagBot {
  private readonly config: Config;
  private readonly log = new Logger();
  private readonly state: StateStore;
  private readonly replay: ReplayRecorder;
  private readonly realtime = new PolymarketRealtime();
  private live: LiveTradingClient | null = null;

  private readonly markets = new Map<string, TrackedMarket>();
  private readonly orderbooks = new Map<string, TokenBook>();
  private readonly chainlink = new Map<Coin, ExternalPrice>();
  private readonly binance = new Map<Coin, ExternalPrice>();
  private readonly binanceHistory = new Map<Coin, ExternalPrice[]>();
  private readonly subscribedMarkets = new Set<string>();
  private readonly coinCooldownUntil = new Map<Coin, number>();
  private readonly rejectCounts = new Map<string, number>();

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dataDir, config.paperBalance);
    this.replay = new ReplayRecorder(
      config.dataDir,
      config.replayDir,
      config.replayEnabled,
      config.replayTickMinMs,
    );
  }

  async start(): Promise<void> {
    if (this.config.mode === 'live') {
      this.live = new LiveTradingClient({
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
        chainId: this.config.chainId,
      });
      await this.live.initialize();
      this.log.info(`Live wallet: ${this.live.getAddress()}`);
    }

    this.log.info(`Mode: ${this.config.mode}`);
    this.log.info(`Budget: $${this.config.budget.toFixed(2)} | Paper balance: $${this.state.getPaperBalance().toFixed(2)}`);
    this.log.info(`Replay log: ${this.replay.getPath()}`);
    this.replay.record('run_start', {
      mode: this.config.mode,
      budget: this.config.budget,
      paperBalance: this.state.getPaperBalance(),
      coins: this.config.coins,
      durations: this.config.durations,
      closeWindowSec: this.config.closeWindowSec,
      binanceTriggerBps: this.config.binanceTriggerBps,
      minBinancePulseBps: this.config.minBinancePulseBps,
      minLeadGapBps: this.config.minLeadGapBps,
      minEdge: this.config.minEdge,
      minMarketLag: this.config.minMarketLag,
      maxAsk: this.config.maxAsk,
      maxSpread: this.config.maxSpread,
      minTopBookValue: this.config.minTopBookValue,
    });

    this.realtime.on('orderbook', (book: OrderbookSnapshot) => this.handleOrderbook(book));
    this.realtime.on('binancePrice', (price: CryptoPrice) => this.handleBinancePrice(price));
    this.realtime.on('chainlinkPrice', (price: CryptoPrice) => this.handleChainlinkPrice(price));
    await this.realtime.connect();

    this.subscribeExternalPrices();
    await this.discoverMarkets();
    this.captureBaselines();
    this.evaluateMarkets();
    await this.settlePositions();

    setInterval(() => void this.discoverMarkets(), this.config.scanSec * 1000);
    setInterval(() => {
      this.captureBaselines();
      this.evaluateMarkets();
    }, this.config.evalMs);
    setInterval(() => void this.settlePositions(), this.config.settleSec * 1000);
    setInterval(() => this.printStatus(), this.config.statusSec * 1000);

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    this.log.info('Lead-lag engine is running.');
    await new Promise(() => undefined);
  }

  private subscribeExternalPrices(): void {
    const binanceSymbols = this.config.coins.map((coin) => BINANCE_SYMBOLS[coin]);
    const chainlinkSymbols = this.config.coins.map((coin) => CHAINLINK_SYMBOLS[coin]);

    this.realtime.subscribeCryptoPrices(binanceSymbols);
    this.realtime.subscribeCryptoChainlinkPrices(chainlinkSymbols);
  }

  private handleBinancePrice(price: CryptoPrice): void {
    const coin = toCoinFromBinance(price.symbol);
    if (!coin) return;
    const tick = {
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    };
    this.binance.set(coin, tick);
    this.replay.recordTick('binance_tick', coin, {
      coin,
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    });

    const history = this.binanceHistory.get(coin) || [];
    history.push(tick);
    const cutoff = Date.now() - Math.max(this.config.binanceLookbackMs * 3, 15_000);
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
    this.binanceHistory.set(coin, history);
  }

  private handleChainlinkPrice(price: CryptoPrice): void {
    const coin = toCoinFromChainlink(price.symbol);
    if (!coin) return;
    this.chainlink.set(coin, {
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    });
    this.replay.recordTick('chainlink_tick', coin, {
      coin,
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    });
  }

  private async discoverMarkets(): Promise<void> {
    const slugs = generateCandidateSlugs(this.config.coins, this.config.durations);
    for (const slug of slugs) {
      try {
        const gamma = await fetchGammaMarketBySlug(slug);
        if (!gamma || gamma.closed || !isShortTermCrypto(gamma)) continue;
        if (this.markets.has(gamma.conditionId)) continue;

        const clob = await fetchClobMarket(gamma.conditionId);
        if (!clob || clob.closed || !clob.acceptingOrders || clob.tokens.length < 2) continue;

        const meta = buildTrackedMarket(gamma, clob.tokens);
        const savedBaseline = this.state.getBaseline(meta.conditionId);
        if (savedBaseline) {
          meta.baseline = savedBaseline.value;
          meta.baselineCapturedAt = savedBaseline.capturedAt;
        }

        this.markets.set(meta.conditionId, meta);
        this.subscribeMarket(meta);
        this.log.info(`[+MKT] ${meta.slug} | ${meta.question}`);
        this.replay.record('market_discovered', {
          conditionId: meta.conditionId,
          slug: meta.slug,
          question: meta.question,
          coin: meta.coin,
          duration: meta.duration,
          startTime: meta.startTime,
          endTime: meta.endTime,
          upTokenId: meta.upTokenId,
          downTokenId: meta.downTokenId,
        });
      } catch {
        // Short-lived market lookups frequently miss during creation; keep scanning.
      }
    }

    this.cleanMarkets();
  }

  private subscribeMarket(market: TrackedMarket): void {
    if (this.subscribedMarkets.has(market.conditionId)) return;
    this.subscribedMarkets.add(market.conditionId);
    this.realtime.subscribeMarkets([market.upTokenId, market.downTokenId]);
  }

  private handleOrderbook(book: OrderbookSnapshot): void {
    const bid = Number(book.bids[0]?.price ?? 0);
    const ask = Number(book.asks[0]?.price ?? 0);
    const bidSize = Number(book.bids[0]?.size ?? 0);
    const askSize = Number(book.asks[0]?.size ?? 0);
    this.orderbooks.set(book.assetId, {
      bestBid: bid,
      bestAsk: ask,
      bidSize,
      askSize,
      spread: ask > 0 && bid > 0 ? ask - bid : 1,
      timestamp: Date.now(),
    });
    this.replay.recordTick('orderbook_tick', book.assetId, {
      tokenId: book.assetId,
      market: book.market,
      bid,
      ask,
      bidSize,
      askSize,
      spread: ask > 0 && bid > 0 ? ask - bid : 1,
      timestamp: Date.now(),
    });
  }

  private captureBaselines(): void {
    const now = Date.now();
    for (const market of this.markets.values()) {
      if (market.baseline != null) continue;

      const tick = this.chainlink.get(market.coin);
      if (!tick) continue;
      if (now < market.startTime) continue;
      if (now > market.startTime + this.config.baselineCaptureGraceSec * 1000) continue;

      market.baseline = tick.price;
      market.baselineCapturedAt = tick.timestamp;
      this.state.setBaseline(market.conditionId, tick.price, tick.timestamp);
      this.log.info(`[BASELINE] ${market.slug} @ ${tick.price.toFixed(4)}`);
      this.replay.record('baseline_captured', {
        conditionId: market.conditionId,
        slug: market.slug,
        coin: market.coin,
        baseline: tick.price,
        capturedAt: tick.timestamp,
      });
    }
  }

  private evaluateMarkets(): void {
    const now = Date.now();
    const openPositions = this.state.getOpenPositions();
    if (openPositions.length >= this.config.maxOpenPositions) return;
    let slotsRemaining = this.config.maxOpenPositions - openPositions.length;

    for (const market of this.markets.values()) {
      if (slotsRemaining <= 0) break;
      if (this.state.hasOpenPosition(market.conditionId)) continue;
      if (market.baseline == null) continue;
      if (now < market.startTime) continue;
      if (now >= market.endTime) continue;
      if ((this.coinCooldownUntil.get(market.coin) || 0) > now) continue;

      const timeRemainingSec = (market.endTime - now) / 1000;
      if (timeRemainingSec > this.config.closeWindowSec || timeRemainingSec <= 1) continue;

      const signal = this.buildSignal(market, timeRemainingSec);
      if (!signal) continue;

      void this.openPosition(market, signal);
      slotsRemaining -= 1;
    }
  }

  private buildSignal(market: TrackedMarket, timeRemainingSec: number): SignalCandidate | null {
    const fail = (reason: string, extra: Record<string, unknown> = {}): null => {
      this.rejectCounts.set(reason, (this.rejectCounts.get(reason) || 0) + 1);
      this.replay.recordTick('signal_reject', `${market.conditionId}:${reason}`, {
        conditionId: market.conditionId,
        slug: market.slug,
        coin: market.coin,
        duration: market.duration,
        reason,
        timeRemainingSec,
        ...extra,
      });
      return null;
    };

    const baseline = market.baseline;
    if (baseline == null) return fail('missing_baseline');

    const chain = this.chainlink.get(market.coin);
    const spot = this.binance.get(market.coin);
    if (!chain) return fail('missing_chainlink');
    if (!spot) return fail('missing_binance');

    const now = Date.now();
    if (now - chain.timestamp > this.config.maxExternalAgeMs) {
      return fail('stale_chainlink', { ageMs: now - chain.timestamp });
    }
    if (now - spot.timestamp > this.config.maxExternalAgeMs) {
      return fail('stale_binance', { ageMs: now - spot.timestamp });
    }

    const chainlinkDeltaBps = toBps(chain.price, baseline);
    const binanceDeltaBps = toBps(spot.price, baseline);
    const binancePulseBps = this.getBinancePulseBps(market.coin);
    if (Math.abs(binancePulseBps) < this.config.minBinancePulseBps) {
      return fail('binance_pulse_too_small', { binancePulseBps });
    }
    const direction = chooseDirection(binanceDeltaBps, chainlinkDeltaBps, this.config);
    if (!direction) {
      return fail('direction_rejected', { binanceDeltaBps, chainlinkDeltaBps });
    }
    const leadGapBps = Math.abs(binanceDeltaBps - chainlinkDeltaBps);
    if (leadGapBps < this.config.minLeadGapBps) {
      return fail('lead_gap_too_small', { leadGapBps, binanceDeltaBps, chainlinkDeltaBps });
    }

    const upBook = this.orderbooks.get(market.upTokenId);
    const downBook = this.orderbooks.get(market.downTokenId);
    if (!upBook || !downBook) return fail('missing_orderbook');
    const askBook = direction === 'UP' ? upBook : downBook;
    const ask = askBook?.bestAsk ?? 0;
    if (!askBook) return fail('missing_ask_book');
    if (now - askBook.timestamp > this.config.maxBookAgeMs) {
      return fail('stale_orderbook', { ageMs: now - askBook.timestamp });
    }
    if (askBook.askSize * ask < this.config.minTopBookValue) {
      return fail('top_book_value_too_small', { topBookValue: askBook.askSize * ask });
    }
    if (askBook.spread > this.config.maxSpread) {
      return fail('spread_too_wide', { spread: askBook.spread });
    }
    if (ask <= 0 || ask > this.config.maxAsk) {
      return fail('ask_out_of_range', { ask });
    }

    const chainAligned = Math.sign(chainlinkDeltaBps) === 0 || Math.sign(chainlinkDeltaBps) === Math.sign(binanceDeltaBps);
    const anchorBonusBps = chainAligned
      ? Math.min(Math.abs(chainlinkDeltaBps), this.config.chainlinkConfirmBps * 2)
      : 0;
    const pulseBonus = Math.abs(binancePulseBps) * 0.9;
    const strengthBps = Math.abs(binanceDeltaBps) + leadGapBps * 0.7 + anchorBonusBps * 0.4 + pulseBonus;
    const certainty = clamp(1 - (timeRemainingSec / this.config.closeWindowSec), 0.2, 1);
    const impliedProb = clamp(0.5 + (strengthBps / this.config.fairScaleBps) * 0.47 * certainty, 0.5, 0.97);
    const oppositeBid = direction === 'UP' ? downBook.bestBid : upBook.bestBid;
    const marketMid = clamp((ask + (1 - oppositeBid)) / 2, 0, 1);
    const marketLag = impliedProb - marketMid;
    const edge = impliedProb - ask - this.config.executionBuffer;

    if (marketLag < this.config.minMarketLag) {
      return fail('market_lag_too_small', { marketLag, impliedProb, marketMid });
    }
    if (edge < this.config.minEdge) {
      return fail('edge_too_small', { edge, impliedProb, ask });
    }

    const signal = {
      side: direction,
      ask,
      askSize: askBook.askSize,
      spread: askBook.spread,
      impliedProb,
      edge,
      marketMid,
      marketLag,
      chainlinkDeltaBps,
      binanceDeltaBps,
      binancePulseBps,
      leadGapBps,
    };

    this.replay.record('signal', {
      conditionId: market.conditionId,
      slug: market.slug,
      coin: market.coin,
      duration: market.duration,
      side: signal.side,
      ask: signal.ask,
      askSize: signal.askSize,
      spread: signal.spread,
      impliedProb: signal.impliedProb,
      edge: signal.edge,
      marketMid: signal.marketMid,
      marketLag: signal.marketLag,
      chainlinkDeltaBps: signal.chainlinkDeltaBps,
      binanceDeltaBps: signal.binanceDeltaBps,
      binancePulseBps: signal.binancePulseBps,
      leadGapBps: signal.leadGapBps,
      baseline,
      timeRemainingSec,
    });

    return signal;
  }

  private async openPosition(market: TrackedMarket, signal: SignalCandidate): Promise<void> {
    if (this.state.hasOpenPosition(market.conditionId)) return;

    const tokenId = signal.side === 'UP' ? market.upTokenId : market.downTokenId;
    const shares = this.config.budget / signal.ask;

    if (this.config.mode === 'paper' && this.state.getPaperBalance() < this.config.budget) {
      this.log.warn(`[SKIP] Paper balance too low for ${market.slug}`);
      return;
    }

    this.log.trade(
      `[ENTRY] ${signal.side} ${market.slug} ask=${signal.ask.toFixed(3)} ` +
      `edge=${signal.edge.toFixed(3)} lag=${signal.marketLag.toFixed(3)} ` +
      `binance=${signal.binanceDeltaBps.toFixed(1)}bps pulse=${signal.binancePulseBps.toFixed(1)}bps ` +
      `chain=${signal.chainlinkDeltaBps.toFixed(1)}bps gap=${signal.leadGapBps.toFixed(1)}bps`,
    );
    this.coinCooldownUntil.set(market.coin, Date.now() + this.config.coinCooldownSec * 1000);

    if (this.config.mode === 'dry-run') {
      this.replay.record('entry_dry_run', {
        conditionId: market.conditionId,
        slug: market.slug,
        side: signal.side,
        ask: signal.ask,
        impliedProb: signal.impliedProb,
        edge: signal.edge,
        marketLag: signal.marketLag,
        binanceDeltaBps: signal.binanceDeltaBps,
        chainlinkDeltaBps: signal.chainlinkDeltaBps,
        binancePulseBps: signal.binancePulseBps,
        leadGapBps: signal.leadGapBps,
      });
      return;
    }

    if (this.config.mode === 'live') {
      const result = await this.live!.createMarketBuy(tokenId, this.config.budget);
      if (!result.success) {
        this.log.warn(`[LIVE FAIL] ${market.slug} ${signal.side} ${result.errorMsg || 'unknown error'}`);
        this.replay.record('entry_failed', {
          mode: this.config.mode,
          conditionId: market.conditionId,
          slug: market.slug,
          side: signal.side,
          error: result.errorMsg || 'unknown error',
        });
        return;
      }

      this.replay.record('entry_live', {
        conditionId: market.conditionId,
        slug: market.slug,
        side: signal.side,
        ask: signal.ask,
        stake: this.config.budget,
        shares,
        edge: signal.edge,
        marketLag: signal.marketLag,
        orderId: result.orderId,
        transactionHashes: result.transactionHashes,
      });
    } else {
      this.state.setPaperBalance(this.state.getPaperBalance() - this.config.budget);
      this.replay.record('entry_paper', {
        conditionId: market.conditionId,
        slug: market.slug,
        side: signal.side,
        ask: signal.ask,
        stake: this.config.budget,
        shares,
        edge: signal.edge,
        marketLag: signal.marketLag,
        paperBalance: this.state.getPaperBalance(),
      });
    }

    const position: OpenPosition = {
      id: randomUUID(),
      conditionId: market.conditionId,
      slug: market.slug,
      question: market.question,
      coin: market.coin,
      duration: market.duration,
      side: signal.side,
      tokenId,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      baseline: market.baseline!,
      stake: this.config.budget,
      entryPrice: signal.ask,
      shares,
      openedAt: Date.now(),
      endTime: market.endTime,
      mode: this.config.mode,
    };

    this.state.addPosition(position);
  }

  private async settlePositions(): Promise<void> {
    const now = Date.now();
    for (const position of this.state.getOpenPositions()) {
      if (now < position.endTime + this.config.settleDelaySec * 1000) continue;

      const market = await fetchClobMarket(position.conditionId).catch(() => null);
      if (!market || !market.closed) continue;

      const winner = market.tokens.find((token) => token.winner === true);
      if (!winner) continue;

      let payout = 0;
      if (winner.tokenId === position.tokenId) {
        if (this.config.mode === 'live') {
          try {
            const result = await this.live!.redeemByTokenIds(
              position.conditionId,
              {
                yesTokenId: position.upTokenId,
                noTokenId: position.downTokenId,
              },
              winner.tokenId,
            );
            payout = parseFloat(result.usdcReceived);
          } catch (error) {
            this.log.warn(`[REDEEM RETRY] ${position.slug} ${String(error).slice(0, 120)}`);
            continue;
          }
        } else {
          payout = position.shares;
          this.state.setPaperBalance(this.state.getPaperBalance() + payout);
        }
      }

      const realizedPnl = payout - position.stake;
      this.state.settlePosition(position.id, payout, realizedPnl);
      this.log.trade(
        `[SETTLED] ${position.slug} ${position.side} payout=$${payout.toFixed(2)} pnl=$${realizedPnl.toFixed(2)}`,
      );
      this.replay.record('settled', {
        id: position.id,
        mode: this.config.mode,
        conditionId: position.conditionId,
        slug: position.slug,
        side: position.side,
        payout,
        realizedPnl,
        stake: position.stake,
        shares: position.shares,
        paperBalance: this.state.getPaperBalance(),
      });
    }
  }

  private getBinancePulseBps(coin: Coin): number {
    const history = this.binanceHistory.get(coin);
    const latest = this.binance.get(coin);
    if (!history || history.length === 0 || !latest) return 0;

    const targetTs = latest.timestamp - this.config.binanceLookbackMs;
    let reference = history[0];
    for (const tick of history) {
      if (tick.timestamp <= targetTs) {
        reference = tick;
      } else {
        break;
      }
    }

    if (reference.price <= 0) return 0;
    return ((latest.price - reference.price) / reference.price) * 10_000;
  }

  private printStatus(): void {
    const state = this.state.getState();
    const openPositions = state.positions.filter((position) => !position.settledAt);
    const settled = state.positions.filter((position) => position.settledAt);
    const realized = settled.reduce((sum, position) => sum + (position.realizedPnl || 0), 0);
    const topRejects = [...this.rejectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ');
    this.log.status(
      `Mode=${this.config.mode} | Markets=${this.markets.size} | ` +
      `Open=${openPositions.length} | Settled=${settled.length} | ` +
      `Paper=$${this.state.getPaperBalance().toFixed(2)} | Realized=$${realized.toFixed(2)} | ` +
      `Rejects=${topRejects || 'none'}`,
    );

    for (const position of openPositions.slice(-5)) {
      this.log.info(
        `[OPEN] ${position.side} ${position.slug} stake=$${position.stake.toFixed(2)} ` +
        `entry=${position.entryPrice.toFixed(3)} shares=${position.shares.toFixed(2)}`,
      );
    }
  }

  private cleanMarkets(): void {
    const now = Date.now();
    for (const [conditionId, market] of this.markets) {
      if (now <= market.endTime + 5 * 60_000) continue;
      if (this.state.hasOpenPosition(conditionId)) continue;
      this.markets.delete(conditionId);
      this.subscribedMarkets.delete(conditionId);
    }
  }

  private shutdown(): void {
    this.log.info('Shutting down...');
    const state = this.state.getState();
    const openPositions = state.positions.filter((position) => !position.settledAt);
    const settled = state.positions.filter((position) => position.settledAt);
    const realized = settled.reduce((sum, position) => sum + (position.realizedPnl || 0), 0);
    this.replay.record('run_end', {
      openPositions: openPositions.length,
      settledPositions: settled.length,
      realized,
      paperBalance: this.state.getPaperBalance(),
    });
    this.realtime.disconnect();
    process.exit(0);
  }
}

function generateCandidateSlugs(coins: Coin[], durations: Duration[]): string[] {
  const now = Date.now();
  const slugs: string[] = [];
  for (const coin of coins) {
    for (const duration of durations) {
      const ms = duration === '5m' ? 5 * 60_000 : 15 * 60_000;
      const currentSlot = Math.floor(now / ms) * ms;
      const nextSlot = currentSlot + ms;
      const suffix = duration;
      slugs.push(`${coin.toLowerCase()}-updown-${suffix}-${Math.floor(currentSlot / 1000)}`);
      slugs.push(`${coin.toLowerCase()}-updown-${suffix}-${Math.floor(nextSlot / 1000)}`);
    }
  }
  return [...new Set(slugs)];
}

function isShortTermCrypto(market: GammaMarket): boolean {
  return /up or down/i.test(market.question) && /(btc|eth|sol|xrp)-updown-(5m|15m)-/i.test(market.slug);
}

function buildTrackedMarket(gamma: GammaMarket, tokens: Array<{ tokenId: string; outcome: string }>): TrackedMarket {
  const parsed = parseShortTermSlug(gamma.slug);
  const up = tokens.find((token) => /up/i.test(token.outcome)) || tokens[0];
  const down = tokens.find((token) => /down/i.test(token.outcome)) || tokens[1];
  if (!parsed || !up || !down) {
    throw new Error(`Unable to parse short-term market ${gamma.slug}`);
  }

  return {
    conditionId: gamma.conditionId,
    slug: gamma.slug,
    question: gamma.question,
    coin: parsed.coin,
    duration: parsed.duration,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    upTokenId: up.tokenId,
    downTokenId: down.tokenId,
    minOrderSize: 5,
  };
}

function parseShortTermSlug(slug: string): { coin: Coin; duration: Duration; startTime: number; endTime: number } | null {
  const match = slug.match(/^(btc|eth|sol|xrp)-updown-(5m|15m)-(\d+)$/i);
  if (!match) return null;
  const coin = match[1].toUpperCase() as Coin;
  const duration = match[2] as Duration;
  const startTime = parseInt(match[3], 10) * 1000;
  const endTime = startTime + (duration === '5m' ? 5 * 60_000 : 15 * 60_000);
  return { coin, duration, startTime, endTime };
}

function chooseDirection(binanceDeltaBps: number, chainlinkDeltaBps: number, config: Config): Side | null {
  if (Math.abs(binanceDeltaBps) < config.binanceTriggerBps) return null;

  const binanceSign = Math.sign(binanceDeltaBps);
  const chainSign = Math.sign(chainlinkDeltaBps);

  if (chainSign !== 0 && chainSign !== binanceSign && Math.abs(chainlinkDeltaBps) >= config.chainlinkOpposeBps) {
    return null;
  }

  if (binanceSign > 0) return 'UP';
  if (binanceSign < 0) return 'DOWN';
  return null;
}

function toBps(price: number, baseline: number): number {
  return ((price - baseline) / baseline) * 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toCoinFromBinance(symbol: string): Coin | null {
  const upper = symbol.toUpperCase();
  if (upper === 'BTCUSDT') return 'BTC';
  if (upper === 'ETHUSDT') return 'ETH';
  if (upper === 'SOLUSDT') return 'SOL';
  if (upper === 'XRPUSDT') return 'XRP';
  return null;
}

function toCoinFromChainlink(symbol: string): Coin | null {
  const upper = symbol.toUpperCase();
  if (upper === 'BTC/USD') return 'BTC';
  if (upper === 'ETH/USD') return 'ETH';
  if (upper === 'SOL/USD') return 'SOL';
  if (upper === 'XRP/USD') return 'XRP';
  return null;
}

const config = loadConfig();
const bot = new LeadLagBot(config);

bot.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
