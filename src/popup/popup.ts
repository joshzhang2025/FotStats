import type { MatchSnapshot } from '../model/types.ts';
import type { SnapshotResponse } from '../shared/protocol.ts';
import { buildView, renderCard } from '../view/card.ts';
import { esc } from '../view/chart.ts';
import { attachScrub } from '../view/scrub.ts';

const root = document.getElementById('root')!;

const EMPTY_STATES: Record<string, { title: string; body: string }> = {
  'no-tab': { title: 'No active tab', body: 'Open a FotMob match and try again.' },
  'not-fotmob': { title: 'Not on FotMob', body: 'Open a match on fotmob.com to see win probability.' },
  'not-a-match': {
    title: 'No match selected',
    body: 'Open a specific match page — FotStats reads that match’s own data.',
  },
  waiting: {
    title: 'Waiting for match data',
    body: 'FotMob has not sent match details yet. Reload the page if this sticks around.',
  },
};

/**
 * The popup says why it has nothing, where the in-page overlay just stays
 * absent: you opened this deliberately and are owed an answer.
 */
function renderEmpty(reason: string) {
  const state = EMPTY_STATES[reason] ?? EMPTY_STATES['waiting']!;
  root.innerHTML = `<div class="empty"><strong>${state.title}</strong>${state.body}</div>`;
}

function render(snapshot: MatchSnapshot) {
  const view = buildView(snapshot);

  root.innerHTML =
    renderCard(snapshot, view, { footer: true }) +
    (__DEV__ ? '<button id="capture" class="capture">Save fixture</button>' : '');

  attachScrub(root, view.timeline, snapshot);
  if (__DEV__) attachCapture(snapshot);
}

/**
 * Dev-only fixture capture.
 *
 * Calibration needs real finished matches, and the API cannot be reached from
 * outside the page — so the extension is also the only way to collect them.
 * Saves the unreduced payload the bridge is holding into test/fixtures/.
 */
function attachCapture(snapshot: MatchSnapshot) {
  const button = document.getElementById('capture');
  if (!button) return;
  button.addEventListener('click', () => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const response = (await chrome.tabs.sendMessage(tab.id, { type: 'get-raw' })) as {
        ok: boolean;
        raw: unknown;
      };
      if (!response?.ok) {
        button.textContent = 'No raw payload yet';
        return;
      }
      const blob = new Blob([JSON.stringify(response.raw)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${esc(snapshot.matchId)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      button.textContent = 'Saved';
    })();
  });
}

async function refresh() {
  try {
    // Resolve the tab here rather than in the worker: `currentWindow` from a
    // service worker means "last focused", which is not reliably this one.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = (await chrome.runtime.sendMessage({
      type: 'get-snapshot',
      tabId: tab?.id,
    })) as SnapshotResponse;
    if (!response?.ok) {
      renderEmpty(response?.reason ?? 'waiting');
      return;
    }
    render(response.snapshot);
  } catch {
    renderEmpty('waiting');
  }
}

void refresh();
// Live matches poll on FotMob's own schedule; re-reading the cache keeps the
// popup current for as long as it stays open.
setInterval(() => void refresh(), 10_000);
