// The docs claim what the code does. Run before every build (`npm run build`), so a page that
// names a setting, a default, a reason code or a kind the code does not have fails the build.
//
// It reads the service's source, one directory up from docs-site/, as the landing page does:
//   apps/dispatch/src/config.ts           every setting, its range and its default
//   apps/dispatch/src/placement/index.ts  the policy name, every filter's reason code, the
//                                          reasons nobody is chosen
//   apps/dispatch/src/store/index.ts      the outcomes
//   apps/dispatch/src/placement/suggest.ts, supply.ts  the suggestion and proposal kinds
// and checks the pages under src/content/docs against them. Every page needs a title and a
// description too. No dependencies: Node alone.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(fileURLToPath(import.meta.url), '../..');
const src = resolve(site, '../apps/dispatch/src');
const docsDir = join(site, 'src/content/docs');
const read = (p) => readFileSync(p, 'utf8');

const problems = [];
const fail = (msg) => problems.push(msg);

// ---- the code ---------------------------------------------------------------------------------

const config = read(join(src, 'config.ts'));
const flat = config.replace(/\s+/g, ' ');
const placement = read(join(src, 'placement/index.ts'));
const store = read(join(src, 'store/index.ts'));
const suggest = read(join(src, 'placement/suggest.ts'));
const supply = read(join(src, 'placement/supply.ts'));
const routeIndex = read(join(src, 'routes/index.ts'));
const routeOperator = read(join(src, 'routes/operator.ts'));
const routeLearned = read(join(src, 'routes/learned.ts'));
const routeRelay = read(join(src, 'routes/relay.ts'));

/** The string literals of `export const NAME = [ ... ]` (comments dropped). */
function listOf(source, name) {
  const m = source.match(new RegExp(`export const ${name}\\b[^=]*= \\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`check-claims: no ${name} in the source`);
  return [...m[1].replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** `export const DEFAULT_X(: T)? = <literal>;`, by name. */
const defaults = new Map(
  [...config.matchAll(/export const (DEFAULT_[A-Z_]+)(?::[^=]+)? = ("[^"]*"|[\d_]+);/g)].map((m) => [
    m[1],
    m[2].startsWith('"') ? m[2].slice(1, -1) : m[2].replace(/_/g, ''),
  ]),
);

/** Every setting the service reads: a quoted name, or `env.NAME`. */
const settingNames = new Set([
  ...[...config.matchAll(/"((?:SUPERDISPATCH|SUPERWITNESS|SUPERPIPELINE|AGENTPOD|ORG_PLANE|TREATY_RELAY)_[A-Z0-9_]+)"/g)].map((m) => m[1]),
  ...[...config.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
]);
if (settingNames.size < 25) fail(`read only ${settingNames.size} settings from config.ts`);
const required = new Set(listOf(config, 'REQUIRED'));

/** Whole-number settings: name, default, min, max. */
const ranged = [...flat.matchAll(/"([A-Z_]+)", (DEFAULT_[A-Z_]+), ([\d_]+), ([\d_]+),/g)].map((m) => ({
  name: m[1],
  def: defaults.get(m[2]),
  min: m[3].replace(/_/g, ''),
  max: m[4].replace(/_/g, ''),
}));
/** One-of settings: name, allowed values, default. */
const enums = [...flat.matchAll(/"([A-Z_]+)", ([A-Z_]+), (DEFAULT_[A-Z_]+)/g)].map((m) => ({
  name: m[1],
  values: listOf(config, m[2]),
  def: defaults.get(m[3]),
}));
// Two one-of settings are read by hand rather than through the helper.
for (const [name, list, def] of [
  ['SUPERDISPATCH_FAIRNESS', 'FAIRNESS', 'DEFAULT_FAIRNESS'],
  ['SUPERDISPATCH_CANDIDATES', 'CANDIDATE_SETS', 'DEFAULT_CANDIDATE_SET'],
]) {
  if (!config.includes(`env.${name}`)) fail(`config.ts no longer reads ${name} by hand; update check-claims`);
  enums.push({ name, values: listOf(config, list), def: defaults.get(def) });
}
if (ranged.length < 14) fail(`read only ${ranged.length} ranged settings from config.ts`);

const POLICY = placement.match(/export const POLICY = "([^"]+)"/)?.[1];
const filtersBlock = placement.match(/export const FILTERS = \{([\s\S]*?)\n\} as const/)?.[1] ?? '';
const REASONS = [...filtersBlock.matchAll(/^\s+([a-zA-Z]+): "([a-z-]+)",/gm)].map((m) => ({ filter: m[1], reason: m[2] }));
const noDecision = placement.match(/export type NoDecisionReason =([\s\S]*?);\n/)?.[1] ?? '';
const NO_DECISION = [...noDecision.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
const OUTCOMES = listOf(store, 'OUTCOMES');
const SUGGESTION_KINDS = listOf(suggest, 'SUGGESTION_KINDS');
const LANE_RULES = listOf(suggest, 'LANE_RULES');
const SUPPLY_KINDS = listOf(supply, 'SUPPLY_KINDS');
const TIERS = listOf(placement, 'TIERS');

/** Public routes named by each handler's contract comment, normalised without query examples. */
const routeSources = [routeIndex, routeOperator, routeLearned, routeRelay];
const ROUTES = [...new Set(routeSources.flatMap((source) =>
  [...source.matchAll(/`(GET|POST|PUT|DELETE) (\/[^`]+)`/g)].map((m) => `${m[1]} ${m[2].split('?')[0]}`),
))].sort();
if (ROUTES.length < 15) fail(`read only ${ROUTES.length} routes from the route contracts`);
if (!POLICY) fail('found no POLICY in placement/index.ts');
if (REASONS.length < 15) fail(`read only ${REASONS.length} reason codes from FILTERS`);
if (NO_DECISION.length < 5) fail(`read only ${NO_DECISION.length} no-decision reasons`);

