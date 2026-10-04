import { getSettings, saveSettings, getMatches, saveMatch, saveMatches } from './lib/storage.js';
import { listBudgets, listActiveAccounts, getBalances, clearLBCache, toDollars, TYPE_LABELS } from './lib/liquidbudget.js';
import { validatePLKey, listPLAccounts, openPL, KIND_LABELS } from './lib/projectionlab.js';
import { suggestMatches } from './lib/match.js';
import { buildPlan, formatMoney } from './lib/sync.js';
import { applyPlan } from './lib/runner.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n[k] = v;
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid instanceof Node ? kid : String(kid));
  return n;
};

function status(id, kind, msg) {
  const n = $(id);
  n.className = `status ${kind || ''}`;
  n.textContent = msg || '';
}

// In-memory state for this page.
const state = {
  settings: null,
  budgets: [],
  lbAccounts: [],
  balances: null,
  plAccounts: [],
  matches: {},
  suggestions: {},
  plan: null,
};

function currency() {
  return state.budgets.find((b) => b.id === state.settings.budgetId)?.currency || 'USD';
}

// ---------- Step 1: connect ----------

async function init() {
  state.settings = await getSettings();
  $('lbToken').value = state.settings.lbToken;
  $('plKey').value = state.settings.plKey;
  $('includePending').checked = !!state.settings.includePending;

  if (state.settings.lbToken) await testLB(false);
}

async function testLB(save = true) {
  const token = $('lbToken').value.trim();
  if (!token) return status('lbStatus', 'err', 'Paste your Liquid Budget token first.');
  $('lbTest').disabled = true;
  status('lbStatus', 'info', 'Checking…');
  try {
    if (save && token !== state.settings.lbToken) {
      await clearLBCache();
      state.settings = await saveSettings({ lbToken: token });
    }
    state.budgets = await listBudgets(token);
    status('lbStatus', 'ok', `Connected. ${state.budgets.length} budget${state.budgets.length === 1 ? '' : 's'} found.`);
    fillBudgets();
  } catch (e) {
    status('lbStatus', 'err', e.message);
  } finally {
    $('lbTest').disabled = false;
  }
}

function fillBudgets() {
  const sel = $('budget');
  sel.replaceChildren();
  if (!state.budgets.length) {
    sel.append(el('option', { textContent: 'No budgets found' }));
    sel.disabled = true;
    return;
  }
  if (!state.budgets.some((b) => b.id === state.settings.budgetId)) {
    sel.append(el('option', { value: '', textContent: 'Choose a budget…' }));
  }
  for (const b of state.budgets) {
    sel.append(el('option', { value: b.id, textContent: `${b.name} (${b.currency})`, selected: b.id === state.settings.budgetId }));
  }
  sel.disabled = false;
  // Auto-pick the only budget.
  if (state.budgets.length === 1 && !state.settings.budgetId) {
    sel.value = state.budgets[0].id;
    onBudgetChange();
  }
}

async function onBudgetChange() {
  state.settings = await saveSettings({ budgetId: $('budget').value });
  resetAccounts();
}

async function testPL() {
  const key = $('plKey').value.trim();
  if (!key) return status('plStatus', 'err', 'Paste your ProjectionLab plugin API key first.');
  $('plTest').disabled = true;
  status('plStatus', 'info', 'Checking with your open ProjectionLab tab…');
  try {
    state.settings = await saveSettings({ plKey: key });
    await validatePLKey(key);
    const accts = await listPLAccounts(key);
    status('plStatus', 'ok', `Connected. ${accts.length} account${accts.length === 1 ? '' : 's'} found in Current Finances.`);
  } catch (e) {
    status('plStatus', 'err', e.message);
  } finally {
    $('plTest').disabled = false;
  }
}

// ---------- Step 2: match ----------

function resetAccounts() {
  state.lbAccounts = [];
  state.plAccounts = [];
  state.plan = null;
  $('matchTable').hidden = true;
  $('acceptAll').hidden = true;
  $('matchSummary').textContent = '';
  status('matchStatus', '', '');
  clearPreview();
}

async function loadAccounts() {
  const s = state.settings;
  if (!s.lbToken) return status('matchStatus', 'err', 'Connect Liquid Budget first.');
  if (!s.budgetId) return status('matchStatus', 'err', 'Choose a budget first.');
  if (!s.plKey) return status('matchStatus', 'err', 'Add your ProjectionLab key first.');

  $('loadAccounts').disabled = true;
  status('matchStatus', 'info', 'Loading accounts from both apps…');
  try {
    const [lbAccounts, balances] = await Promise.all([
      listActiveAccounts(s.lbToken, s.budgetId),
      getBalances(s.lbToken, s.budgetId),
    ]);
    const plAccounts = await listPLAccounts(s.plKey);
    Object.assign(state, { lbAccounts, balances, plAccounts });
    state.matches = await getMatches(s.budgetId);
    state.suggestions = suggestMatches(lbAccounts, plAccounts, state.matches);
    status('matchStatus', '', '');
    renderMatches();
    $('loadAccounts').textContent = 'Refresh accounts';
  } catch (e) {
    status('matchStatus', 'err', e.message);
  } finally {
    $('loadAccounts').disabled = false;
  }
}

