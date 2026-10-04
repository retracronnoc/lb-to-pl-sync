// Shared load / sync flow used by both the popup and the setup page.

import { getSettings, getMatches, getLocal, setLocal } from './storage.js';
import { listActiveAccounts, getBalances, listBudgets } from './liquidbudget.js';
import { listPLAccounts, updatePLAccounts } from './projectionlab.js';
import { buildPlan } from './sync.js';

export async function loadEverything() {
  const settings = await getSettings();
  if (!settings.lbToken) throw new Error('Add your Liquid Budget token in setup first.');
  if (!settings.plKey) throw new Error('Add your ProjectionLab plugin API key in setup first.');
  if (!settings.budgetId) throw new Error('Choose a Liquid Budget budget in setup first.');

  const [budgets, lbAccounts, balances] = await Promise.all([
    listBudgets(settings.lbToken),
    listActiveAccounts(settings.lbToken, settings.budgetId),
    getBalances(settings.lbToken, settings.budgetId),
  ]);
  const plAccounts = await listPLAccounts(settings.plKey);
  const matches = await getMatches(settings.budgetId);
  const budget = budgets.find((b) => b.id === settings.budgetId);
  if (!budget) throw new Error('The saved budget was not found in Liquid Budget. Choose a budget again in setup.');

  return { settings, budget, lbAccounts, balances, plAccounts, matches };
}

export async function preview() {
  const ctx = await loadEverything();
  const plan = buildPlan({ ...ctx, includePending: ctx.settings.includePending });
  return { ...ctx, plan };
}

/** Push changed rows to ProjectionLab. Returns a summary and records it. */
export async function applyPlan(plan, plKey) {
  const toSend = plan.rows.filter((r) => r.changed);
  let results = [];
  if (toSend.length) {
    results = await updatePLAccounts(
      plKey,
      toSend.map((r) => ({ id: r.pl.id, field: r.pl.field, value: r.newValue })),
    );
  }
  const failed = results.filter((r) => !r.ok);
  const summary = {
    time: Date.now(),
    updated: results.length - failed.length,
    unchanged: plan.rows.length - toSend.length,
    failed: failed.map((f) => {
      const row = toSend.find((r) => r.pl.id === f.id && r.pl.field === f.field);
      return { name: row ? row.pl.name : f.id, error: f.error };
    }),
    problems: plan.problems.length,
  };
  await setLocal('lastSync', summary);
  return summary;
}

export async function syncNow() {
  const { plan, settings } = await preview();
  return applyPlan(plan, settings.plKey);
}

export async function getLastSync() {
  return getLocal('lastSync');
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(ts).toLocaleString();
}
