import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotMode, Coin, Duration } from './types.js';

export interface Config {
  mode: BotMode;
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  budget: number;
  paperBalance: number;
  dataDir: string;
  replayDir: string;
  replayEnabled: boolean;
  replayTickMinMs: number;
  scanSec: number;
  evalMs: number;
  statusSec: number;
  settleSec: number;
  closeWindowSec: number;
  settleDelaySec: number;
  baselineCaptureGraceSec: number;
  maxOpenPositions: number;
  coinCooldownSec: number;
  maxExternalAgeMs: number;
  maxBookAgeMs: number;
  binanceLookbackMs: number;
  binanceTriggerBps: number;
  minBinancePulseBps: number;
  minLeadGapBps: number;
  chainlinkConfirmBps: number;
  chainlinkOpposeBps: number;
  fairScaleBps: number;
  minEdge: number;
  minMarketLag: number;
  executionBuffer: number;
  maxAsk: number;
  maxSpread: number;
  minTopBookValue: number;
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
    budget: parseFloat(get('budget', 'BUDGET', '5')),
    paperBalance: parseFloat(get('paper-balance', 'PAPER_BALANCE', '100')),
    dataDir: get('data-dir', 'DATA_DIR', '.leadlag-state'),
    replayDir: get('replay-dir', 'REPLAY_DIR', 'replay'),
    replayEnabled: get('replay-enabled', 'REPLAY_ENABLED', 'true') === 'true',
    replayTickMinMs: parseFloat(get('replay-tick-min-ms', 'REPLAY_TICK_MIN_MS', '250')),
    scanSec: parseFloat(get('scan-sec', 'SCAN_SEC', '20')),
    evalMs: parseFloat(get('eval-ms', 'EVAL_MS', '500')),
    statusSec: parseFloat(get('status-sec', 'STATUS_SEC', '30')),
    settleSec: parseFloat(get('settle-sec', 'SETTLE_SEC', '10')),
    closeWindowSec: parseFloat(get('close-window-sec', 'CLOSE_WINDOW_SEC', '20')),
    settleDelaySec: parseFloat(get('settle-delay-sec', 'SETTLE_DELAY_SEC', '8')),
    baselineCaptureGraceSec: parseFloat(get('baseline-grace-sec', 'BASELINE_GRACE_SEC', '20')),
    maxOpenPositions: parseFloat(get('max-open-positions', 'MAX_OPEN_POSITIONS', '3')),
    coinCooldownSec: parseFloat(get('coin-cooldown-sec', 'COIN_COOLDOWN_SEC', '45')),
    maxExternalAgeMs: parseFloat(get('max-external-age-ms', 'MAX_EXTERNAL_AGE_MS', '1500')),
    maxBookAgeMs: parseFloat(get('max-book-age-ms', 'MAX_BOOK_AGE_MS', '1500')),
    binanceLookbackMs: parseFloat(get('binance-lookback-ms', 'BINANCE_LOOKBACK_MS', '3000')),
    binanceTriggerBps: parseFloat(get('binance-trigger-bps', 'BINANCE_TRIGGER_BPS', '6')),
    minBinancePulseBps: parseFloat(get('min-binance-pulse-bps', 'MIN_BINANCE_PULSE_BPS', '3')),
    minLeadGapBps: parseFloat(get('min-lead-gap-bps', 'MIN_LEAD_GAP_BPS', '2')),
    chainlinkConfirmBps: parseFloat(get('chainlink-confirm-bps', 'CHAINLINK_CONFIRM_BPS', '1')),
    chainlinkOpposeBps: parseFloat(get('chainlink-oppose-bps', 'CHAINLINK_OPPOSE_BPS', '2')),
    fairScaleBps: parseFloat(get('fair-scale-bps', 'FAIR_SCALE_BPS', '18')),
    minEdge: parseFloat(get('min-edge', 'MIN_EDGE', '0.06')),
    minMarketLag: parseFloat(get('min-market-lag', 'MIN_MARKET_LAG', '0.03')),
    executionBuffer: parseFloat(get('execution-buffer', 'EXECUTION_BUFFER', '0.03')),
    maxAsk: parseFloat(get('max-ask', 'MAX_ASK', '0.82')),
    maxSpread: parseFloat(get('max-spread', 'MAX_SPREAD', '0.08')),
    minTopBookValue: parseFloat(get('min-top-book-value', 'MIN_TOP_BOOK_VALUE', '20')),
    coins: parseCoins(get('coins', 'COINS', 'BTC,ETH,SOL,XRP')),
    durations: parseDurations(get('durations', 'DURATIONS', '5m,15m')),
  };
}

function parseCoins(value: string): Coin[] {
  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is Coin => ['BTC', 'ETH', 'SOL', 'XRP'].includes(item));
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
