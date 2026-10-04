// Name-based match suggestions between Liquid Budget and ProjectionLab accounts.
// Suggestions are only hints; nothing syncs until the user confirms a match.

const STOP = new Set(['account', 'acct', 'the', 'my', 'a', 'of', 'and', '&']);

export function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(name) {
  return normalize(name).split(' ').filter((t) => t && !STOP.has(t));
}

function bigrams(s) {
  const out = [];
  const x = s.replace(/ /g, '');
  for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return a && a === b ? 1 : 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) {
    const c = counts.get(g);
    if (c) { hit++; counts.set(g, c - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

function tokenOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

// Which ProjectionLab kinds fit each Liquid Budget account type.
const TYPE_FIT = {
  CASH: ['savings'],
  CHECKING: ['savings'],
  SAVINGS: ['savings'],
  CREDIT_CARD: ['debt'],
  OFF_BUDGET_LIABILITY: ['debt'],
  OFF_BUDGET_ASSET: ['investment', 'asset'],
  OFF_BUDGET: ['investment', 'asset', 'savings'],
};

export function score(lbAccount, plAccount) {
  const a = normalize(lbAccount.name);
  const b = normalize(plAccount.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let s = Math.max(dice(a, b), tokenOverlap(a, b) * 0.9);
  const fit = TYPE_FIT[lbAccount.type];
  if (fit && fit.includes(plAccount.kind)) s += 0.1;
  else if (fit) s -= 0.15;
  return Math.max(0, Math.min(1, s));
}

/**
 * Suggest a ProjectionLab account for every Liquid Budget account that has no
 * saved match. Greedy best-first so one PL account isn't suggested twice and
 * PL accounts already used by saved matches are skipped.
 * Returns { [lbAccountId]: { plId, score } }
 */
export function suggestMatches(lbAccounts, plAccounts, saved = {}, threshold = 0.5) {
  const plIds = new Set(plAccounts.map((p) => p.id));
  const taken = new Set(Object.values(saved).filter((v) => plIds.has(v)));
  const pending = lbAccounts.filter((a) => !saved[a.id] || (saved[a.id] !== '__skip' && !plIds.has(saved[a.id])));

  const pairs = [];
  for (const lb of pending) {
    for (const pl of plAccounts) {
      if (taken.has(pl.id)) continue;
      const s = score(lb, pl);
      if (s >= threshold) pairs.push({ lb: lb.id, pl: pl.id, s });
    }
  }
  pairs.sort((x, y) => y.s - x.s);

  const out = {};
  const usedPL = new Set();
  for (const p of pairs) {
    if (out[p.lb] || usedPL.has(p.pl)) continue;
    out[p.lb] = { plId: p.pl, score: Math.round(p.s * 100) / 100 };
    usedPL.add(p.pl);
  }
  return out;
}
