import type { Timeline } from '../model/replay.ts';
import type { MatchSnapshot } from '../model/types.ts';

/**
 * Hand-rolled SVG. MV3's CSP blocks CDN scripts anyway, and bundling a chart
 * library to draw three polylines and one bar is not a trade worth making.
 */

export const CHART = {
  width: 348,
  height: 178,
  padLeft: 26,
  padRight: 6,
  /** Room for the marker lane above the plot as well as the top gridline. */
  padTop: 22,
  padBottom: 18,
} as const;

/**
 * Goals and red cards get a lane of their own above the plot rather than a dot
 * on the top gridline: a marker sitting inside the plot lands on whichever line
 * happens to pass through it, which is exactly where the reader is looking.
 */
const MARKER_R = 5;
const MARKER_Y = 12;
/** Centre panel of the ball, as a fraction of its radius. */
const PANEL_R = MARKER_R * 0.42;
const RED_CARD_COLOR = '#e5484d';

const plotLeft = CHART.padLeft;
const plotRight = CHART.width - CHART.padRight;
const plotTop = CHART.padTop;
const plotBottom = CHART.height - CHART.padBottom;
const plotWidth = plotRight - plotLeft;
const plotHeight = plotBottom - plotTop;

const DRAW_COLOR = '#64748b';
const DEFAULT_HOME = '#2563eb';
const DEFAULT_AWAY = '#dc2626';

const fmt = (n: number) => n.toFixed(1);

export const xForMinute = (minute: number, fullTime: number) =>
  plotLeft + (minute / fullTime) * plotWidth;

const yForValue = (value: number) => plotTop + (1 - value) * plotHeight;

/** Inverse of {@link xForMinute}, for mapping a hover back onto the clock. */
export function minuteAtX(svgX: number, fullTime: number): number {
  const ratio = Math.min(1, Math.max(0, (svgX - plotLeft) / plotWidth));
  return Math.round(ratio * fullTime);
}

/**
 * A football, in the scoring side's colour.
 *
 * Ten pixels across is not much to draw a ball in, and the emoji is no use here
 * because its colours are fixed — the whole point of the marker is to say which
 * side scored. What survives at this size is the silhouette: a centre panel,
 * point up, with a seam running out of each of its corners. Everything is
 * cut out of the body in the page colour rather than drawn on top of it, so the
 * team colour stays the thing you actually see.
 */
