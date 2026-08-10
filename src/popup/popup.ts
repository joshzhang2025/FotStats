import { buildTimeline, currentMinute, type Timeline } from '../model/replay.ts';
import type { MatchSnapshot } from '../model/types.ts';
import { winProbDetailed } from '../model/winprob.ts';
import type { SnapshotResponse } from '../shared/protocol.ts';
import { CHART, minuteAtX, renderBar, renderTimeline, resolveColors, xForMinute } from './chart.ts';

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

function renderEmpty(reason: string) {
  const state = EMPTY_STATES[reason] ?? EMPTY_STATES['waiting']!;
  root.innerHTML = `<div class="empty"><strong>${state.title}</strong>${state.body}</div>`;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * Everything interpolated below originates in FotMob's payload — team names,
 * marker labels, diagnostic strings. None of it is ours to trust in innerHTML.
 */
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function statusLabel(snapshot: MatchSnapshot, minute: number): string {
  if (snapshot.status.cancelled) return 'Cancelled';
  if (snapshot.status.finished) return 'Full time';
  if (!snapshot.status.started) return 'Pre-match';
  return `<span class="live">${minute}'</span>`;
}

function render(snapshot: MatchSnapshot) {
  const minute = currentMinute(snapshot);
  const detail = winProbDetailed(snapshot, minute);
  const timeline = buildTimeline(snapshot, minute);
  const colors = resolveColors(snapshot);
  const state = detail.state;

  const eventList = timeline.markers
    .slice()
    .reverse()
    .slice(0, 6)
    .map(
      (m) =>
        `<li><span class="min">${m.minute}'</span><span>${
          m.kind === 'goal' ? '⚽' : '\u{1f7e5}'
        } ${esc(m.label)}</span></li>`,
    )
    .join('');

  const baselineNote =
    detail.baseline.source === 'table'
      ? 'Baseline from league table form'
      : `Baseline from league averages (${esc(detail.baseline.reason ?? 'no table data')})`;

  // Show every warning in full: these describe what the payload actually
  // contained, which is the whole point of having them.
  const warnings = snapshot.warnings.length
    ? `<div class="warn">${snapshot.warnings.map((w) => esc(w)).join('<br>')}</div>`
    : '';

  root.innerHTML = `
    <div class="teams">
      <span class="team-name">${esc(snapshot.home.name)}</span>
      <span class="score">${state.homeGoals} &ndash; ${state.awayGoals}</span>
      <span class="team-name">${esc(snapshot.away.name)}</span>
    </div>
    <div class="status">${statusLabel(snapshot, minute)}</div>

    <section>
      <h2>Win probability</h2>
      ${renderBar(detail, colors)}
      <div class="legend">
        <span><i class="swatch" style="background:${colors.home}"></i><span class="name">${esc(
          snapshot.home.name,
        )}</span> <b>${pct(detail.home)}</b></span>
        <span><i class="swatch" style="background:#64748b"></i>Draw <b>${pct(detail.draw)}</b></span>
        <span><i class="swatch" style="background:${colors.away}"></i><span class="name">${esc(
          snapshot.away.name,
        )}</span> <b>${pct(detail.away)}</b></span>
      </div>
    </section>

    <section>
      <h2>How did we get here</h2>
      <div class="chart" id="chart">
        ${renderTimeline(timeline, colors)}
        <div class="tooltip" id="tooltip"></div>
      </div>
      ${eventList ? `<ul class="events">${eventList}</ul>` : ''}
    </section>

    <footer>
      xG ${state.homeXg.toFixed(2)} &ndash; ${state.awayXg.toFixed(2)} &middot; ${baselineNote}
      ${warnings}
      ${__DEV__ ? '<button id="capture" class="capture">Save fixture</button>' : ''}
    </footer>`;

  attachScrub(timeline, snapshot);
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
      link.download = `${snapshot.matchId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      button.textContent = 'Saved';
    })();
  });
}

/** Hover the chart to read the probabilities at any minute. */
function attachScrub(timeline: Timeline, snapshot: MatchSnapshot) {
  const chart = document.getElementById('chart');
  const tooltip = document.getElementById('tooltip');
  const scrub = document.getElementById('scrub');
  if (!chart || !tooltip || !scrub) return;

  chart.addEventListener('mousemove', (event) => {
    const rect = chart.getBoundingClientRect();
    // The chart has a left gutter for the axis labels, so screen position has
    // to be converted into SVG units before it means anything in minutes.
    const svgX = (event.clientX - rect.left) * (CHART.width / rect.width);
    const minute = minuteAtX(svgX, timeline.fullTime);
    const point =
      timeline.points.find((p) => p.minute === minute) ??
      timeline.points[timeline.points.length - 1];
    if (!point) return;

    const lineX = xForMinute(point.minute, timeline.fullTime);
    scrub.setAttribute('x1', String(lineX));
    scrub.setAttribute('x2', String(lineX));
    scrub.style.display = '';

    tooltip.style.display = 'block';
    tooltip.innerHTML = `${point.minute}' &middot; ${esc(snapshot.home.name)} ${pct(point.home)} &middot; Draw ${pct(
      point.draw,
    )} &middot; ${esc(snapshot.away.name)} ${pct(point.away)}`;
    // Keep the tooltip inside the chart rather than letting it overflow.
    const scale = rect.width / CHART.width;
    const half = tooltip.offsetWidth / 2;
    const left = Math.min(Math.max(lineX * scale, half), rect.width - half);
    tooltip.style.left = `${left - half}px`;
  });

  chart.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
    scrub.style.display = 'none';
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
