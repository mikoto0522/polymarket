import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotMode, Coin, Duration, Side } from './types.js';

export interface SideStrategyProfile {
  binanceTriggerBps: number;
  minBinancePulseBps: number;
  minLeadGapBps: number;
  chainlinkOpposeBps: number;
  minEdge: number;
  minMarketLag: number;
  maxAsk: number;
}

export interface StrategyProfile {
  closeWindowSec: number;
  maxExternalAgeMs: number;
  maxBookAgeMs: number;
  chainlinkConfirmBps: number;
  fairScaleBps: number;
  executionBuffer: number;
  maxSpread: number;
  minTopBookValue: number;
  sides: Record<Side, SideStrategyProfile>;
}

export interface Config {
  mode: BotMode;
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  signatureType: number;
  funderAddress: string;
  budget: number;
  paperBalance: number;
  dataDir: string;
  replayDir: string;
  replayEnabled: boolean;
  replayTicksEnabled: boolean;
  replayTickMinMs: number;
  paperExecutionDelayMinMs: number;
  paperExecutionDelayMaxMs: number;
  scanSec: number;
  evalMs: number;
  statusSec: number;
  settleSec: number;
  settleDelaySec: number;
  baselineCaptureGraceSec: number;
  maxOpenPositions: number;
  maxOpenPositionsPerCoin: number;
  coinCooldownSec: number;
  binanceLookbackMs: number;
  strategyProfiles: Record<Duration, StrategyProfile>;
  coins: Coin[];
  durations: Duration[];
}

