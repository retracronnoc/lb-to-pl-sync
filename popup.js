import { getSettings, getMatches } from './lib/storage.js';
import { listBudgets } from './lib/liquidbudget.js';
import { openPL, findPLTab } from './lib/projectionlab.js';
import { syncNow, getLastSync, timeAgo } from './lib/runner.js';

const $ = (id) => document.getElementById(id);

function setResult(kind, msg) {
  $('result').className = `status ${kind}`;
  $('result').textContent = msg;
}

async function render() {
  const s = await getSettings();
  const missing = [];
  if (!s.lbToken) missing.push('a Liquid Budget token');
  if (!s.plKey) missing.push('a ProjectionLab plugin key');
  if (!s.budgetId) missing.push('a budget');
  const matches = s.budgetId ? await getMatches(s.budgetId) : {};
  const matched = Object.values(matches).filter((v) => v && v !== '__skip').length;
  if (!missing.length && !matched) missing.push('at least one matched account');

  if (missing.length) {
    $('setupNeeded').hidden = false;
    $('setupNeeded').textContent = `Finish setup: add ${missing.join(', ')}.`;
    $('ready').hidden = true;
    return;
  }

  $('ready').hidden = false;
  $('matchedCount').textContent = String(matched);
  const last = await getLastSync();
  $('lastSync').textContent = timeAgo(last?.time);

  try {
    const budgets = await listBudgets(s.lbToken);
    $('budgetName').textContent = budgets.find((b) => b.id === s.budgetId)?.name || 'Not found';
  } catch {
    $('budgetName').textContent = '—';
  }

  if (!(await findPLTab())) {
    setResult('info', 'Open ProjectionLab in a tab to sync.');
  }
}

$('syncNow').addEventListener('click', async () => {
  const btn = $('syncNow');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  $('details').hidden = true;
  $('details').replaceChildren();
  setResult('info', '');
  try {
    const r = await syncNow();
    const parts = [`Updated ${r.updated}`];
    if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    setResult(r.failed.length ? 'err' : 'ok', parts.join(' · ') + '.');
    for (const f of r.failed) {
      const li = document.createElement('li');
      li.textContent = `${f.name}: ${f.error}`;
      $('details').append(li);
    }
    if (r.problems) {
      const li = document.createElement('li');
      li.textContent = `${r.problems} match issue${r.problems === 1 ? '' : 's'}. Open setup and preview to see details.`;
      $('details').append(li);
    }
    $('details').hidden = !$('details').children.length;
    $('lastSync').textContent = timeAgo(r.time);
  } catch (e) {
    setResult('err', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

$('openSetup').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openPL').addEventListener('click', () => openPL());

// Web links open in a new tab.
for (const id of ['lbLink', 'supportLink']) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: e.currentTarget.href });
    window.close();
  });
}

// mailto: links don't open reliably from extension popups (it depends on the
// computer's mail-app setup), so clicking the address copies it instead.
$('emailLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const link = e.currentTarget;
  const address = link.textContent;
  try {
    await navigator.clipboard.writeText(address);
    link.textContent = 'Email copied!';
  } catch {
    link.textContent = address; // copy failed; address stays visible to copy by hand
    return;
  }
  setTimeout(() => { link.textContent = address; }, 1500);
});

render();
