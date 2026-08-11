import type { Timeline } from '../model/replay.ts';
import type { MatchSnapshot } from '../model/types.ts';
import { CHART, esc, minuteAtX, xForMinute } from './chart.ts';

/**
 * Hover the chart to read the probabilities at any minute.
 *
 * Takes the root to search rather than reaching for `document`: the overlay
 * renders inside a shadow root, where a global `getElementById` finds nothing.
 * The hooks are `data-fotstats` attributes rather than ids for the same reason
 * ids stopped being safe — the same markup is rendered more than once per page.
 */
export function attachScrub(root: ParentNode, timeline: Timeline, snapshot: MatchSnapshot): void {
  const chart = root.querySelector<HTMLElement>('[data-fotstats="chart"]');
  const tooltip = root.querySelector<HTMLElement>('[data-fotstats="tooltip"]');
  const scrub = root.querySelector<SVGLineElement>('[data-fotstats="scrub"]');
  if (!chart || !tooltip || !scrub) return;

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

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
    tooltip.innerHTML = `${point.minute}' &middot; ${esc(snapshot.home.name)} ${pct(
      point.home,
    )} &middot; Draw ${pct(point.draw)} &middot; ${esc(snapshot.away.name)} ${pct(point.away)}`;
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
