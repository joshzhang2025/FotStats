import { buildTimeline, currentMinute, nextGoalSwing, type Timeline } from '../model/replay.ts';
import type { MatchSnapshot } from '../model/types.ts';
import { winProbDetailed } from '../model/winprob.ts';
import { esc, renderBar, renderEvents, renderTimeline, resolveColors } from './chart.ts';

/**
 * The card, rendered as a string and shared by both surfaces.
 *
 * The popup and the in-page overlay show the same thing on purpose: two
 * hand-maintained layouts of the same numbers would drift, and there is no
 * version of this where the popup deserves a different answer to the page.
 */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function statusLabel(snapshot: MatchSnapshot, minute: number): string {
  if (snapshot.status.cancelled) return 'Cancelled';
  if (snapshot.status.finished) return 'Full time';
  if (!snapshot.status.started) return 'Pre-match';
  return `<span class="live">${minute}'</span>`;
}

/**
 * Everything both surfaces need, computed once.
 *
 * The model is pure and reconstructs its own state, so this is cheap enough to
 * redo on every render — but the timeline is also what the chart hover needs to
 * read back, so the caller keeps it.
 */
export function buildView(snapshot: MatchSnapshot, atMinute?: number) {
  const minute = atMinute ?? currentMinute(snapshot);
  return {
    minute,
    detail: winProbDetailed(snapshot, minute),
    timeline: buildTimeline(snapshot, minute),
    colors: resolveColors(snapshot),
    teams: { home: snapshot.home.name, away: snapshot.away.name },
  };
}

export type View = ReturnType<typeof buildView>;

/**
 * What the next goal would be worth, for each side.
 *
 * The model has always been able to answer this — the same pure function,
 * asked about a hypothetical — and it is the most useful thing on the card for
 * a match in progress: 0-0 at 80 minutes reads as settled until you see what a
 * single goal still does to it. Each side is shown its *own* win probability
 * after scoring, which is the way the question gets asked out loud.
 */
export function renderSwing(snapshot: MatchSnapshot, view: View): string {
  // A finished match has no next goal, and a hypothetical one would be a lie.
  if (snapshot.status.finished || snapshot.status.cancelled) return '';

  const swing = nextGoalSwing(snapshot, view.minute);
  const row = (name: string, value: number, color: string) =>
    `<span><i class="swatch" style="background:${color}"></i>` +
    `<span class="name">${esc(name)}</span> <b>${pct(value)}</b></span>`;

  return (
    `<div class="swing"><span class="swing-label">If they score next</span>` +
    `<div class="legend">` +
    row(view.teams.home, swing.ifHomeScores.home, view.colors.home) +
    row(view.teams.away, swing.ifAwayScores.away, view.colors.away) +
    `</div></div>`
  );
}

/** Where the baseline came from — the difference between a number that had seen
 * the season end and one that had not. */
export function baselineNote(snapshot: MatchSnapshot, view: View): string {
  // Guarded: `toISOString` throws on an unparseable date, and a footnote is not
  // worth taking the whole card down for.
  const asOf = Number.isFinite(snapshot.tableAsOfDay)
    ? new Date(snapshot.tableAsOfDay! * 86_400_000).toISOString().slice(0, 10)
    : null;

  return view.detail.baseline.source === 'table-historical'
    ? `Baseline from league table as of ${esc(asOf ?? 'kickoff')}`
    : view.detail.baseline.source === 'table-prior'
      ? "Baseline from last season's form (no table yet)"
      : view.detail.baseline.source === 'table'
        ? 'Baseline from league table form'
        : `Baseline from league averages (${esc(view.detail.baseline.reason ?? 'no table data')})`;
}

/**
 * The whole card: score, probabilities, swing, timeline and goal summary.
 *
 * `footer` is opt-in because the overlay has no room to spend on diagnostics —
 * the popup is where you go when you want to know why a number is what it is.
 */
export function renderCard(
  snapshot: MatchSnapshot,
  view: View,
  options: { footer?: boolean } = {},
): string {
  const { detail, timeline, colors, teams, minute } = view;
  const state = detail.state;

  const warnings =
    options.footer && snapshot.warnings.length
      ? `<div class="warn">${snapshot.warnings.map((w) => esc(w)).join('<br>')}</div>`
      : '';

  const footer = options.footer
    ? `<footer>xG ${state.homeXg.toFixed(2)} &ndash; ${state.awayXg.toFixed(2)} &middot; ${baselineNote(
        snapshot,
        view,
      )}${warnings}</footer>`
    : '';

  return `
    <div class="teams">
      <span class="team-name">${esc(teams.home)}</span>
      <span class="score">${state.homeGoals} &ndash; ${state.awayGoals}</span>
      <span class="team-name">${esc(teams.away)}</span>
    </div>
    <div class="status">${statusLabel(snapshot, minute)}</div>

    <section>
      <h2>Win probability</h2>
      ${renderBar(detail, colors)}
      <div class="legend">
        <span><i class="swatch" style="background:${colors.home}"></i><span class="name">${esc(
          teams.home,
        )}</span> <b>${pct(detail.home)}</b></span>
        <span><i class="swatch" style="background:#64748b"></i>Draw <b>${pct(detail.draw)}</b></span>
        <span><i class="swatch" style="background:${colors.away}"></i><span class="name">${esc(
          teams.away,
        )}</span> <b>${pct(detail.away)}</b></span>
      </div>
      ${renderSwing(snapshot, view)}
    </section>

    <section>
      <h2>Minute by minute</h2>
      <div class="chart" data-fotstats="chart">
        ${renderTimeline(timeline, colors)}
        <div class="tooltip" data-fotstats="tooltip"></div>
      </div>
      ${renderEvents(timeline, teams, colors)}
    </section>
    ${footer}`;
}

/**
 * The collapsed overlay: score, clock and the bar, and nothing else.
 *
 * This is what sits on FotMob's page by default, so it is deliberately the
 * smallest thing that still answers the question. Anything more belongs behind
 * the expand toggle.
 */
export function renderPill(snapshot: MatchSnapshot, view: View): string {
  const { detail, colors, minute } = view;
  const clock = snapshot.status.finished
    ? 'FT'
    : snapshot.status.started
      ? `${minute}'`
      : '—';

  return (
    `<span class="pill-score">${detail.state.homeGoals}&ndash;${detail.state.awayGoals}</span>` +
    `<span class="pill-clock">${clock}</span>` +
    renderBar(detail, colors)
  );
}

export type { Timeline };
