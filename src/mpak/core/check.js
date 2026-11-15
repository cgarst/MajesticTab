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

export const ANCHOR = {
  gp3: 'bar', gp4: 'bar', gp5: 'bar', gp: 'bar', gpx: 'bar', musicxml: 'bar', mxl: 'bar', mscz: 'bar',
  midi: 'tick', abc: 'text', alphatex: 'bar', pdf: 'pdf', txt: 'text',
};

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
  if (s.type === 'embedded') {
    if ('score' in s) ck(`${at}/score`, isStr(s.score) && ID.test(s.score), 'must be a score id');
  } else if (s.type === 'file') {
    ck(`${at}/path`, isStr(s.path) && PATH.test(s.path), 'is required and must be an archive path');
    if ('mime' in s) ck(`${at}/mime`, isStr(s.mime), 'must be a string');
  } else if (s.type === 'youtube') {
    ck(`${at}/videoId`, isStr(s.videoId) && YT.test(s.videoId), 'is required and must be 11 characters of A-Z a-z 0-9 _ -');
  } else if (s.type === 'url') {
    ck(`${at}/url`, isStr(s.url) && /^https?:\/\//.test(s.url), 'is required and must start with http:// or https://');
    if ('mime' in s) ck(`${at}/mime`, isStr(s.mime), 'must be a string');
  }
}

function checkRecording(r, at, ck) {
  if (!ck(at, isObj(r), 'must be an object')) return;
  ck(`${at}/id`, isStr(r.id) && ID.test(r.id), 'is required and must be an id');
  ck(`${at}/role`, isStr(r.role) && r.role.length > 0, 'is required and must be a non-empty string');
  if ('label' in r) ck(`${at}/label`, isStr(r.label), 'must be a string');
  if (ck(`${at}/sources`, Array.isArray(r.sources), 'is required and must be an array')) r.sources.forEach((s, i) => checkSource(s, `${at}/sources/${i}`, ck));
  if ('sync' in r && ck(`${at}/sync`, isObj(r.sync), 'must be an object mapping score ids to archive paths'))
    for (const [k, v] of Object.entries(r.sync)) {
      ck(`${at}/sync/${k}`, ID.test(k), 'the key must be a score id');
      ck(`${at}/sync/${k}`, isStr(v) && PATH.test(v), 'must be an archive path');
    }
  if ('syncFrom' in r) ck(`${at}/syncFrom`, isStr(r.syncFrom) && ID.test(r.syncFrom), 'must be an id');
  if ('syncOffsetMs' in r) ck(`${at}/syncOffsetMs`, isInt(r.syncOffsetMs), 'must be an integer');
  if ('beats' in r) ck(`${at}/beats`, isStr(r.beats) && PATH.test(r.beats), 'must be an archive path');
  if ('without' in r) ck(`${at}/without`, Array.isArray(r.without) && r.without.every((x) => isStr(x) && ID.test(x)) && new Set(r.without).size === r.without.length, 'must be an array of distinct ids');
  if ('stemOf' in r) ck(`${at}/stemOf`, isStr(r.stemOf) && ID.test(r.stemOf), 'must be an id');
  if ('stemsComplete' in r) ck(`${at}/stemsComplete`, typeof r.stemsComplete === 'boolean', 'must be a boolean');
  if ('stem' in r && ck(`${at}/stem`, isObj(r.stem), 'must be an object')) {
    const st = r.stem;
    if ('instrument' in st) ck(`${at}/stem/instrument`, isStr(st.instrument), 'must be a string');
    if ('track' in st) ck(`${at}/stem/track`, isInt(st.track) && st.track >= 0, 'must be an integer >= 0');
    if ('trackName' in st) ck(`${at}/stem/trackName`, isStr(st.trackName), 'must be a string');
  }
  if ('scoreTracks' in r && ck(`${at}/scoreTracks`, isObj(r.scoreTracks), 'must be an object mapping score ids to track lists'))
    for (const [k, v] of Object.entries(r.scoreTracks)) {
      const p = `${at}/scoreTracks/${k}`;
      ck(p, ID.test(k), 'the key must be a score id');
      if (!ck(p, isObj(v), 'must be an object')) continue;
      ck(p, ('omits' in v) !== ('only' in v), 'must have exactly one of omits and only');
      for (const f of ['omits', 'only'])
        if (f in v) ck(`${p}/${f}`, Array.isArray(v[f]) && v[f].every((n) => isInt(n) && n >= 0) && new Set(v[f]).size === v[f].length, 'must be an array of distinct integers >= 0');
      if ('names' in v) ck(`${p}/names`, Array.isArray(v.names) && v.names.every(isStr), 'must be an array of strings');
    }
  if ('stemOf' in r) ck(`${at}/role`, r.role === 'stem', 'must be "stem" when stemOf is present');
  if ('syncOffsetMs' in r) ck(`${at}`, 'syncFrom' in r, 'syncOffsetMs requires syncFrom');
}

