import './style.css';
import { parseLibrary, analyze, type Analysis, type Model, type ModelBump, type DriftCluster, type SchemaChange, DRIFT_THRESHOLD } from './library';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const val = (s: string) => ($(s) as HTMLTextAreaElement | HTMLInputElement).value;
const setVal = (s: string, v: string) => { ($(s) as HTMLTextAreaElement | HTMLInputElement).value = v; };
const propCount = (m: Model) => Object.keys(m.schema?.properties ?? {}).length;

let sampleLibrary = '', sampleSpecs = '';

init();
async function init() {
  wire();
  try {
    [sampleLibrary, sampleSpecs] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}sample-library.yaml`).then((r) => r.text()),
      fetch(`${import.meta.env.BASE_URL}sample-openapi.json`).then((r) => r.text()),
    ]);
    setVal('#library-text', sampleLibrary);
    setVal('#specs-text', sampleSpecs);
    run();
  } catch (e) { $('#report').innerHTML = `<div class="cov-error">Couldn't load samples. ${esc((e as Error).message)}</div>`; }
}

function wire() {
  $('#analyze').addEventListener('click', run);
  $('#load-sample').addEventListener('click', () => { setVal('#library-text', sampleLibrary); setVal('#specs-text', sampleSpecs); run(); });
  $('#up-library').addEventListener('click', () => $('#file-library').click());
  $('#up-specs').addEventListener('click', () => $('#file-specs').click());
  $('#file-library').addEventListener('change', (e) => readFile(e, '#library-text'));
  $('#file-specs').addEventListener('change', (e) => readFile(e, '#specs-text'));
  $('#dl-library').addEventListener('click', () => download('model-library.yaml', val('#library-text'), 'text/yaml'));
  $('#engage-ae').addEventListener('click', () => { location.href = 'mailto:info@apievangelist.com?subject=' + encodeURIComponent('API design governance — versioned model library'); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); about(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('about-modal')?.remove(); });
}

function readFile(e: Event, target: string) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { setVal(target, String(r.result)); run(); }; r.readAsText(f);
}

function run() {
  let a: Analysis;
  try {
    const lib = parseLibrary(val('#library-text'));
    a = analyze(lib, val('#specs-text'));
  } catch (e) { return err(`Couldn't analyze: ${(e as Error).message}`); }
  $('#status').innerHTML = `<b>${a.counts.versions}</b> versions · <b>${a.counts.consumers}</b> consumers · <b style="color:${a.counts.breaking ? 'var(--error)' : 'var(--ok)'}">${a.counts.breaking}</b> breaking · <b>${a.counts.driftClusters}</b> drift`;
  render(a);
}
function err(msg: string) { $('#report').innerHTML = `<div class="cov-error">${esc(msg)}</div>`; }

function render(a: Analysis) {
  const c = a.counts;
  $('#report').innerHTML = `
    <div class="hero">
      <div class="gauge">
        <div class="gauge-num" style="color:${c.breaking ? 'var(--error)' : 'var(--ok)'}">${c.breaking}</div>
        <div class="gauge-cap">breaking changes<br>across version bumps</div>
      </div>
      <div class="facts">
        <div class="fact"><b>${c.models}</b><span>models</span></div>
        <div class="fact"><b>${c.versions}</b><span>versions in library</span></div>
        <div class="fact"><b>${c.consumers}</b><span>consuming specs</span></div>
        <div class="fact okf"><b>${c.nonBreaking}</b><span>non-breaking changes</span></div>
        <div class="fact ${c.driftClusters ? 'warnf' : ''}"><b>${c.driftClusters}</b><span>drift clusters</span></div>
      </div>
    </div>
    <p class="hint small">A shared <strong>versioned model library</strong> is the design-governance primitive Spectral leaves out: define <code>User</code>, <code>Money</code>, or <code>Error</code> <strong>once</strong>, let every API <code>$ref</code> it, and when the model moves, know instantly whether the bump is <strong>breaking</strong> for its consumers — and where the same model has quietly forked into <strong>drift</strong>.</p>

    <div class="cols">
      <section class="panel">
        <h3>Models <span class="muted">(${c.versions})</span></h3>
        <p class="small">Every named schema in the library, with its semantic version, owner, and property count. Multiple rows for one name are versions to reconcile.</p>
        <div class="vlist">${a.models.map((m) => modelRow(m, a)).join('') || empty('No models in the library.')}</div>
      </section>
      <section class="panel">
        <h3>Change propagation <span class="muted">(${a.bumps.length})</span></h3>
        <p class="small">Each version bump, classified property-by-property and propagated to the specs that <code>$ref</code> the model.</p>
        <div class="vlist">${a.bumps.map(bumpRow).join('') || empty('No version bumps — every model has a single version.')}</div>
      </section>
    </div>

    <section class="panel drift-panel">
      <h3>Drift &amp; dedup <span class="muted">(${a.drift.length})</span></h3>
      <p class="small">Near-duplicate model variants — same-ish name or property-set overlap (Jaccard ≥ ${DRIFT_THRESHOLD}) — across the library and the inline schemas your specs define. Each cluster is a candidate to collapse onto one library model.</p>
      <div class="drift-list">${a.drift.map(driftRow).join('') || empty('No drift detected — no near-duplicate models.')}</div>
    </section>`;
}