// ---- the pages --------------------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.mdx?$/.test(name) ? [p] : [];
  });
}
const pages = new Map(walk(docsDir).map((p) => [relative(docsDir, p), read(p)]));
const page = (name) => {
  const text = pages.get(name);
  if (text === undefined) throw new Error(`check-claims: no page ${name}`);
  return text;
};
const all = [...pages.values()].join('\n');
const has = (text, code) => text.includes('`' + code + '`');

for (const [name, text] of pages) {
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  if (!/^title: \S/m.test(front)) fail(`${name}: no title`);
  if (!/^description: \S/m.test(front)) fail(`${name}: no description`);
}

// Settings: every setting the code reads is on the settings page, and every setting-shaped name
// on any page is one the code reads (or another product's, named as such).
const OTHER_PRODUCTS = new Set(['ORG_PLANE_AUDIENCE', 'ROSTER_READERS', 'CATALOG_READERS', 'SUPERWITNESS_REPORT_STAGE']);
const settings = page('run/settings.md');
for (const name of settingNames) if (!has(settings, name)) fail(`run/settings.md does not list ${name}`);
for (const m of all.matchAll(/`((?:SUPERDISPATCH|SUPERWITNESS|SUPERPIPELINE|AGENTPOD|ORG_PLANE|TREATY_RELAY)_[A-Z0-9_]+|[A-Z]+_READERS)(?:=[^`]*)?`/g)) {
  if (!settingNames.has(m[1]) && !OTHER_PRODUCTS.has(m[1])) fail(`a page names ${m[1]}, which config.ts does not read`);
}
const rowOf = (name) => settings.split('\n').find((l) => l.startsWith('| `' + name + '`'));
for (const name of required) {
  const row = rowOf(name);
  if (!row) fail(`run/settings.md has no row for ${name}`);
  else if (settings.indexOf(row) > settings.indexOf('## Where it runs')) fail(`${name} is required but not listed under Required`);
}
for (const s of ranged) {
  const row = rowOf(s.name);
  if (!row) { fail(`run/settings.md has no row for ${s.name}`); continue; }
  if (!row.includes(`${s.min} to ${s.max}`)) fail(`${s.name}: the code's range is ${s.min} to ${s.max}`);
  if (!has(row, s.def)) fail(`${s.name}: the code's default is ${s.def}`);
}
for (const s of enums) {
  const row = rowOf(s.name);
  if (!row) { fail(`run/settings.md has no row for ${s.name}`); continue; }
  for (const v of s.values) if (!has(row, v)) fail(`${s.name}: the row does not name ${v}`);
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.at(-1) !== '`' + s.def + '`') fail(`${s.name}: the code's default is ${s.def}`);
}
if (!has(settings, defaults.get('DEFAULT_DATA_DIR'))) fail('run/settings.md: the data directory default');
if (!has(settings, defaults.get('DEFAULT_PORT'))) fail('run/settings.md: the port default');

