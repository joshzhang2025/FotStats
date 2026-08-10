/**
 * Club-name reconciliation between FotMob and football-data.co.uk.
 *
 * The historical results file identifies clubs by name — it carries no FotMob
 * team ids, and FotMob's ids are not published anywhere we can fetch without a
 * signed request. So both sides are folded onto a canonical key instead.
 *
 * This only has to be right for clubs that have played in the Premier League,
 * which is a closed list of ~50 names that grows by two or three each August.
 */

/**
 * Canonical key -> every spelling seen for it.
 *
 * The left column is arbitrary but stable; nothing depends on its exact value
 * beyond the two sides agreeing. Entries cover football-data.co.uk's short
 * forms and FotMob's long forms, since either may arrive.
 */
const ALIASES: Record<string, string[]> = {
  arsenal: ['arsenal'],
  'aston villa': ['aston villa', 'villa'],
  barnsley: ['barnsley'],
  birmingham: ['birmingham', 'birmingham city'],
  blackburn: ['blackburn', 'blackburn rovers'],
  blackpool: ['blackpool'],
  bolton: ['bolton', 'bolton wanderers'],
  bournemouth: ['bournemouth', 'afc bournemouth'],
  bradford: ['bradford', 'bradford city'],
  brentford: ['brentford'],
  brighton: ['brighton', 'brighton and hove albion', 'brighton hove albion'],
  burnley: ['burnley'],
  cardiff: ['cardiff', 'cardiff city'],
  charlton: ['charlton', 'charlton athletic'],
  chelsea: ['chelsea'],
  coventry: ['coventry', 'coventry city'],
  'crystal palace': ['crystal palace', 'palace'],
  derby: ['derby', 'derby county'],
  everton: ['everton'],
  fulham: ['fulham'],
  huddersfield: ['huddersfield', 'huddersfield town'],
  hull: ['hull', 'hull city'],
  ipswich: ['ipswich', 'ipswich town'],
  leeds: ['leeds', 'leeds united'],
  leicester: ['leicester', 'leicester city'],
  liverpool: ['liverpool'],
  luton: ['luton', 'luton town'],
  'man city': ['man city', 'manchester city'],
  'man united': ['man united', 'man utd', 'manchester united', 'manchester utd'],
  middlesbrough: ['middlesbrough', 'boro'],
  newcastle: ['newcastle', 'newcastle united'],
  norwich: ['norwich', 'norwich city'],
  'nottingham forest': ['nottingham forest', 'nottm forest', 'notts forest', 'forest'],
  oldham: ['oldham', 'oldham athletic'],
  portsmouth: ['portsmouth'],
  qpr: ['qpr', 'queens park rangers'],
  reading: ['reading'],
  'sheffield united': ['sheffield united', 'sheffield utd', 'sheff united', 'sheff utd'],
  'sheffield wednesday': ['sheffield wednesday', 'sheffield weds', 'sheff wed', 'sheff wednesday'],
  southampton: ['southampton'],
  stoke: ['stoke', 'stoke city'],
  sunderland: ['sunderland'],
  swansea: ['swansea', 'swansea city'],
  swindon: ['swindon', 'swindon town'],
  tottenham: ['tottenham', 'tottenham hotspur', 'spurs'],
  watford: ['watford'],
  'west brom': ['west brom', 'west bromwich', 'west bromwich albion'],
  'west ham': ['west ham', 'west ham united'],
  wigan: ['wigan', 'wigan athletic'],
  wimbledon: ['wimbledon'],
  wolves: ['wolves', 'wolverhampton', 'wolverhampton wanderers'],
};

const LOOKUP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  for (const alias of aliases) LOOKUP.set(alias, canonical);
}

/**
 * Strip the decoration that differs between the two sources but never
 * distinguishes two clubs: accents, punctuation, and the FC/AFC affixes.
 *
 * Deliberately does *not* strip descriptive suffixes like "United" or "City" —
 * that would collapse Manchester United into Manchester City.
 */
function simplify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Apostrophes elide rather than separate: "Nott'm Forest" is one word
    // short of "Nottingham", not three words.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(a?fc)\s+/, '')
    .replace(/\s+(a?fc)$/, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Fold a club name onto its canonical key, or null when it is not a name we
 * know. Null is meaningful: it means the historical table cannot be trusted
 * for this match, so the caller should fall back rather than guess.
 */
export function canonicalTeam(name: string): string | null {
  const simplified = simplify(name);
  if (!simplified) return null;
  return LOOKUP.get(simplified) ?? null;
}