export function loadConfig(): Config {
  loadEnvFile();

  const args = process.argv.slice(2);
  const get = (key: string, envKey: string, fallback: string): string => {
    const cli = args.find((item: string) => item.startsWith(`--${key}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[envKey] || fallback;
  };
  const getScoped = (key: string, envKey: string, duration: Duration, fallback: string): string => {
    const suffix = duration === '5m' ? '5M' : '15M';
    const scopedKey = `${key}-${duration}`;
    const scopedEnv = `${envKey}_${suffix}`;
    const cli = args.find((item: string) => item.startsWith(`--${scopedKey}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[scopedEnv] || process.env[envKey] || fallback;
  };
  const getSideScoped = (key: string, envKey: string, duration: Duration, side: Side, fallback: string): string => {
    const durationSuffix = duration === '5m' ? '5M' : '15M';
    const sideSuffix = side;
    const scopedKey = `${key}-${duration}-${side.toLowerCase()}`;
    const scopedEnv = `${envKey}_${durationSuffix}_${sideSuffix}`;
    const cli = args.find((item: string) => item.startsWith(`--${scopedKey}=`));
    if (cli) return cli.split('=').slice(1).join('=');
    return process.env[scopedEnv] || process.env[`${envKey}_${sideSuffix}`] || process.env[envKey] || fallback;
  };

  const mode: BotMode = args.includes('--paper')
    ? 'paper'
    : args.includes('--live')
      ? 'live'
      : 'dry-run';

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY || '';
  if (mode === 'live' && !privateKey) {
    throw new Error('POLYMARKET_PRIVATE_KEY is required for live mode');
  }

  return {
    mode,
    privateKey,
    rpcUrl: get('rpc-url', 'POLYGON_RPC_URL', 'https://polygon-rpc.com'),
    chainId: parseFloat(get('chain-id', 'CHAIN_ID', '137')),
    signatureType: parseFloat(get('signature-type', 'POLYMARKET_SIGNATURE_TYPE', '0')),
    funderAddress: get('funder-address', 'POLYMARKET_FUNDER_ADDRESS', ''),
    budget: parseFloat(get('budget', 'BUDGET', '5')),
    paperBalance: parseFloat(get('paper-balance', 'PAPER_BALANCE', '100')),
    dataDir: get('data-dir', 'DATA_DIR', '.leadlag-state'),
    replayDir: get('replay-dir', 'REPLAY_DIR', 'replay'),
    replayEnabled: get('replay-enabled', 'REPLAY_ENABLED', 'true') === 'true',
    replayTicksEnabled: get('replay-ticks-enabled', 'REPLAY_TICKS_ENABLED', mode === 'live' ? 'false' : 'true') === 'true',
    replayTickMinMs: parseFloat(get('replay-tick-min-ms', 'REPLAY_TICK_MIN_MS', '250')),
    paperExecutionDelayMinMs: parseFloat(get('paper-execution-delay-min-ms', 'PAPER_EXECUTION_DELAY_MIN_MS', '100')),
    paperExecutionDelayMaxMs: parseFloat(get('paper-execution-delay-max-ms', 'PAPER_EXECUTION_DELAY_MAX_MS', '300')),
    scanSec: parseFloat(get('scan-sec', 'SCAN_SEC', '20')),
    evalMs: parseFloat(get('eval-ms', 'EVAL_MS', '500')),
    statusSec: parseFloat(get('status-sec', 'STATUS_SEC', '30')),
    settleSec: parseFloat(get('settle-sec', 'SETTLE_SEC', '10')),
    settleDelaySec: parseFloat(get('settle-delay-sec', 'SETTLE_DELAY_SEC', '8')),
    baselineCaptureGraceSec: parseFloat(get('baseline-grace-sec', 'BASELINE_GRACE_SEC', '20')),
    maxOpenPositions: parseFloat(get('max-open-positions', 'MAX_OPEN_POSITIONS', '24')),
    maxOpenPositionsPerCoin: parseFloat(get('max-open-positions-per-coin', 'MAX_OPEN_POSITIONS_PER_COIN', '6')),
    coinCooldownSec: parseFloat(get('coin-cooldown-sec', 'COIN_COOLDOWN_SEC', '3')),
    binanceLookbackMs: parseFloat(get('binance-lookback-ms', 'BINANCE_LOOKBACK_MS', '5000')),
    strategyProfiles: {
      '5m': loadStrategyProfile('5m', getScoped, getSideScoped, {
        closeWindowSec: 60,
        maxExternalAgeMs: 3500,
        maxBookAgeMs: 5000,
        chainlinkConfirmBps: 1,
        fairScaleBps: 12,
        executionBuffer: 0.01,
        maxSpread: 0.22,
        minTopBookValue: 2,
        sides: {
          UP: {
            binanceTriggerBps: 1.4,
            minBinancePulseBps: 0.3,
            minLeadGapBps: 0.18,
            chainlinkOpposeBps: 2.6,
            minEdge: 0.01,
            minMarketLag: 0.004,
            maxAsk: 0.97,
          },
          DOWN: {
            binanceTriggerBps: 1.9,
            minBinancePulseBps: 0.5,
            minLeadGapBps: 0.3,
            chainlinkOpposeBps: 1.9,
            minEdge: 0.015,
            minMarketLag: 0.006,
            maxAsk: 0.88,
          },
        },
      }),
      '15m': loadStrategyProfile('15m', getScoped, getSideScoped, {
        closeWindowSec: 75,
        maxExternalAgeMs: 3000,
        maxBookAgeMs: 4500,
        chainlinkConfirmBps: 1,
        fairScaleBps: 12,
        executionBuffer: 0.015,
        maxSpread: 0.14,
        minTopBookValue: 4,
        sides: {
          UP: {
            binanceTriggerBps: 2.6,
            minBinancePulseBps: 0.6,
            minLeadGapBps: 0.4,
            chainlinkOpposeBps: 1.9,
            minEdge: 0.02,
            minMarketLag: 0.008,
            maxAsk: 0.82,
          },
          DOWN: {
            binanceTriggerBps: 3.4,
            minBinancePulseBps: 0.9,
            minLeadGapBps: 0.6,
            chainlinkOpposeBps: 1.5,
            minEdge: 0.028,
            minMarketLag: 0.011,
            maxAsk: 0.72,
          },
        },
      }),
    },
    coins: parseCoins(get('coins', 'COINS', 'BTC,ETH')),
    durations: parseDurations(get('durations', 'DURATIONS', '5m')),
  };
}

function loadStrategyProfile(
  duration: Duration,
  getScoped: (key: string, envKey: string, duration: Duration, fallback: string) => string,
  getSideScoped: (key: string, envKey: string, duration: Duration, side: Side, fallback: string) => string,
  defaults: StrategyProfile,
): StrategyProfile {
  const loadSide = (side: Side): SideStrategyProfile => ({
    binanceTriggerBps: parseFloat(getSideScoped('binance-trigger-bps', 'BINANCE_TRIGGER_BPS', duration, side, String(defaults.sides[side].binanceTriggerBps))),
    minBinancePulseBps: parseFloat(getSideScoped('min-binance-pulse-bps', 'MIN_BINANCE_PULSE_BPS', duration, side, String(defaults.sides[side].minBinancePulseBps))),
    minLeadGapBps: parseFloat(getSideScoped('min-lead-gap-bps', 'MIN_LEAD_GAP_BPS', duration, side, String(defaults.sides[side].minLeadGapBps))),
    chainlinkOpposeBps: parseFloat(getSideScoped('chainlink-oppose-bps', 'CHAINLINK_OPPOSE_BPS', duration, side, String(defaults.sides[side].chainlinkOpposeBps))),
    minEdge: parseFloat(getSideScoped('min-edge', 'MIN_EDGE', duration, side, String(defaults.sides[side].minEdge))),
    minMarketLag: parseFloat(getSideScoped('min-market-lag', 'MIN_MARKET_LAG', duration, side, String(defaults.sides[side].minMarketLag))),
    maxAsk: parseFloat(getSideScoped('max-ask', 'MAX_ASK', duration, side, String(defaults.sides[side].maxAsk))),
  });

  return {
    closeWindowSec: parseFloat(getScoped('close-window-sec', 'CLOSE_WINDOW_SEC', duration, String(defaults.closeWindowSec))),
    maxExternalAgeMs: parseFloat(getScoped('max-external-age-ms', 'MAX_EXTERNAL_AGE_MS', duration, String(defaults.maxExternalAgeMs))),
    maxBookAgeMs: parseFloat(getScoped('max-book-age-ms', 'MAX_BOOK_AGE_MS', duration, String(defaults.maxBookAgeMs))),
    chainlinkConfirmBps: parseFloat(getScoped('chainlink-confirm-bps', 'CHAINLINK_CONFIRM_BPS', duration, String(defaults.chainlinkConfirmBps))),
    fairScaleBps: parseFloat(getScoped('fair-scale-bps', 'FAIR_SCALE_BPS', duration, String(defaults.fairScaleBps))),
    executionBuffer: parseFloat(getScoped('execution-buffer', 'EXECUTION_BUFFER', duration, String(defaults.executionBuffer))),
    maxSpread: parseFloat(getScoped('max-spread', 'MAX_SPREAD', duration, String(defaults.maxSpread))),
    minTopBookValue: parseFloat(getScoped('min-top-book-value', 'MIN_TOP_BOOK_VALUE', duration, String(defaults.minTopBookValue))),
    sides: {
      UP: loadSide('UP'),
      DOWN: loadSide('DOWN'),
    },
  };
}

function parseCoins(value: string): Coin[] {
  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is Coin => ['BTC', 'ETH'].includes(item));
}

function parseDurations(value: string): Duration[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is Duration => item === '5m' || item === '15m');
}

function loadEnvFile(): void {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Ignore missing local env file.
  }
}
