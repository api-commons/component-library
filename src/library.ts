// The model-library model: parse a versioned library of reusable named JSON
// Schemas, parse the OpenAPI specs that consume them (by $ref or by an inline
// schema of the same name), structurally diff two schemas into categorized
// breaking / non-breaking changes, propagate a model version bump to every
// consumer, and detect near-duplicate model drift. Pure data — no DOM.
import { parse as parseYaml } from 'yaml';

// ---- types ------------------------------------------------------------------
export type JsonSchema = any;

export interface Model {
  name: string;
  version: string;
  schema: JsonSchema;
  description?: string;
  owner?: string;
}
export interface Library { version: string; models: Model[]; }

export interface SpecSummary {
  title: string;
  index: number;
  refs: string[];          // library model names referenced via $ref
  localSchemas: string[];  // names of schemas defined inline under components.schemas
}

export type ChangeKind =
  | 'property-added' | 'property-removed'
  | 'required-added' | 'required-removed'
  | 'type-narrowed' | 'type-changed'
  | 'enum-removed' | 'enum-added'
  | 'description-changed';

export interface SchemaChange {
  kind: ChangeKind;
  path: string;        // dotted property path, e.g. "properties.status"
  detail: string;      // human-readable summary
  breaking: boolean;
}

export interface ModelBump {
  name: string;
  from: string;
  to: string;
  changes: SchemaChange[];
  breaking: number;
  nonBreaking: number;
  consumers: string[]; // spec titles referencing this model
}

export interface SchemaInstance {
  id: string;
  label: string;    // display label
  source: string;   // "library" or spec title
  name: string;
  version?: string;
  props: string[];
  schema: JsonSchema;
}
export interface DriftCluster {
  key: string;
  members: SchemaInstance[];
  similarity: number; // min pairwise Jaccard within cluster
}

export interface Analysis {
  models: Model[];
  modelNames: string[];
  specs: SpecSummary[];
  bumps: ModelBump[];
  drift: DriftCluster[];
  counts: {
    models: number;      // distinct model names
    versions: number;    // total model versions
    consumers: number;   // specs referencing >=1 library model
    breaking: number;    // total breaking changes across bumps
    nonBreaking: number; // total non-breaking changes across bumps
    driftClusters: number;
  };
}

export const DRIFT_THRESHOLD = 0.6;

// ---- parse ------------------------------------------------------------------
function parseDoc(text: string): any {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return parseYaml(t); }
}

export function parseLibrary(text: string): Library {
  const doc = parseDoc(text);
  if (!doc) return { version: '0.1', models: [] };
  const raw = Array.isArray(doc) ? doc : doc.models;
  if (!Array.isArray(raw)) throw new Error('Expected a `models:` list.');
  const models = raw.map((m: any, i: number): Model => {
    if (!m || !m.name) throw new Error(`Model ${i + 1} is missing a "name".`);
    if (m.schema == null || typeof m.schema !== 'object') throw new Error(`Model "${m.name}" is missing a "schema".`);
    return {
      name: String(m.name),
      version: String(m.version ?? '0.0.0'),
      schema: m.schema,
      description: m.description != null ? String(m.description) : undefined,
      owner: m.owner != null ? String(m.owner) : undefined,
    };
  });
  return { version: String((Array.isArray(doc) ? undefined : doc.version) ?? '0.1'), models };
}

// Parse one-or-many OpenAPI documents. Accepts a single object, or a top-level
// array of documents. Extracts the library models each doc references and the
// schema names it defines inline.
export function parseSpecs(text: string, modelNames: string[]): SpecSummary[] {
  const doc = parseDoc(text);
  if (!doc) return [];
  const docs: any[] = Array.isArray(doc) ? doc : [doc];
  const known = new Set(modelNames);
  return docs.map((d, i) => {
    const title = String(d?.info?.title ?? d?.title ?? `Spec ${i + 1}`);
    const localSchemas = d?.components?.schemas && typeof d.components.schemas === 'object'
      ? Object.keys(d.components.schemas) : [];
    const refNames = collectRefs(d);
    const local = new Set(localSchemas);
    // A doc "references" a library model when it $refs it, or defines an inline
    // schema of the same name (an inline copy — itself a drift signal).
    const refs = [...new Set([...refNames, ...localSchemas])].filter((n) => known.has(n) && (refNames.has(n) || local.has(n)));
    return { title, index: i, refs, localSchemas };
  });
}

