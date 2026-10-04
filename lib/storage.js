// Thin promise wrappers over chrome.storage.local.

export async function getLocal(key) {
  const r = await chrome.storage.local.get(key);
  return r[key];
}

export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

const DEFAULT_SETTINGS = {
  lbToken: '',
  plKey: '',
  budgetId: '',
  includePending: true,
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await getLocal('settings')) || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await setLocal('settings', next);
  return next;
}

// matches: { [budgetId]: { [lbAccountId]: plAccountId | '__skip' } }
export async function getMatches(budgetId) {
  const all = (await getLocal('matches')) || {};
  return all[budgetId] || {};
}

export async function saveMatch(budgetId, lbAccountId, plAccountId) {
  const all = (await getLocal('matches')) || {};
  const forBudget = { ...(all[budgetId] || {}) };
  if (plAccountId) forBudget[lbAccountId] = plAccountId;
  else delete forBudget[lbAccountId];
  all[budgetId] = forBudget;
  await setLocal('matches', all);
  return forBudget;
}

export async function saveMatches(budgetId, map) {
  const all = (await getLocal('matches')) || {};
  all[budgetId] = { ...(all[budgetId] || {}), ...map };
  await setLocal('matches', all);
  return all[budgetId];
}