function checkScore(t, at, ck) {
  if (!ck(at, isObj(t), 'must be an object')) return;
  ck(`${at}/id`, isStr(t.id) && ID.test(t.id), 'is required and must be an id');
  if ('label' in t) ck(`${at}/label`, isStr(t.label), 'must be a string');
  const hasPath = 'path' in t, hasExt = 'externalPath' in t;
  ck(at, hasPath !== hasExt, 'must have either path or externalPath, not both');
  if (hasPath) ck(`${at}/path`, isStr(t.path) && PATH.test(t.path), 'must be an archive path');
  if (hasExt) ck(`${at}/externalPath`, isStr(t.externalPath) && PATH.test(t.externalPath), 'must be a relative path');
  ck(`${at}/format`, isStr(t.format) && t.format in ANCHOR, `is required and must be one of ${Object.keys(ANCHOR).join(', ')}`);
  if ((hasExt || 'startPage' in t || 'endPage' in t) && 'format' in t)
    ck(`${at}/format`, t.format === 'pdf', 'must be "pdf" when externalPath, startPage or endPage is present');
  ck(`${at}/sha256`, isStr(t.sha256) && SHA.test(t.sha256), 'is required and must be lowercase hex sha256');
  if ('name' in t) ck(`${at}/name`, isStr(t.name), 'must be a string');
  if ('pages' in t) ck(`${at}/pages`, isInt(t.pages) && t.pages >= 1, 'must be an integer >= 1');
  if ('startPage' in t) ck(`${at}/startPage`, isInt(t.startPage) && t.startPage >= 1, 'must be an integer >= 1');
  if ('endPage' in t) ck(`${at}/endPage`, isInt(t.endPage) && t.endPage >= 1, 'must be an integer >= 1');
  if ('instruments' in t && ck(`${at}/instruments`, Array.isArray(t.instruments), 'must be an array')) {
    t.instruments.forEach((ins, i) => {
      const p = `${at}/instruments/${i}`;
      if (!ck(p, ins && typeof ins === 'object' && !Array.isArray(ins), 'must be an object')) return;
      if ('name' in ins) ck(`${p}/name`, isStr(ins.name) && ins.name.length >= 1, 'must be a non-empty string');
      if ('tuning' in ins) ck(`${p}/tuning`, Array.isArray(ins.tuning) && ins.tuning.length >= 1 && ins.tuning.every((n) => isStr(n) && TUNING.test(n)), 'must be a non-empty array of pitch names');
      if ('capo' in ins) ck(`${p}/capo`, isInt(ins.capo) && ins.capo >= 1, 'must be an integer >= 1');
    });
  }
}

/** Structure errors in a manifest, as strings. Empty when the manifest matches schema/manifest.schema.json. */
export function manifestSchemaErrors(m) {
  const errs = [], ck = ctx(errs, '');
  if (!ck('<root>', isObj(m), 'must be an object')) return errs;
  ck('/format', m.format === 'mpak', 'must be "mpak"');
  ck('/version', m.version === 1, 'must be 1');
  ck('/scores', 'scores' in m, 'is required');
  if ('createdAt' in m) ck('/createdAt', isStr(m.createdAt) && DATE.test(m.createdAt), 'must be a date-time');
  if ('generator' in m && ck('/generator', isObj(m.generator), 'must be an object')) {
    ck('/generator/name', isStr(m.generator.name) && m.generator.name.length > 0, 'is required and must be a non-empty string');
    if ('version' in m.generator) ck('/generator/version', isStr(m.generator.version), 'must be a string');
  }
  if ('song' in m && ck('/song', isObj(m.song), 'must be an object')) {
    const s = m.song;
    for (const k of ['title', 'artist', 'composer', 'album']) if (k in s) ck(`/song/${k}`, isStr(s[k]), 'must be a string');
    if ('year' in s) ck('/song/year', isInt(s.year), 'must be an integer');
    for (const k of ['genre', 'publisher']) if (k in s) ck(`/song/${k}`, isStr(s[k]), 'must be a string');
    for (const k of ['trackNumber', 'mediumNumber', 'length']) if (k in s) ck(`/song/${k}`, isInt(s[k]) && s[k] >= 0, 'must be an integer >= 0');
    if ('ids' in s && ck('/song/ids', isObj(s.ids), 'must be an object')) {
      if ('isrc' in s.ids) ck('/song/ids/isrc', isStr(s.ids.isrc), 'must be a string');
      const mb = s.ids.musicbrainz;
      if ('musicbrainz' in s.ids && ck('/song/ids/musicbrainz', isObj(mb), 'must be an object'))
        for (const k of ['recording', 'artist', 'release', 'releaseGroup']) if (k in mb) ck(`/song/ids/musicbrainz/${k}`, isStr(mb[k]) && UUID.test(mb[k]), 'must be a UUID');
    }
  }
  if ('scores' in m && ck('/scores', Array.isArray(m.scores) && m.scores.length >= 1, 'must be an array with at least one score')) {
    m.scores.forEach((t, i) => {
      checkScore(t, `/scores/${i}`, ck);
      if (isObj(t) && 'alternates' in t && ck(`/scores/${i}/alternates`, Array.isArray(t.alternates), 'must be an array'))
        t.alternates.forEach((a, j) => checkScore(a, `/scores/${i}/alternates/${j}`, ck));
    });
  }
  if ('recordings' in m && ck('/recordings', Array.isArray(m.recordings), 'must be an array')) m.recordings.forEach((r, i) => checkRecording(r, `/recordings/${i}`, ck));
  return errs;
}