function collectRefs(node: any, acc = new Set<string>(), depth = 0): Set<string> {
  if (!node || typeof node !== 'object' || depth > 40) return acc;
  if (Array.isArray(node)) { node.forEach((n) => collectRefs(n, acc, depth + 1)); return acc; }
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') {
      const m = /^#\/components\/schemas\/([^/]+)/.exec(v);
      if (m) acc.add(decodeURIComponent(m[1].replace(/~1/g, '/').replace(/~0/g, '~')));
    } else if (v && typeof v === 'object') {
      collectRefs(v, acc, depth + 1);
    }
  }
  return acc;
}

// ---- schema helpers ---------------------------------------------------------
function typeSet(s: JsonSchema): string[] {
  if (!s || s.type == null) return [];
  return (Array.isArray(s.type) ? s.type : [s.type]).map(String).sort();
}
function isSubset(a: string[], b: string[]): boolean { return a.every((x) => b.includes(x)); }
function eqSet(a: string[], b: string[]): boolean { return a.length === b.length && isSubset(a, b); }
function props(s: JsonSchema): Record<string, JsonSchema> {
  return s && s.properties && typeof s.properties === 'object' ? s.properties : {};
}
function requiredSet(s: JsonSchema): Set<string> {
  return new Set(Array.isArray(s?.required) ? s.required.map(String) : []);
}

// ---- diffSchema -------------------------------------------------------------
// Structural diff of two JSON Schemas into categorized changes.
export function diffSchema(oldSchema: JsonSchema, newSchema: JsonSchema, base = ''): SchemaChange[] {
  const out: SchemaChange[] = [];
  const at = (p: string) => (base ? `${base}.${p}` : p);
  const here = base || '(root)';

  // description
  const od = oldSchema?.description, nd = newSchema?.description;
  if (od !== nd && (od != null || nd != null)) {
    out.push({ kind: 'description-changed', path: here, detail: 'description changed', breaking: false });
  }

  // type
  const ot = typeSet(oldSchema), nt = typeSet(newSchema);
  if (ot.length && nt.length && !eqSet(ot, nt)) {
    if (isSubset(nt, ot)) {
      out.push({ kind: 'type-narrowed', path: here, detail: `type narrowed ${fmt(ot)} → ${fmt(nt)}`, breaking: true });
    } else if (isSubset(ot, nt)) {
      out.push({ kind: 'type-changed', path: here, detail: `type widened ${fmt(ot)} → ${fmt(nt)}`, breaking: false });
    } else {
      out.push({ kind: 'type-changed', path: here, detail: `type changed ${fmt(ot)} → ${fmt(nt)}`, breaking: true });
    }
  }

  // enum
  const oe: any[] = Array.isArray(oldSchema?.enum) ? oldSchema.enum : [];
  const ne: any[] = Array.isArray(newSchema?.enum) ? newSchema.enum : [];
  if (oe.length || ne.length) {
    const removed = oe.filter((x) => !ne.some((y) => y === x));
    const added = ne.filter((x) => !oe.some((y) => y === x));
    if (removed.length) out.push({ kind: 'enum-removed', path: here, detail: `enum values removed: ${removed.map(String).join(', ')}`, breaking: true });
    if (added.length) out.push({ kind: 'enum-added', path: here, detail: `enum values added: ${added.map(String).join(', ')}`, breaking: false });
  }

  // properties
  const op = props(oldSchema), np = props(newSchema);
  const oReq = requiredSet(oldSchema), nReq = requiredSet(newSchema);
  const allKeys = new Set([...Object.keys(op), ...Object.keys(np)]);
  for (const key of allKeys) {
    const inOld = key in op, inNew = key in np;
    if (inOld && !inNew) {
      const req = oReq.has(key);
      out.push({ kind: 'property-removed', path: at(`properties.${key}`), detail: `${req ? 'required ' : 'optional '}property "${key}" removed`, breaking: req });
    } else if (!inOld && inNew) {
      const req = nReq.has(key);
      out.push({ kind: 'property-added', path: at(`properties.${key}`), detail: `${req ? 'required ' : 'optional '}property "${key}" added`, breaking: req });
    } else {
      // shared property — required transition
      if (!oReq.has(key) && nReq.has(key)) out.push({ kind: 'required-added', path: at(`properties.${key}`), detail: `property "${key}" is now required`, breaking: true });
      if (oReq.has(key) && !nReq.has(key)) out.push({ kind: 'required-removed', path: at(`properties.${key}`), detail: `property "${key}" is no longer required`, breaking: false });
      out.push(...diffSchema(op[key], np[key], at(`properties.${key}`)));
    }
  }

  // array items
  if (oldSchema?.items && newSchema?.items && typeof oldSchema.items === 'object' && typeof newSchema.items === 'object') {
    out.push(...diffSchema(oldSchema.items, newSchema.items, at('items')));
  }
  return out;
}
function fmt(t: string[]): string { return t.length === 1 ? t[0] : `[${t.join(', ')}]`; }