function lbBalance(id) {
  const sums = state.settings.includePending ? state.balances?.all : state.balances?.cleared;
  return toDollars(sums?.[id] || 0);
}

function plSelect(lb) {
  const current = state.matches[lb.id] || '';
  const sel = el('select', { onchange: async (e) => {
    state.matches = await saveMatch(state.settings.budgetId, lb.id, e.target.value || null);
    state.suggestions = suggestMatches(state.lbAccounts, state.plAccounts, state.matches);
    renderMatches();
    clearPreview();
  } });
  sel.append(el('option', { value: '', textContent: '— Not matched —' }));
  sel.append(el('option', { value: '__skip', textContent: "Don't sync this account", selected: current === '__skip' }));

  const usedElsewhere = new Set(Object.entries(state.matches).filter(([k, v]) => k !== lb.id && v !== '__skip').map(([, v]) => v));
  for (const kind of ['savings', 'investment', 'asset', 'assetLoan', 'debt']) {
    const group = state.plAccounts.filter((p) => p.kind === kind);
    if (!group.length) continue;
    const og = el('optgroup', { label: KIND_LABELS[kind] });
    for (const p of group) {
      const taken = usedElsewhere.has(p.tid);
      og.append(el('option', { value: p.tid, textContent: p.name + (taken ? ' (already matched)' : ''), selected: current === p.tid }));
    }
    sel.append(og);
  }
  // A saved match that no longer exists in ProjectionLab.
  if (current && current !== '__skip' && !state.plAccounts.some((p) => p.tid === current)) {
    sel.value = '';
  }
  return sel;
}

function renderMatches() {
  const tbody = $('matchTable').querySelector('tbody');
  tbody.replaceChildren();
  const plIds = new Set(state.plAccounts.map((p) => p.tid));
  let matched = 0, skipped = 0, open = 0;

  if (!state.lbAccounts.length) {
    status('matchStatus', 'info', 'No active accounts found in this budget.');
  }

  for (const lb of state.lbAccounts) {
    const m = state.matches[lb.id];
    const missing = m && m !== '__skip' && !plIds.has(m);
    const sug = state.suggestions[lb.id];

    let pill;
    if (m === '__skip') { pill = el('span', { class: 'pill mute', textContent: 'Skipped' }); skipped++; }
    else if (missing) { pill = el('span', { class: 'pill warn', textContent: 'PL account missing' }); open++; }
    else if (m) { pill = el('span', { class: 'pill ok', textContent: 'Matched' }); matched++; }
    else { pill = el('span', { class: 'pill warn', textContent: 'Needs a match' }); open++; }

    const selectCell = el('td', {}, plSelect(lb));
    if (sug && (!m || missing)) {
      const p = state.plAccounts.find((x) => x.tid === sug.plId);
      selectCell.append(el('div', { class: 'suggest' },
        'Suggested: ', el('b', { textContent: p.name }), ' ',
        el('button', { class: 'link', textContent: 'Accept', onclick: () => acceptSuggestion(lb.id, sug.plId) })));
    }

    tbody.append(el('tr', {},
      el('td', {}, el('div', { textContent: lb.name }), el('div', { class: 'muted small', textContent: [TYPE_LABELS[lb.type] || lb.type, lb.accountGroup].filter(Boolean).join(' · ') })),
      el('td', { class: 'num', textContent: formatMoney(lbBalance(lb.id), currency()) }),
      selectCell,
      el('td', {}, pill),
    ));
  }

  $('matchTable').hidden = !state.lbAccounts.length;
  const pending = Object.keys(state.suggestions).length;
  $('acceptAll').hidden = !pending;
  $('acceptAll').textContent = `Accept all suggestions (${pending})`;
  $('matchSummary').textContent = state.lbAccounts.length
    ? `${matched} matched · ${skipped} skipped · ${open} need a match`
    : '';
}

async function acceptSuggestion(lbId, plId) {
  state.matches = await saveMatch(state.settings.budgetId, lbId, plId);
  state.suggestions = suggestMatches(state.lbAccounts, state.plAccounts, state.matches);
  renderMatches();
  clearPreview();
}

async function acceptAll() {
  const map = Object.fromEntries(Object.entries(state.suggestions).map(([lb, s]) => [lb, s.plId]));
  state.matches = await saveMatches(state.settings.budgetId, map);
  state.suggestions = suggestMatches(state.lbAccounts, state.plAccounts, state.matches);
  renderMatches();
  clearPreview();
}

// ---------- Step 3: preview & sync ----------

function clearPreview() {
  state.plan = null;
  $('previewTable').hidden = true;
  $('problems').replaceChildren();
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = 'Sync to ProjectionLab';
  status('syncStatus', '', '');
}

