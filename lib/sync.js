// Turns Liquid Budget balances + confirmed matches into ProjectionLab updates.

/**
 * Scale-4 integer → whole dollars. ProjectionLab doesn't use cents, so balances
 * are rounded to the nearest dollar, with .50 rounding away from zero
 * ($12.50 → $13, -$12.50 → -$13).
 */
export function toWholeDollars(scale4) {
  const v = scale4 || 0;
  const whole = Math.round(Math.abs(v) / 10000);
  return v < 0 ? -whole + 0 : whole; // + 0 normalises -0
}

/**
 * Liquid Budget stores liabilities as negative balances (money owed).
 * ProjectionLab debts hold the amount owed as a positive balance, so the sign
 * is flipped when the target is a PL debt.
 */
export function valueForPL(scale4Balance, plKind) {
  const dollars = toWholeDollars(scale4Balance);
  return plKind === 'debt' ? -dollars + 0 : dollars;
}

/**
 * Build the sync plan.
 * @returns rows: [{ lb, pl, newValue, currentValue, changed }]
 *          plus `problems` for matches that point at missing PL accounts.
 */
export function buildPlan({ lbAccounts, balances, plAccounts, matches, includePending }) {
  const plById = new Map(plAccounts.map((p) => [p.id, p]));
  const sums = (includePending ? balances.all : balances.cleared) || {};
  const rows = [];
  const problems = [];
  const usedBy = new Map();

  for (const lb of lbAccounts) {
    const target = matches[lb.id];
    if (!target || target === '__skip') continue;
    const pl = plById.get(target);
    if (!pl) {
      problems.push({ lb, reason: 'The matched ProjectionLab account no longer exists. Re-match it in setup.' });
      continue;
    }
    if (usedBy.has(pl.id)) {
      problems.push({ lb, reason: `"${pl.name}" is already fed by "${usedBy.get(pl.id).name}". Each ProjectionLab account can only be matched once, so this one was skipped.` });
      continue;
    }
    usedBy.set(pl.id, lb);
    const newValue = valueForPL(sums[lb.id] || 0, pl.kind);
    const currentValue = typeof pl.value === 'number' ? pl.value : null;
    rows.push({ lb, pl, newValue, currentValue, changed: currentValue === null || newValue !== currentValue });
  }

  return { rows, problems };
}

export function formatMoney(n, currency = 'USD', { whole = false } = {}) {
  if (n === null || n === undefined) return '—';
  const opts = { style: 'currency', currency: currency === 'NONE' ? 'USD' : currency };
  if (whole) Object.assign(opts, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  try {
    return new Intl.NumberFormat(undefined, opts).format(n);
  } catch {
    return whole ? String(Math.round(n)) : n.toFixed(2);
  }
}