export function isBreaking(changes: SchemaChange[]): boolean { return changes.some((c) => c.breaking); }

// ---- version compare --------------------------------------------------------
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- drift / dedup ----------------------------------------------------------
function propNames(s: JsonSchema): string[] { return Object.keys(props(s)); }
function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  if (!sa.size && !sb.size) return 1;
  let inter = 0; sa.forEach((x) => { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}
function normName(n: string): string {
  return n.toLowerCase().replace(/[_\s-]+/g, '').replace(/v?\d+$/, '');
}

export function detectDrift(models: Model[], specs: SpecSummary[], specDoc: any, threshold = DRIFT_THRESHOLD): DriftCluster[] {
  const insts: SchemaInstance[] = [];
  models.forEach((m) => insts.push({
    id: `library:${m.name}@${m.version}`, label: `${m.name} v${m.version}`, source: 'library',
    name: m.name, version: m.version, props: propNames(m.schema), schema: m.schema,
  }));
  const docs: any[] = Array.isArray(specDoc) ? specDoc : specDoc ? [specDoc] : [];
  specs.forEach((sp) => {
    const schemas = docs[sp.index]?.components?.schemas ?? {};
    for (const name of sp.localSchemas) {
      const sc = schemas[name];
      if (sc && typeof sc === 'object') insts.push({
        id: `${sp.title}:${name}`, label: `${name} · ${sp.title}`, source: sp.title,
        name, props: propNames(sc), schema: sc,
      });
    }
  });

  // union-find over pairs that are near-duplicates (name or structure)
  const parent = insts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  const sims: Record<string, number> = {};
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      const j2 = jaccard(insts[i].props, insts[j].props);
      const sameName = normName(insts[i].name) === normName(insts[j].name);
      if (sameName || j2 >= threshold) {
        union(i, j);
        const k = `${find(i)}`; sims[k] = Math.min(sims[k] ?? 1, j2);
      }
    }
  }
  const groups = new Map<number, SchemaInstance[]>();
  insts.forEach((inst, i) => {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(inst);
  });
  const clusters: DriftCluster[] = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    // minimum pairwise similarity across the cluster
    let minSim = 1;
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        minSim = Math.min(minSim, jaccard(members[i].props, members[j].props));
    clusters.push({ key: members[0].name, members, similarity: sims[`${root}`] != null ? Math.min(minSim, sims[`${root}`]) : minSim });
  }
  clusters.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  return clusters;
}

// ---- top-level analyze ------------------------------------------------------
export function analyze(library: Library, specText: string): Analysis {
  const models = library.models;
  const names = [...new Set(models.map((m) => m.name))].sort();
  const specDoc = parseDoc(specText);
  const specs = specText.trim() ? parseSpecs(specText, names) : [];

  // consumers per model name
  const consumersOf = (name: string) => specs.filter((s) => s.refs.includes(name)).map((s) => s.title);

  // version bumps: for each model name with >=2 versions, diff each consecutive pair
  const bumps: ModelBump[] = [];
  for (const name of names) {
    const versions = models.filter((m) => m.name === name).sort((a, b) => compareVersions(a.version, b.version));
    for (let i = 1; i < versions.length; i++) {
      const from = versions[i - 1], to = versions[i];
      const changes = diffSchema(from.schema, to.schema);
      if (!changes.length) continue;
      bumps.push({
        name, from: from.version, to: to.version, changes,
        breaking: changes.filter((c) => c.breaking).length,
        nonBreaking: changes.filter((c) => !c.breaking).length,
        consumers: consumersOf(name),
      });
    }
  }

  const drift = detectDrift(models, specs, specDoc);
  const consumers = specs.filter((s) => s.refs.length > 0).length;

  return {
    models, modelNames: names, specs, bumps, drift,
    counts: {
      models: names.length,
      versions: models.length,
      consumers,
      breaking: bumps.reduce((n, b) => n + b.breaking, 0),
      nonBreaking: bumps.reduce((n, b) => n + b.nonBreaking, 0),
      driftClusters: drift.length,
    },
  };
}
