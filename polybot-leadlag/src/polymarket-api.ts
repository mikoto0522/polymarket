import type {
  ClobMarket,
  ClobToken,
  GammaMarket,
} from './types.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

export async function fetchGammaMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const query = new URLSearchParams({
    slug,
    limit: '1',
  });
  const data = await fetchJson<unknown[]>(`${GAMMA_API_BASE}/markets?${query}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  return normalizeGammaMarket(data[0]);
}

export async function fetchClobMarket(conditionId: string): Promise<ClobMarket | null> {
  const data = await fetchJson<Record<string, unknown>>(`${CLOB_API_BASE}/markets/${conditionId}`);
  if (!data || typeof data !== 'object') return null;
  return normalizeClobMarket(data);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  }).catch(() => null);

  if (!response || response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json() as Promise<T>;
}

function normalizeGammaMarket(input: unknown): GammaMarket {
  const item = toRecord(input);
  return {
    id: toStringValue(item.id),
    conditionId: toStringValue(item.conditionId),
    slug: toStringValue(item.slug),
    question: toStringValue(item.question),
    active: Boolean(item.active),
    closed: Boolean(item.closed),
  };
}

function normalizeClobMarket(input: Record<string, unknown>): ClobMarket {
  return {
    conditionId: toStringValue(input.condition_id),
    marketSlug: toStringValue(input.market_slug),
    question: toStringValue(input.question),
    active: Boolean(input.active),
    closed: Boolean(input.closed),
    acceptingOrders: Boolean(input.accepting_orders),
    endDateIso: input.end_date_iso == null ? null : toStringValue(input.end_date_iso),
    minimumOrderSize: toNumberValue(input.minimum_order_size),
    tokens: Array.isArray(input.tokens)
      ? input.tokens.map((token) => normalizeClobToken(toRecord(token)))
      : [],
  };
}

function normalizeClobToken(input: Record<string, unknown>): ClobToken {
  return {
    tokenId: toStringValue(input.token_id),
    outcome: toStringValue(input.outcome),
    price: toNumberValue(input.price),
    winner: input.winner === true,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function toNumberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
