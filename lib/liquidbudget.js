// Liquid Budget Developer API client.
// Docs: https://www.liquidbudget.com/dashboard/developer/documentation
//
// Notes from the API docs that shape this file:
// - Bearer token on every request; 100 requests/hour per token.
// - List endpoints return an ETag; sending it back as If-None-Match returns
//   304 (no body) and does NOT count toward the rate limit. We cache the last
//   result per endpoint so a 304 can be served from storage.
// - Account objects have no balance field, so balances are computed by summing
//   transaction amounts per account (one request for the whole budget).
// - Money is a signed integer at scale 4 (123400 = $12.34).

import { getLocal, setLocal } from './storage.js';

const BASE = 'https://www.liquidbudget.com/developer';
const CACHE_KEY = 'lbCache2'; // v2: stores dated transactions, not pre-summed balances

export class LBError extends Error {
  constructor(message, status = 0, retryAfter = null) {
    super(message);
    this.name = 'LBError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function lbFetch(token, path, etag) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;

  let res;
  try {
    res = await fetch(BASE + path, { headers, cache: 'no-store' });
  } catch {
    throw new LBError('Could not reach Liquid Budget. Check your internet connection.');
  }

  if (res.status === 304) return { notModified: true, etag };
  if (res.status === 401) throw new LBError('Liquid Budget rejected the token. It may be mistyped or revoked.', 401);
  if (res.status === 403) throw new LBError('This Liquid Budget token does not have access to that resource.', 403);
  if (res.status === 404) throw new LBError('Liquid Budget could not find that budget. Pick it again in setup.', 404);
  if (res.status === 429) {
    const secs = parseInt(res.headers.get('Retry-After') || '0', 10) || null;
    const wait = secs ? ` Try again in about ${Math.ceil(secs / 60)} minute(s).` : '';
    throw new LBError(`Liquid Budget rate limit reached (100 requests/hour).${wait}`, 429, secs);
  }
  if (!res.ok) throw new LBError(`Liquid Budget returned an error (HTTP ${res.status}).`, res.status);

  return { data: await res.json(), etag: res.headers.get('ETag') };
}

// Fetch a list endpoint using the ETag cache. `transform` turns the raw body
// into what we store (lets us keep summed balances instead of every transaction).
async function cachedGet(token, path, transform = (x) => x) {
  const cache = (await getLocal(CACHE_KEY)) || {};
  const entry = cache[path];
  const res = await lbFetch(token, path, entry?.etag);
  if (res.notModified && entry) return entry.value;
  if (res.notModified) {
    // 304 without a cached body (shouldn't happen) — refetch without ETag.
    const fresh = await lbFetch(token, path, null);
    return store(cache, path, fresh, transform);
  }
  return store(cache, path, res, transform);
}

async function store(cache, path, res, transform) {
  const value = transform(res.data);
  if (res.etag) {
    cache[path] = { etag: res.etag, value };
    await setLocal(CACHE_KEY, cache);
  }
  return value;
}

export async function clearLBCache() {
  await setLocal(CACHE_KEY, {});
}

/** Verify a token by listing budgets. Returns the budgets array. */
export async function listBudgets(token) {
  return cachedGet(token, '/budget');
}

/** All accounts in a budget, excluding archived ones. */
export async function listActiveAccounts(token, budgetId) {
  const all = await cachedGet(token, `/budget/${encodeURIComponent(budgetId)}/account`);
  return all.filter((a) => a.state !== 'ARCHIVED');
}

const pad = (n) => String(n).padStart(2, '0');

/** Today's calendar date in the browser's time zone, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Calendar date (YYYY-MM-DD) a transaction belongs to.
 * Liquid Budget sends dateEpoch in seconds. Dates stored as an exact UTC
 * midnight are read as that UTC date (otherwise tomorrow's 00:00 UTC would look
 * like "this evening" in US time zones). Any other timestamp is read in the
 * browser's local time zone.
 */
export function txDate(dateEpoch) {
  const d = new Date(dateEpoch * 1000);
  if (dateEpoch % 86400 === 0) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return localToday(d);
}

/**
 * Compact the transaction list for caching: [accountId, dateEpoch, amount, pending].
 * We keep dates (not pre-summed balances) so the "as of today" cutoff is
 * applied fresh on every sync, even when the API answers 304 Not Modified.
 */
function compactTransactions(transactions) {
  const out = [];
  for (const t of transactions || []) {
    if (!t || !t.accountId || typeof t.amount !== 'number') continue;
    out.push([t.accountId, typeof t.dateEpoch === 'number' ? t.dateEpoch : 0, t.amount, t.status === 'PENDING' ? 1 : 0]);
  }
  return out;
}

/**
 * Sum transactions per account, ignoring anything dated after `asOf`
 * (YYYY-MM-DD, default: today). Returns
 *   { all: {accountId: scale4Int}, cleared: {accountId: scale4Int}, asOf, futureSkipped }
 * where `cleared` also excludes PENDING transactions.
 */
export function sumTransactions(rows, asOf = localToday()) {
  const all = {};
  const cleared = {};
  let futureSkipped = 0;
  for (const [accountId, dateEpoch, amount, pending] of rows || []) {
    if (dateEpoch && txDate(dateEpoch) > asOf) { futureSkipped++; continue; }
    all[accountId] = (all[accountId] || 0) + amount;
    if (!pending) cleared[accountId] = (cleared[accountId] || 0) + amount;
  }
  return { all, cleared, asOf, futureSkipped };
}

/** Per-account balances as of today (future-dated transactions excluded). */
export async function getBalances(token, budgetId) {
  const rows = await cachedGet(token, `/budget/${encodeURIComponent(budgetId)}/transaction`, compactTransactions);
  return sumTransactions(Array.isArray(rows) ? rows : [], localToday());
}

/** Scale-4 integer → dollars rounded to cents. */
export function toDollars(scale4) {
  return Math.round((scale4 || 0) / 100) / 100 + 0; // + 0 normalises -0
}

export const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'OFF_BUDGET_LIABILITY']);

export const TYPE_LABELS = {
  CASH: 'Cash',
  CHECKING: 'Checking',
  SAVINGS: 'Savings',
  CREDIT_CARD: 'Credit card',
  OFF_BUDGET: 'Off-budget',
  OFF_BUDGET_ASSET: 'Asset (off-budget)',
  OFF_BUDGET_LIABILITY: 'Liability (off-budget)',
};