/** Rules a JSON Schema cannot express: unique ids, references, sync chains, cross-field page bounds. */
export function manifestRuleErrors(m) {
  const errs = [], recs = m.recordings || [], scores = m.scores || [];
  const sids = scores.map((t) => t.id);
  const allIds = [];
  for (const t of scores) {
    const parts = [[t, `score ${t.id}`], ...(t.alternates || []).map((a) => [a, `alternate ${a.id}`])];
    for (const [x, name] of parts) {
      allIds.push(x.id);
      if ('startPage' in x && 'endPage' in x && x.endPage < x.startPage) errs.push(`${name}: endPage must be >= startPage`);
      if ('pages' in x && 'startPage' in x && x.startPage > x.pages) errs.push(`${name}: startPage exceeds pages`);
      if ('pages' in x && 'endPage' in x && x.endPage > x.pages) errs.push(`${name}: endPage exceeds pages`);
      if (x !== t && ANCHOR[x.format] !== ANCHOR[t.format]) errs.push(`${name}: anchor type of ${x.format} differs from its parent score ${t.id}`);
    }
  }
  if (new Set(allIds).size !== allIds.length) errs.push('duplicate score or alternate ids');
  const ids = recs.map((r) => r.id);
  if (new Set(ids).size !== ids.length) errs.push('duplicate recording ids');
  for (const r of recs) {
    for (const k of ['syncFrom', 'stemOf']) if (k in r && !ids.includes(r[k])) errs.push(`${r.id}.${k} names unknown recording ${r[k]}`);
    for (const k of Object.keys(r.sync || {})) if (!sids.includes(k)) errs.push(`${r.id}.sync names unknown score ${k}`);
    for (const [k, v] of Object.entries(r.scoreTracks || {})) {
      if (!sids.includes(k)) errs.push(`${r.id}.scoreTracks names unknown score ${k}`);
      const list = v && (v.omits || v.only);
      if (v && Array.isArray(v.names) && Array.isArray(list) && v.names.length !== list.length) errs.push(`${r.id}.scoreTracks.${k}: names must have one name for each index`);
    }
    for (const w of Array.isArray(r.without) ? r.without : []) {
      const t = recs.find((x) => x.id === w);
      if (!t) errs.push(`${r.id}.without names unknown recording ${w}`);
      else if (t.role !== 'stem') errs.push(`${r.id}.without names ${w}, which is not a stem`);
      else if (w === r.id) errs.push(`${r.id}.without names itself`);
    }
    const srcIds = (r.sources || []).filter((s) => 'id' in s).map((s) => s.id);
    if (new Set(srcIds).size !== srcIds.length) errs.push(`${r.id}: duplicate source ids`);
    for (const s of r.sources || []) {
      if ('derivedFrom' in s && !srcIds.includes(s.derivedFrom)) errs.push(`${r.id}: derivedFrom names unknown source ${s.derivedFrom}`);
      if (s.type === 'embedded' && 'score' in s && !sids.includes(s.score)) errs.push(`${r.id}: source names unknown score ${s.score}`);
    }
    if ((r.sources || []).filter((s) => s.type === 'embedded').length > 1) errs.push(`${r.id}: more than one embedded source`);
  }
  for (const sid of sids) for (const r of recs) {
    const seen = new Set([r.id]);
    let cur = r;
    while (!(cur.sync && sid in cur.sync) && (cur.syncFrom || cur.stemOf)) {
      const next = recs.find((x) => x.id === (cur.syncFrom || cur.stemOf));
      if (!next) break;
      if (seen.has(next.id)) { errs.push(`sync reference cycle at ${next.id}`); break; }
      seen.add(next.id); cur = next;
    }
  }
  for (const r of recs) {
    const seen = new Set([r.id]);
    let cur = r;
    while (!('beats' in cur) && (cur.syncFrom || cur.stemOf)) {
      const next = recs.find((x) => x.id === (cur.syncFrom || cur.stemOf));
      if (!next) break;
      if (seen.has(next.id)) { errs.push(`beats reference cycle at ${next.id}`); break; }
      seen.add(next.id); cur = next;
    }
  }
  return [...new Set(errs)];
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
const tickPoint = (p, at, ck) => {
  ck(`${at}/tick`, isInt(p.tick) && p.tick >= 0, 'is required and must be an integer >= 0');
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
const POINT = { bar: barPoint, tick: tickPoint, pdf: pdfPoint, text: textPoint };

/** Structure errors in a sync file, as strings. Empty when it matches schema/sync.schema.json. */
export function syncSchemaErrors(s) {
  const errs = [], ck = ctx(errs, '');
  if (!ck('<root>', isObj(s), 'must be an object')) return errs;
  ck('/version', s.version === 1, 'must be 1');
  ck('/recording', isStr(s.recording) && ID.test(s.recording), 'is required and must be an id');
  ck('/score', isStr(s.score) && ID.test(s.score), 'is required and must be an id');
  ck('/anchorType', s.anchorType in POINT, 'is required and must be bar, tick, pdf or text');
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

export function syncRuleErrors(s, scoreFormat) {
  const errs = [], t = s.points.map((p) => p.timeMs);
  if (t.some((v, i) => i && v <= t[i - 1])) errs.push('timeMs not strictly increasing');
  if (scoreFormat && ANCHOR[scoreFormat] !== s.anchorType) errs.push(`anchorType ${s.anchorType} does not match score format ${scoreFormat}`);
  return errs;
}

export function validateSync(s, scoreFormat) {
  const errs = syncSchemaErrors(s);
  return errs.length ? errs : syncRuleErrors(s, scoreFormat);
}

/** Structure errors in a beat file, as strings. Empty when it matches schema/beats.schema.json. */
export function beatsSchemaErrors(b) {
  const errs = [], ck = ctx(errs, '');
  if (!ck('<root>', isObj(b), 'must be an object')) return errs;
  ck('/version', b.version === 1, 'must be 1');
  ck('/recording', isStr(b.recording) && ID.test(b.recording), 'is required and must be an id');
  if (ck('/beats', Array.isArray(b.beats), 'is required and must be an array')) b.beats.forEach((x, i) => {
    const at = `/beats/${i}`;
    if (!ck(at, isObj(x), 'must be an object')) return;
    ck(`${at}/timeMs`, isNum(x.timeMs) && x.timeMs >= 0, 'is required and must be a number >= 0');
    if ('downbeat' in x) ck(`${at}/downbeat`, typeof x.downbeat === 'boolean', 'must be a boolean');
  });
  if ('sections' in b && ck('/sections', Array.isArray(b.sections), 'must be an array')) b.sections.forEach((x, i) => {
    const at = `/sections/${i}`;
    if (!ck(at, isObj(x), 'must be an object')) return;
    ck(`${at}/name`, isStr(x.name) && x.name.length > 0, 'is required and must be a non-empty string');
    if ('type' in x) ck(`${at}/type`, isStr(x.type) && x.type.length > 0, 'must be a non-empty string');
    ck(`${at}/timeMs`, isNum(x.timeMs) && x.timeMs >= 0, 'is required and must be a number >= 0');
  });
  return errs;
}

export function beatsRuleErrors(b) {
  const errs = [];
  for (const k of ['beats', 'sections']) {
    const t = (b[k] || []).map((x) => x.timeMs);
    if (t.some((v, i) => i && v <= t[i - 1])) errs.push(`${k}: timeMs not strictly increasing`);
  }
  return errs;
}

export function validateBeats(b) {
  const errs = beatsSchemaErrors(b);
  return errs.length ? errs : beatsRuleErrors(b);
}
