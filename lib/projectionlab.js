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
    const pick = (arr, kind, field) =>
      (Array.isArray(arr) ? arr : []).map((a) => ({
        id: a.id,
        name: a.name || '(unnamed)',
        kind,
        field,
        value: typeof a[field] === 'number' ? a[field] : null,
      }));
    return {
      ok: true,
      accounts: [
        ...pick(t.savingsAccounts, 'savings', 'balance'),
        ...pick(t.investmentAccounts, 'investment', 'balance'),
        ...pick(t.assets, 'asset', 'amount'),
        ...pick(t.debts, 'debt', 'balance'),
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
      results.push({ id: u.id, ok: true });
    } catch (e) {
      results.push({ id: u.id, ok: false, error: String((e && e.message) || e) });
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
  asset: 'Assets',
  debt: 'Debts',
};
