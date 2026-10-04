# Liquid Budget → ProjectionLab Sync

A Chrome extension that copies account balances from Liquid Budget into ProjectionLab's Current Finances.

## Install (unpacked)
1. Unzip this folder.
2. Go to `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `lb-pl-sync` folder.
4. Pin the extension, click it, then click **Setup & matching**.

## Setup
1. **Liquid Budget token:** Liquid Budget → Developer → API Tokens. Use a read-only token (`lbro_…`). Paste it in and click **Save & test**, then pick your budget.
2. **ProjectionLab key:** ProjectionLab → Account Settings → Plugins → turn on **Enable plugins** and copy the key. Keep a signed-in ProjectionLab tab open, paste the key, and click **Save & test**.
3. **Match accounts:** click **Load accounts**. Each active (non-archived) Liquid Budget account gets a dropdown of ProjectionLab accounts. Name-based suggestions appear under each one. Accept them one by one or with **Accept all suggestions**, or choose **Don't sync this account**. Matches save automatically.
4. **Preview & sync:** see current vs. new values, then sync.

After setup, the toolbar popup's **Sync now** button does everything in one click (a ProjectionLab tab must be open).

## How balances are calculated
- Liquid Budget's API has no balance field, so each balance is the sum of that account's transactions **dated today or earlier** (one request per sync for the whole budget). Future-dated and scheduled transactions are ignored until their date arrives. "Today" is your computer's local date. Pending transactions are included by default. You can turn that off in setup.
- Amounts come from the API at scale 4 (123400 = $12.34) and are rounded to the **nearest whole dollar** before going to ProjectionLab.
- Liquid Budget liabilities (credit cards, off-budget liabilities) are negative. When the target is a ProjectionLab **debt**, the sign is flipped so ProjectionLab gets the positive amount owed.
- **Financed assets** (e.g. a house with a mortgage) appear twice in the dropdown: *Primary Home* under **Assets (value)**, which updates its `amount`, and *Primary Home (loan)* under **Asset loans (amount owed)**, which updates its `balance`. Match your Liquid Budget home-value account to the first and your mortgage account to the second. The mortgage is sent as a positive amount owed.
- For other accounts, the field updated is whichever one each ProjectionLab account actually has: `balance` first, then `amount` (assets check `amount` first). Accounts with neither are skipped and listed in the preview. The `force` option is never used, so the extension can't create stray fields in your ProjectionLab data.

## Rate limits
Liquid Budget allows 100 requests/hour per token. The extension sends ETags, so unchanged data comes back as a 304, which doesn't count toward the limit. A sync usually uses about 3 requests.

## Files
- `lib/liquidbudget.js` – Liquid Budget API client, ETag cache, balance math
- `lib/projectionlab.js` – runs the ProjectionLab plugin API inside your open PL tab
- `lib/match.js` – name/type-based match suggestions
- `lib/sync.js`, `lib/runner.js` – sync plan and apply
- `options.*` – setup/matching page; `popup.*` – toolbar popup
