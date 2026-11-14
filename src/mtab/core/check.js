// Validation of manifest.json and sync files, written by hand so the core needs no JSON Schema library (a schema
// compiler needs code generation, which a strict Content-Security-Policy blocks). The schemas in ../../../../schema are
// the normative form; test/schema.test.js checks that this code and the schemas agree on every example and invalid case.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))(?!.*\/\/)(?!.*\\)[^\u0000-\u001f]+$/u;
const TUNING = /^[A-G][#b]?(-?[0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const YT = /^[A-Za-z0-9_-]{11}$/;

export const ANCHOR = { gp3: 'bar', gp4: 'bar', gp5: 'bar', gp: 'bar', gpx: 'bar', pdf: 'pdf', txt: 'text' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = Number.isInteger;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';

function ctx(errs, base) {
  return (path, ok, msg) => { if (!ok) errs.push(`${base}${path}: ${msg}`); return ok; };
}

function checkSource(s, at, ck) {
  if (!ck(at, isObj(s), 'must be an object')) return;
  ck(`${at}/type`, isStr(s.type) && s.type.length > 0, 'must be a non-empty string');
  if ('id' in s) ck(`${at}/id`, isStr(s.id) && ID.test(s.id), 'must be an id');
  if ('offsetMs' in s) ck(`${at}/offsetMs`, isNum(s.offsetMs), 'must be a number');
  if ('durationMs' in s) ck(`${at}/durationMs`, isNum(s.durationMs) && s.durationMs >= 0, 'must be a number >= 0');
  if ('sha256' in s) ck(`${at}/sha256`, isStr(s.sha256) && SHA.test(s.sha256), 'must be lowercase hex sha256');
  if ('derivedFrom' in s) ck(`${at}/derivedFrom`, isStr(s.derivedFrom) && ID.test(s.derivedFrom), 'must be an id');
  if (s.type === 'file') {
    ck(`${at}/path`, isStr(s.path) && PATH.test(s.path), 'is required and must be an archive path');
    if ('mime' in s) ck(`${at}/mime`, isStr(s.mime), 'must be a string');
  } else if (s.type === 'youtube') {
    ck(`${at}/videoId`, isStr(s.videoId) && YT.test(s.videoId), 'is required and must be 11 characters of A-Z a-z 0-9 _ -');
  } else if (s.type === 'url') {
    ck(`${at}/url`, isStr(s.url) && s.url.startsWith('https://'), 'is required and must start with https://');
    if ('mime' in s) ck(`${at}/mime`, isStr(s.mime), 'must be a string');
  }
}

function checkRecording(r, at, ck) {
  if (!ck(at, isObj(r), 'must be an object')) return;
  ck(`${at}/id`, isStr(r.id) && ID.test(r.id), 'is required and must be an id');
  ck(`${at}/role`, isStr(r.role) && r.role.length > 0, 'is required and must be a non-empty string');
  if ('label' in r) ck(`${at}/label`, isStr(r.label), 'must be a string');
  if (ck(`${at}/sources`, Array.isArray(r.sources), 'is required and must be an array')) r.sources.forEach((s, i) => checkSource(s, `${at}/sources/${i}`, ck));
  if ('sync' in r) ck(`${at}/sync`, isStr(r.sync) && PATH.test(r.sync), 'must be an archive path');
  if ('syncFrom' in r) ck(`${at}/syncFrom`, isStr(r.syncFrom) && ID.test(r.syncFrom), 'must be an id');
  if ('syncOffsetMs' in r) ck(`${at}/syncOffsetMs`, isInt(r.syncOffsetMs), 'must be an integer');
  if ('stemOf' in r) ck(`${at}/stemOf`, isStr(r.stemOf) && ID.test(r.stemOf), 'must be an id');
  if ('stemsComplete' in r) ck(`${at}/stemsComplete`, typeof r.stemsComplete === 'boolean', 'must be a boolean');
  if ('stem' in r && ck(`${at}/stem`, isObj(r.stem), 'must be an object')) {
    const st = r.stem;
    if ('instrument' in st) ck(`${at}/stem/instrument`, isStr(st.instrument), 'must be a string');
    if ('track' in st) ck(`${at}/stem/track`, isInt(st.track) && st.track >= 0, 'must be an integer >= 0');
    if ('trackName' in st) ck(`${at}/stem/trackName`, isStr(st.trackName), 'must be a string');
  }
  if ('stemOf' in r) ck(`${at}/role`, r.role === 'stem', 'must be "stem" when stemOf is present');
  if ('syncOffsetMs' in r) ck(`${at}`, 'syncFrom' in r, 'syncOffsetMs requires syncFrom');
  if ('sync' in r) ck(`${at}`, !('syncOffsetMs' in r), 'sync and syncOffsetMs cannot be used together');
}

/** Structure errors in a manifest, as strings. Empty when the manifest matches schema/manifest.schema.json. */
export function manifestSchemaErrors(m) {
  const errs = [], ck = ctx(errs, '');
  if (!ck('<root>', isObj(m), 'must be an object')) return errs;
  ck('/format', m.format === 'mtab', 'must be "mtab"');
  ck('/version', m.version === 1, 'must be 1');
  ck('/tab', 'tab' in m, 'is required');
  if ('createdAt' in m) ck('/createdAt', isStr(m.createdAt) && DATE.test(m.createdAt), 'must be a date-time');
  if ('generator' in m && ck('/generator', isObj(m.generator), 'must be an object')) {
    ck('/generator/name', isStr(m.generator.name) && m.generator.name.length > 0, 'is required and must be a non-empty string');
    if ('version' in m.generator) ck('/generator/version', isStr(m.generator.version), 'must be a string');
  }
  if ('song' in m && ck('/song', isObj(m.song), 'must be an object')) {
    const s = m.song;
    for (const k of ['title', 'artist', 'composer', 'album']) if (k in s) ck(`/song/${k}`, isStr(s[k]), 'must be a string');
    if ('year' in s) ck('/song/year', isInt(s.year), 'must be an integer');
    for (const k of ['trackNumber', 'mediumNumber', 'length']) if (k in s) ck(`/song/${k}`, isInt(s[k]) && s[k] >= 0, 'must be an integer >= 0');
    if ('ids' in s && ck('/song/ids', isObj(s.ids), 'must be an object')) {
      if ('isrc' in s.ids) ck('/song/ids/isrc', isStr(s.ids.isrc), 'must be a string');
      const mb = s.ids.musicbrainz;
      if ('musicbrainz' in s.ids && ck('/song/ids/musicbrainz', isObj(mb), 'must be an object'))
        for (const k of ['recording', 'artist', 'release', 'releaseGroup']) if (k in mb) ck(`/song/ids/musicbrainz/${k}`, isStr(mb[k]) && UUID.test(mb[k]), 'must be a UUID');
    }
  }
  if ('tab' in m && ck('/tab', isObj(m.tab), 'must be an object')) {
    const t = m.tab;
    const hasPath = 'path' in t, hasExt = 'externalPath' in t;
    ck('/tab', hasPath !== hasExt, 'must have either path or externalPath, not both');
    if (hasPath) ck('/tab/path', isStr(t.path) && PATH.test(t.path), 'must be an archive path');
    if (hasExt) ck('/tab/externalPath', isStr(t.externalPath) && PATH.test(t.externalPath), 'must be a relative path');
    ck('/tab/format', isStr(t.format) && t.format in ANCHOR, 'is required and must be one of gp3, gp4, gp5, gp, gpx, pdf, txt');
    if ((hasExt || 'startPage' in t || 'endPage' in t) && 'format' in t)
      ck('/tab/format', t.format === 'pdf', 'must be "pdf" when externalPath, startPage or endPage is present');
    ck('/tab/sha256', isStr(t.sha256) && SHA.test(t.sha256), 'is required and must be lowercase hex sha256');
    if ('name' in t) ck('/tab/name', isStr(t.name), 'must be a string');
    if ('pages' in t) ck('/tab/pages', isInt(t.pages) && t.pages >= 1, 'must be an integer >= 1');
    if ('startPage' in t) ck('/tab/startPage', isInt(t.startPage) && t.startPage >= 1, 'must be an integer >= 1');
    if ('endPage' in t) ck('/tab/endPage', isInt(t.endPage) && t.endPage >= 1, 'must be an integer >= 1');
    if ('tuning' in t) ck('/tab/tuning', Array.isArray(t.tuning) && t.tuning.length >= 1 && t.tuning.every((n) => isStr(n) && TUNING.test(n)), 'must be a non-empty array of pitch names');
  }
  if ('recordings' in m && ck('/recordings', Array.isArray(m.recordings), 'must be an array')) m.recordings.forEach((r, i) => checkRecording(r, `/recordings/${i}`, ck));
  if ('defaultRecording' in m) ck('/defaultRecording', isStr(m.defaultRecording) && ID.test(m.defaultRecording), 'must be an id');
  return errs;
}

/** Rules a JSON Schema cannot express: unique ids, references, sync chains, cross-field page bounds. */
export function manifestRuleErrors(m) {
  const errs = [], recs = m.recordings || [], t = m.tab || {};
  if ('startPage' in t && 'endPage' in t && t.endPage < t.startPage) errs.push('tab.endPage must be >= tab.startPage');
  if ('pages' in t && 'startPage' in t && t.startPage > t.pages) errs.push('tab.startPage exceeds tab.pages');
  if ('pages' in t && 'endPage' in t && t.endPage > t.pages) errs.push('tab.endPage exceeds tab.pages');
  const ids = recs.map((r) => r.id);
  if (new Set(ids).size !== ids.length) errs.push('duplicate recording ids');
  for (const r of recs) {
    for (const k of ['syncFrom', 'stemOf']) if (k in r && !ids.includes(r[k])) errs.push(`${r.id}.${k} names unknown recording ${r[k]}`);
    const sids = (r.sources || []).filter((s) => 'id' in s).map((s) => s.id);
    if (new Set(sids).size !== sids.length) errs.push(`${r.id}: duplicate source ids`);
    for (const s of r.sources || []) if ('derivedFrom' in s && !sids.includes(s.derivedFrom)) errs.push(`${r.id}: derivedFrom names unknown source ${s.derivedFrom}`);
    if ((r.sources || []).filter((s) => s.type === 'embedded').length > 1) errs.push(`${r.id}: more than one embedded source`);
  }
  for (const r of recs) {
    const seen = new Set([r.id]);
    let cur = r;
    while (!cur.sync && (cur.syncFrom || cur.stemOf)) {
      const next = recs.find((x) => x.id === (cur.syncFrom || cur.stemOf));
      if (!next) break;
      if (seen.has(next.id)) { errs.push(`sync reference cycle at ${next.id}`); break; }
      seen.add(next.id); cur = next;
    }
  }
  if ('defaultRecording' in m && !ids.includes(m.defaultRecording)) errs.push('defaultRecording names unknown recording');
  return errs;
}

export function validateManifest(m) {
  const errs = manifestSchemaErrors(m);
  return errs.length ? errs : manifestRuleErrors(m);
}

const barPoint = (p, at, ck) => {
  ck(`${at}/bar`, isInt(p.bar) && p.bar >= 0, 'is required and must be an integer >= 0');
  if ('occurrence' in p) ck(`${at}/occurrence`, isInt(p.occurrence) && p.occurrence >= 0, 'must be an integer >= 0');
  if ('pos' in p) ck(`${at}/pos`, isNum(p.pos) && p.pos >= 0 && p.pos <= 1, 'must be a number from 0 to 1');
};
const unit = (v) => isNum(v) && v >= 0 && v <= 1;
const pdfPoint = (p, at, ck) => {
  ck(`${at}/page`, isInt(p.page) && p.page >= 1, 'is required and must be an integer >= 1');
  if ('x' in p) ck(`${at}/x`, unit(p.x), 'must be a number from 0 to 1');
  if ('y' in p) ck(`${at}/y`, unit(p.y), 'must be a number from 0 to 1');
  if ('x' in p) ck(at, 'y' in p, 'x requires y');
  if ('y' in p) ck(at, 'x' in p, 'y requires x');
};
const textPoint = (p, at, ck) => {
  ck(`${at}/line`, isInt(p.line) && p.line >= 0, 'is required and must be an integer >= 0');
  if ('col' in p) ck(`${at}/col`, isInt(p.col) && p.col >= 0, 'must be an integer >= 0');
};
const POINT = { bar: barPoint, pdf: pdfPoint, text: textPoint };

/** Structure errors in a sync file, as strings. Empty when it matches schema/sync.schema.json. */
export function syncSchemaErrors(s) {
  const errs = [], ck = ctx(errs, '');
  if (!ck('<root>', isObj(s), 'must be an object')) return errs;
  ck('/version', s.version === 1, 'must be 1');
  ck('/recording', isStr(s.recording) && ID.test(s.recording), 'is required and must be an id');
  ck('/anchorType', s.anchorType in POINT, 'is required and must be bar, pdf or text');
  if ('updatedAt' in s) ck('/updatedAt', isStr(s.updatedAt) && DATE.test(s.updatedAt), 'must be a date-time');
  if (ck('/points', Array.isArray(s.points), 'is required and must be an array')) {
    s.points.forEach((p, i) => {
      const at = `/points/${i}`;
      if (!ck(at, isObj(p), 'must be an object')) return;
      ck(`${at}/timeMs`, isNum(p.timeMs) && p.timeMs >= 0, 'is required and must be a number >= 0');
      if ('source' in p) ck(`${at}/source`, ['tap', 'manual', 'auto'].includes(p.source), 'must be tap, manual or auto');
      if ('id' in p) ck(`${at}/id`, isStr(p.id), 'must be a string');
      if (s.anchorType in POINT) POINT[s.anchorType](p, at, ck);
    });
  }
  return errs;
}

export function syncRuleErrors(s, tabFormat) {
  const errs = [], t = s.points.map((p) => p.timeMs);
  if (t.some((v, i) => i && v <= t[i - 1])) errs.push('timeMs not strictly increasing');
  if (tabFormat && ANCHOR[tabFormat] !== s.anchorType) errs.push(`anchorType ${s.anchorType} does not match tab format ${tabFormat}`);
  return errs;
}

export function validateSync(s, tabFormat) {
  const errs = syncSchemaErrors(s);
  return errs.length ? errs : syncRuleErrors(s, tabFormat);
}