async function previewChanges() {
  clearPreview();
  $('previewBtn').disabled = true;
  status('syncStatus', 'info', 'Fetching the latest balances…');
  try {
    const s = state.settings;
    if (!s.lbToken || !s.plKey || !s.budgetId) throw new Error('Finish step 1 first.');
    const [lbAccounts, balances] = await Promise.all([
      listActiveAccounts(s.lbToken, s.budgetId),
      getBalances(s.lbToken, s.budgetId),
    ]);
    const plAccounts = await listPLAccounts(s.plKey);
    Object.assign(state, { lbAccounts, balances, plAccounts });
    state.matches = await getMatches(s.budgetId);

    const plan = buildPlan({ lbAccounts, balances, plAccounts, matches: state.matches, includePending: s.includePending });
    state.plan = plan;
    renderPreview(plan);
  } catch (e) {
    status('syncStatus', 'err', e.message);
  } finally {
    $('previewBtn').disabled = false;
  }
}

function renderPreview(plan) {
  const cur = currency();
  const tbody = $('previewTable').querySelector('tbody');
  tbody.replaceChildren();
  for (const r of plan.rows) {
    tbody.append(el('tr', {},
      el('td', { textContent: r.lb.name }),
      el('td', {}, el('div', { textContent: r.pl.name }), el('div', { class: 'muted small', textContent: KIND_LABELS[r.pl.kind] })),
      el('td', { class: 'num muted', textContent: formatMoney(r.currentValue, cur, { whole: Number.isInteger(r.currentValue) }) }),
      el('td', { class: 'num', textContent: formatMoney(r.newValue, cur, { whole: true }) }),
      el('td', {}, r.changed ? el('span', { class: 'pill', textContent: 'Will update' }) : el('span', { class: 'pill mute', textContent: 'No change' })),
    ));
  }
  $('previewTable').hidden = !plan.rows.length;

  const probs = $('problems');
  for (const p of plan.problems) probs.append(el('div', { class: 'banner warn', textContent: `${p.lb.name}: ${p.reason}` }));

  const unmatched = state.lbAccounts.filter((a) => !state.matches[a.id]).length;
  const changed = plan.rows.filter((r) => r.changed).length;
  if (!plan.rows.length) {
    status('syncStatus', 'err', 'No matched accounts yet. Match accounts in step 2.');
  } else {
    const extra = unmatched ? ` ${unmatched} unmatched account${unmatched === 1 ? ' is' : 's are'} left out.` : '';
    const b = state.balances || {};
    const asOf = b.asOf ? ` Balances as of ${new Date(b.asOf + 'T12:00:00').toLocaleDateString()}` : '';
    const future = b.futureSkipped ? ` (${b.futureSkipped} future-dated transaction${b.futureSkipped === 1 ? '' : 's'} ignored).` : (asOf ? '.' : '');
    status('syncStatus', 'info', `${changed} of ${plan.rows.length} matched account${plan.rows.length === 1 ? '' : 's'} will change.${extra}${asOf}${future}`);
  }
  $('syncBtn').disabled = !changed;
  $('syncBtn').textContent = changed ? `Sync ${changed} account${changed === 1 ? '' : 's'} to ProjectionLab` : 'Nothing to sync';
}

async function doSync() {
  if (!state.plan) return;
  $('syncBtn').disabled = true;
  status('syncStatus', 'info', 'Updating ProjectionLab…');
  try {
    const summary = await applyPlan(state.plan, state.settings.plKey);
    const probs = $('problems');
    if (summary.failed.length) {
      for (const f of summary.failed) probs.append(el('div', { class: 'banner err', textContent: `${f.name}: ${f.error}` }));
      status('syncStatus', 'err', `Updated ${summary.updated}, ${summary.failed.length} failed.`);
    } else {
      status('syncStatus', 'ok', `Done. Updated ${summary.updated} account${summary.updated === 1 ? '' : 's'} in ProjectionLab.`);
    }
    $('syncBtn').textContent = 'Synced';
  } catch (e) {
    status('syncStatus', 'err', e.message);
    $('syncBtn').disabled = false;
  }
}

// ---------- wiring ----------

$('lbTest').addEventListener('click', () => testLB(true));
$('plTest').addEventListener('click', testPL);
$('budget').addEventListener('change', onBudgetChange);
$('includePending').addEventListener('change', async (e) => {
  state.settings = await saveSettings({ includePending: e.target.checked });
  if (state.lbAccounts.length) renderMatches();
  clearPreview();
});
$('openPL').addEventListener('click', openPL);
$('toggleKeys').addEventListener('click', (e) => {
  const show = $('lbToken').type === 'password';
  $('lbToken').type = $('plKey').type = show ? 'text' : 'password';
  e.target.textContent = show ? 'Hide keys' : 'Show keys';
});
$('loadAccounts').addEventListener('click', loadAccounts);
$('acceptAll').addEventListener('click', acceptAll);
$('previewBtn').addEventListener('click', previewChanges);
$('syncBtn').addEventListener('click', doSync);

init();