function football(cx: number, cy: number, color: string): string {
  const angles = Array.from({ length: 5 }, (_, i) => ((-90 + i * 72) * Math.PI) / 180);
  const at = (radius: number, angle: number) =>
    [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;

  const panel = angles.map((a) => at(PANEL_R, a).map(fmt).join(',')).join(' ');
  const seams = angles
    .map((a) => {
      const [x1, y1] = at(PANEL_R, a);
      // Stop just short of the rim, so the seams do not eat its outline.
      const [x2, y2] = at(MARKER_R - 0.5, a);
      return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" class="ball-seam"/>`;
    })
    .join('');

  return (
    `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${MARKER_R}" fill="${color}" class="marker-dot"/>` +
    `<polygon points="${panel}" class="ball-face"/>${seams}`
  );
}

function parseHex(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (full.length !== 6) return null;
  const int = Number.parseInt(full, 16);
  return Number.isNaN(int) ? null : [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** Rough perceptual brightness, 0 (black) to 1 (white). */
function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

function distance(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return 0;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * Pick line colours that stay readable.
 *
 * Kit colours are not chart colours. The popup renders on a light or dark
 * background depending on the viewer's theme, so a white kit (Tottenham) or a
 * near-black one (Newcastle) disappears into one of them. A colour is kept only
 * if it sits in a usable brightness band and is clearly distinct from both the
 * draw line and the other team; otherwise both sides fall back to a palette
 * that is legible either way.
 */
export function resolveColors(snapshot: MatchSnapshot): { home: string; away: string } {
  const { home, away } = snapshot.colors;
  const homeLum = luminance(home);
  const awayLum = luminance(away);

  const usable = (lum: number | null) => lum !== null && lum >= 0.15 && lum <= 0.78;
  const distinct =
    distance(home, away) >= 90 &&
    distance(home, DRAW_COLOR) >= 60 &&
    distance(away, DRAW_COLOR) >= 60;

  return usable(homeLum) && usable(awayLum) && distinct
    ? { home, away }
    : { home: DEFAULT_HOME, away: DEFAULT_AWAY };
}

/**
 * Three probability lines over the clock — home, draw, away — on a shared
 * 0-100% axis.
 *
 * Lines rather than a stacked area: the question people ask of this chart is
 * "where was each outcome trading at minute X", and separate lines answer it
 * directly. A stack forces you to measure band thickness, and hides any series
 * whose colour matches the background.
 */
export function renderTimeline(timeline: Timeline, colors: { home: string; away: string }): string {
  const { points, markers, fullTime } = timeline;
  if (points.length === 0) return '';

  const line = (accessor: (p: (typeof points)[number]) => number) =>
    points
      .map((p) => `${fmt(xForMinute(p.minute, fullTime))},${fmt(yForValue(accessor(p)))}`)
      .join(' ');

  const gridRows = [0, 0.25, 0.5, 0.75, 1]
    .map((value) => {
      const y = fmt(yForValue(value));
      return (
        `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" class="grid"/>` +
        `<text x="${plotLeft - 5}" y="${Number(y) + 3}" class="axis" text-anchor="end">${value * 100}</text>`
      );
    })
    .join('');

  const timeLabels = [0, 45, 90]
    .filter((m) => m <= fullTime)
    .map((m) => {
      const x = fmt(xForMinute(m, fullTime));
      return `<text x="${x}" y="${CHART.height - 5}" class="axis" text-anchor="middle">${m}'</text>`;
    })
    .join('');

  // On a live match the lines stop at the current minute; shade what is left so
  // the empty space reads as "not played yet" rather than as flat probability.
  const lastMinute = points[points.length - 1]!.minute;
  const lastX = xForMinute(lastMinute, fullTime);
  const isLive = lastX < plotRight - 0.5;
  const unplayed = isLive
    ? `<rect x="${fmt(lastX)}" y="${plotTop}" width="${fmt(plotRight - lastX)}" height="${plotHeight}" class="unplayed"/>` +
      `<line x1="${fmt(lastX)}" y1="${plotTop}" x2="${fmt(lastX)}" y2="${plotBottom}" class="now"/>`
    : '';

  const markerEls = markers
    .map((marker) => {
      const x = xForMinute(marker.minute, fullTime);
      const color =
        marker.kind === 'red' ? RED_CARD_COLOR : marker.isHome ? colors.home : colors.away;
      // A ball for a goal, a card for a red — each in the scoring side's colour,
      // the same one its probability line is drawn in.
      const glyph =
        marker.kind === 'goal'
          ? football(x, MARKER_Y, color)
          : `<rect x="${fmt(x - 2.5)}" y="${MARKER_Y - 4}" width="5" height="8" rx="1.5" fill="${color}" class="marker-dot"/>`;
      // The dropline is what puts the marker on the clock; it starts below the
      // glyph so the two read as one object.
      return (
        `<line x1="${fmt(x)}" y1="${MARKER_Y + MARKER_R + 1.5}" x2="${fmt(x)}" y2="${plotBottom}" class="marker-line"/>${glyph}`
      );
    })
    .join('');

  const series = [
    { points: line((p) => p.away), color: colors.away },
    { points: line((p) => p.draw), color: DRAW_COLOR },
    { points: line((p) => p.home), color: colors.home },
  ];

  const polylines = series
    .map((s) => `<polyline points="${s.points}" fill="none" stroke="${s.color}" class="series"/>`)
    .join('');

  // A dot on the leading edge of each line, so the current value is findable
  // without hovering.
  const last = points[points.length - 1]!;
  const endDots = [
    { value: last.away, color: colors.away },
    { value: last.draw, color: DRAW_COLOR },
    { value: last.home, color: colors.home },
  ]
    .map(
      (d) =>
        `<circle cx="${fmt(lastX)}" cy="${fmt(yForValue(d.value))}" r="2.5" fill="${d.color}"/>`,
    )
    .join('');

  return `
    <svg viewBox="0 0 ${CHART.width} ${CHART.height}" width="${CHART.width}" height="${CHART.height}"
         role="img" aria-label="Win probability by minute">
      ${gridRows}
      ${unplayed}
      ${markerEls}
      ${polylines}
      ${endDots}
      ${timeLabels}
      <line id="scrub" x1="0" y1="${plotTop}" x2="0" y2="${plotBottom}" class="scrub" style="display:none"/>
    </svg>`;
}

/** Most recent events listed under the chart; older ones fall off the end. */
const EVENT_LIMIT = 6;

/**
 * Everything interpolated into markup here originates in FotMob's payload —
 * team names, scorer names, marker labels. None of it is ours to trust.
 */
export const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * The goal summary under the chart, newest first.
 *
 * A running scoreline does not say who scored it — reading "1-0" then "1-1"
 * means diffing two rows to find which number moved. The swatch settles it in
 * the popup's existing vocabulary: the same colour as that side's line, its
 * marker on the chart, and its figure in the legend, so no row has to spend
 * width repeating a team name.
 */
export function renderEvents(
  timeline: Timeline,
  teams: { home: string; away: string },
  colors: { home: string; away: string },
): string {
  const rows = timeline.markers
    .slice()
    .reverse()
    .slice(0, EVENT_LIMIT)
    .map((marker) => {
      const team = marker.isHome ? teams.home : teams.away;
      const color = marker.isHome ? colors.home : colors.away;
      // The title is the non-visual fallback: colour alone is no use to a
      // screen reader, and not everyone separates two hues reliably.
      return (
        `<li title="${esc(team)}">` +
        `<span class="min">${marker.minute}'</span>` +
        `<i class="swatch" style="background:${color}"></i>` +
        `<span class="what">${marker.kind === 'goal' ? '⚽' : '\u{1f7e5}'} ${esc(marker.label)}</span>` +
        `</li>`
      );
    })
    .join('');

  return rows ? `<ul class="events">${rows}</ul>` : '';
}

/** Single stacked bar for the current probabilities. */
export function renderBar(
  probs: { home: number; draw: number; away: number },
  colors: { home: string; away: string },
): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const segment = (value: number, color: string, label: string) =>
    value < 0.001
      ? ''
      : `<div class="seg" style="width:${value * 100}%;background:${color}" title="${label} ${pct(value)}"></div>`;

  return `
    <div class="bar">
      ${segment(probs.home, colors.home, 'Home win')}
      ${segment(probs.draw, DRAW_COLOR, 'Draw')}
      ${segment(probs.away, colors.away, 'Away win')}
    </div>`;
}
