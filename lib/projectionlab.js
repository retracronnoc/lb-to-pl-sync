// ProjectionLab Plugin API bridge.
// Docs: https://app.projectionlab.com/docs/
//
// ProjectionLab has no server API. Its plugin API lives on
// window.projectionlabPluginAPI inside an open, signed-in ProjectionLab tab
// (after "Enable plugins" is turned on in Account Settings). We inject small
// self-contained functions into that page's MAIN world to call it.

const PL_ORIGIN = 'https://app.projectionlab.com';
const PL_MATCH = `${PL_ORIGIN}/*`;

export class PLError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'PLError';
    this.code = code;
  }
}

export async function findPLTab() {
  const tabs = await chrome.tabs.query({ url: PL_MATCH });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs.find((t) => t.status === 'complete') || tabs[0];
}

export async function openPL() {
  return chrome.tabs.create({ url: PL_ORIGIN, active: true });
}

async function runInPL(func, args) {
  const tab = await findPLTab();
  if (!tab) {
    throw new PLError('Open ProjectionLab in a tab and sign in, then try again.', 'NO_TAB');
  }
  let out;
  try {
    [out] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args });
  } catch (e) {
    throw new PLError(`Could not talk to the ProjectionLab tab: ${e.message}. Reload that tab and try again.`, 'INJECT');
  }
  const r = out?.result;
  if (!r) throw new PLError('ProjectionLab did not respond. Reload the ProjectionLab tab and try again.', 'NO_RESULT');
  if (!r.ok) throw new PLError(r.error, r.code || 'ERROR');
  return r;
}

// ---- Functions below run inside the ProjectionLab page. They must be fully
// ---- self-contained (no closures, no imports).

async function pageValidate(key) {
  const api = window.projectionlabPluginAPI;
  if (!api) return { ok: false, code: 'NO_API', error: 'ProjectionLab plugin API not found. Make sure you are signed in and "Enable plugins" is on in Account Settings, then reload the ProjectionLab tab.' };
  try {
    await api.validateApiKey({ key });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'BAD_KEY', error: 'ProjectionLab rejected the plugin API key. Copy it again from Account Settings → Plugins.' };
  }
}

async function pageExport(key) {
  const api = window.projectionlabPluginAPI;
  if (!api) return { ok: false, code: 'NO_API', error: 'ProjectionLab plugin API not found. Make sure you are signed in and "Enable plugins" is on in Account Settings, then reload the ProjectionLab tab.' };
  try {
    const data = await api.exportData({ key });
    const t = (data && data.today) || {};
    // Use whichever balance-like property the account actually has, so
    // updateAccount never targets a property that doesn't exist (which PL
    // rejects with "No matching property for assignment").
    const pick = (arr, kind, candidates) =>
      (Array.isArray(arr) ? arr : []).map((a) => {
        const field = candidates.find((f) => Object.prototype.hasOwnProperty.call(a, f)) || null;
        return {
          id: a.id,
          tid: a.id, // target id used for matching
          name: a.name || '(unnamed)',
          kind,
          field,
          value: field && typeof a[field] === 'number' ? a[field] : null,
          keys: field ? undefined : Object.keys(a).filter((k) => typeof a[k] === 'number' || a[k] === null).slice(0, 15),
        };
      });
    // Assets: `amount` is the current value. A financed asset also has
    // `balance` (amount still owed), offered as its own "loan" target so a
    // Liquid Budget mortgage/loan account can feed it.
    const assetsArr = Array.isArray(t.assets) ? t.assets : [];
    const assetLoans = assetsArr
      .filter((a) => Object.prototype.hasOwnProperty.call(a, 'balance') && Object.prototype.hasOwnProperty.call(a, 'amount'))
      .map((a) => ({
        id: a.id,
        tid: a.id + '::loan',
        name: (a.name || '(unnamed)') + ' (loan)',
        kind: 'assetLoan',
        field: 'balance',
        value: typeof a.balance === 'number' ? a.balance : null,
      }));
    return {
      ok: true,
      accounts: [
        ...pick(t.savingsAccounts, 'savings', ['balance', 'amount', 'value']),
        ...pick(t.investmentAccounts, 'investment', ['balance', 'amount', 'value']),
        ...pick(assetsArr, 'asset', ['amount', 'balance', 'value']),
        ...assetLoans,
        ...pick(t.debts, 'debt', ['balance', 'amount', 'value']),
      ],
    };
  } catch (e) {
    return { ok: false, code: 'EXPORT', error: 'ProjectionLab export failed: ' + ((e && e.message) || e) };
  }
}

async function pageUpdate(key, updates) {
  const api = window.projectionlabPluginAPI;
  if (!api) return { ok: false, code: 'NO_API', error: 'ProjectionLab plugin API not found. Reload the ProjectionLab tab.' };
  const results = [];
  for (const u of updates) {
    try {
      await api.updateAccount(u.id, { [u.field]: u.value }, { key });
      results.push({ id: u.id, field: u.field, ok: true });
    } catch (e) {
      results.push({ id: u.id, field: u.field, ok: false, error: String((e && e.message) || e) });
    }
  }
  return { ok: true, results };
}

// ---- Public API

export async function validatePLKey(key) {
  await runInPL(pageValidate, [key]);
  return true;
}

/** Returns [{id, name, kind: savings|investment|asset|debt, field, value}] */
export async function listPLAccounts(key) {
  const r = await runInPL(pageExport, [key]);
  return r.accounts;
}

/** updates: [{id, field, value}] → [{id, ok, error?}] */
export async function updatePLAccounts(key, updates) {
  const r = await runInPL(pageUpdate, [key, updates]);
  return r.results;
}

export const KIND_LABELS = {
  savings: 'Savings / cash',
  investment: 'Investments',
  asset: 'Assets (value)',
  assetLoan: 'Asset loans (amount owed)',
  debt: 'Debts',
};

/** Targets that hold an amount owed (Liquid Budget sign is flipped). */
export const OWED_KINDS = new Set(['debt', 'assetLoan']);