// Routes: the operator API table is the route contracts, row for row. Query parameters stay in
// prose; the table names the stable path. This catches both a forgotten new route and a stale one.
const operatorApi = page('run/operator-api.md');
const documentedRoutes = [...operatorApi.matchAll(/^\| `(GET|POST|PUT|DELETE)`\s+\| `([^`]+)`/gm)]
  .map((m) => `${m[1]} ${m[2]}`)
  .sort();
if (JSON.stringify(documentedRoutes) !== JSON.stringify(ROUTES)) {
  fail(`run/operator-api.md's route table is not the route contracts:\n  page ${documentedRoutes.join(', ')}\n  code ${ROUTES.join(', ')}`);
}

// Filters: the table on the filters page is FILTERS, row for row, in order.
const filters = page('placement/filters.md');
const rows = [...filters.matchAll(/^\| `([a-zA-Z]+)`\s+\| `([a-z-]+)`/gm)].map((m) => ({ filter: m[1], reason: m[2] }));
if (JSON.stringify(rows) !== JSON.stringify(REASONS)) {
  fail(`placement/filters.md's table is not FILTERS in order:\n  page ${rows.map((r) => `${r.filter}:${r.reason}`).join(' ')}\n  code ${REASONS.map((r) => `${r.filter}:${r.reason}`).join(' ')}`);
}
// Every reason code on any page is one the code has.
const known = new Set([
  ...REASONS.map((r) => r.reason), ...NO_DECISION, ...OUTCOMES, ...SUGGESTION_KINDS, ...LANE_RULES, ...SUPPLY_KINDS, ...TIERS,
]);
for (const code of known) if (!has(all, code)) fail(`no page names \`${code}\``);
for (const r of REASONS) if (!has(filters, r.reason)) fail(`placement/filters.md does not name ${r.reason}`);
for (const r of NO_DECISION) if (!has(page('placement/overview.md'), r)) fail(`placement/overview.md does not name ${r}`);
for (const o of OUTCOMES) if (!has(page('records/decisions.md'), o)) fail(`records/decisions.md does not name ${o}`);
for (const k of [...SUGGESTION_KINDS, ...LANE_RULES]) if (!has(page('records/roster-suggestions.md'), k)) fail(`records/roster-suggestions.md does not name ${k}`);
for (const k of SUPPLY_KINDS) if (!has(page('records/supply-proposals.md'), k)) fail(`records/supply-proposals.md does not name ${k}`);
for (const p of ['placement/scoring.md', 'records/decisions.md']) if (!has(page(p), POLICY)) fail(`${p} does not name the policy ${POLICY}`);
for (const m of all.matchAll(/`(idle-[a-z-]+@\d+)/g)) if (m[1] !== POLICY) fail(`a page names the policy ${m[1]}; the code's is ${POLICY}`);

if (problems.length > 0) {
  console.error(`check-claims: ${problems.length} claim(s) the code does not back:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-claims: ${pages.size} pages; ${settingNames.size} settings, ${ROUTES.length} routes, ${REASONS.length} reason codes, ` +
    `${NO_DECISION.length} no-decision reasons, ${OUTCOMES.length} outcomes and ${SUGGESTION_KINDS.length + SUPPLY_KINDS.length} kinds match the code`,
);