function empty(msg: string): string { return `<div class="empty muted small">${esc(msg)}</div>`; }

function modelRow(m: Model, a: Analysis): string {
  const consumers = a.specs.filter((s) => s.refs.includes(m.name)).length;
  return `<div class="vrow model"><span class="vstate ver">v${esc(m.version)}</span>
    <div class="vmain"><div class="vcode">${esc(m.name)}</div><div class="vpath">${propCount(m)} properties${m.owner ? ' · owner ' + esc(m.owner) : ''}${m.description ? ' · ' + esc(m.description) : ''}</div></div>
    <div class="vby">${consumers} consumer${consumers === 1 ? '' : 's'}</div></div>`;
}

function bumpRow(b: ModelBump): string {
  const breaking = b.breaking > 0;
  const state = breaking ? 'breaking' : 'safe';
  const consumers = b.consumers.length
    ? `<div class="bump-consumers">Affects ${b.consumers.length} consumer${b.consumers.length === 1 ? '' : 's'}: ${b.consumers.map((t) => `<b>${esc(t)}</b>`).join(', ')}</div>`
    : `<div class="bump-consumers muted">No consuming spec references this model.</div>`;
  return `<div class="vrow bump ${state}"><span class="vstate ${state}">${breaking ? 'breaking' : 'safe'}</span>
    <div class="vmain">
      <div class="vcode">${esc(b.name)} <span class="muted">v${esc(b.from)} → v${esc(b.to)}</span></div>
      <div class="changes">${b.changes.map(changeChip).join('')}</div>
      ${consumers}
    </div></div>`;
}

function changeChip(ch: SchemaChange): string {
  return `<div class="change ${ch.breaking ? 'brk' : 'ok'}"><span class="ck">${esc(ch.kind)}</span><span class="cp">${esc(ch.path)}</span><span class="cd">${esc(ch.detail)}</span></div>`;
}

function driftRow(d: DriftCluster): string {
  const sim = Math.round(d.similarity * 100);
  return `<div class="wr drift">
    <div class="wr-top"><span class="wr-id">${esc(d.key)}</span><span class="wr-rule">${d.members.length} variants</span>
      <span class="wr-status ${sim >= 100 ? 'permanent' : 'expiring'}">${sim}% overlap</span></div>
    <div class="drift-members">${d.members.map((m) => `<span class="dm"><b>${esc(m.label)}</b> <span class="muted">{${esc(m.props.join(', '))}}</span></span>`).join('')}</div>
  </div>`;
}

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function about() {
  const el = document.createElement('div');
  el.id = 'about-modal';
  el.innerHTML = `<div class="about-backdrop"></div><div class="about-card">
    <button class="detail-close" id="about-close">&times;</button>
    <h2>Define your models once, version them, and know what a change breaks</h2>
    <p>Spectral and its ilk lint one document at a time — they cannot tell you that forty APIs all define their own slightly-different <code>User</code>, or that bumping the shared <code>Money</code> model quietly breaks the three services that consume it. The missing primitive is a <strong>versioned model / design library</strong>: reusable named schemas with semantic versions that specs <code>$ref</code> instead of copy.</p>
    <p>This tool holds that library in your browser. Give it a <code>{ version, models[] }</code> file and the OpenAPI specs that reference your models, and it does three things: lists every <strong>model and version</strong>; runs a structural <strong>diff</strong> of each version bump and classifies every change as <strong>breaking</strong> (a removed/renamed required property, a narrowed type, a removed enum value) or <strong>non-breaking</strong> (an added optional property, an added enum value, a description edit), propagating the verdict to each consuming spec; and detects <strong>drift</strong> — near-duplicate models that should be collapsed onto one definition.</p>
    <p>It grew out of the State-of-Spectral research and a conversation with a Spectral maintainer about the capability governance tooling still misses: not another linter, but a place for the <em>models</em> themselves to live, version, and be reused.</p>
    <p class="muted small">Runs entirely in your browser. Nothing you paste leaves the page.</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#about-close')!.addEventListener('click', () => el.remove());
  el.querySelector('.about-backdrop')!.addEventListener('click', () => el.remove());
}
