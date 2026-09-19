// CerradaApp — lógica PURA de fusión para POST /fs (sin red, sin Firestore, sin dependencias del Worker).
//
// Objetivo: que un push del navegador (que trabaja con una copia SANEADA, sin pin/adminPin)
// nunca pueda borrar ni cambiar credenciales guardadas en Firestore.
//
// Reglas:
//  - pin / password (residentes y members) y adminPin: SIEMPRE los del documento guardado.
//  - email / registeredAt / pendingReg del residente, y email / role / registeredAt del member:
//    del guardado cuando existen (los fija /register, no el navegador).
//  - Emparejamiento: id inmutable > email (minúsculas) > house.
//  - Lo guardado que no viene en el push se CONSERVA (salvo borrado explícito en `removed`).
//  - Members nuevos que vengan del navegador se DESCARTAN (solo /register los crea).
//  - fcmToken se fusiona: nunca se borra por ausencia.

export const ROOT_CLIENT_FIELDS = [
  'name', 'houses', 'adminName', 'adminPhone', 'price', 'active', 'suspended',
  'portones', 'history', 'movements', 'cuotas', 'cuotaConfig', 'updatedAt'
];
// Campos de la raíz que además se aceptan al CREAR una cerrada nueva.
const CREATE_ONLY_FIELDS = ['code', 'createdAt'];

const CRED_FIELDS = ['pin', 'password'];
const RES_REG_FIELDS = ['email', 'registeredAt', 'pendingReg'];
const MEM_REG_FIELDS = ['email', 'role', 'registeredAt'];

const defaultGenId = () => globalThis.crypto.randomUUID();
const clone = (o) => JSON.parse(JSON.stringify(o));
const lower = (v) => String(v ?? '').trim().toLowerCase();
const has = (o, k) => o[k] !== undefined && o[k] !== null;

function newReport() {
  return {
    created: false,
    idsAssigned: 0,
    residentsMatched: 0,
    residentsNew: 0,
    residentsKeptNotSent: 0,
    residentsRemoved: 0,
    residentPinsRestored: 0,
    memberPinsRestored: 0,
    incomingCredsIgnored: 0,
    adminPinIgnored: false,
    registrationFieldsRestored: 0,
    membersKeptNotSent: 0,
    membersDiscardedNew: 0,
    membersRemoved: 0,
    consumedInviteDropped: 0
  };
}

// ── ids inmutables (backfill). Muta el documento recibido; devuelve cuántos ids asignó.
export function ensureIds(doc, genId = defaultGenId) {
  let n = 0;
  for (const r of doc.residents || []) {
    if (!r.id) { r.id = genId(); n++; }
    for (const m of r.members || []) if (!m.id) { m.id = genId(); n++; }
  }
  return n;
}

// ── Emparejamiento (entrante -> guardado). id estricto si el entrante lo trae;
//    si no, email (minúsculas) y luego house. `used` = índices guardados ya emparejados.
function findStored(list, d, used, useHouse) {
  if (d.id) {
    return list.findIndex((x, i) => !used.has(i) && x.id === d.id);
  }
  const e = lower(d.email);
  if (e) {
    const i = list.findIndex((x, j) => !used.has(j) && lower(x.email) === e);
    if (i >= 0) return i;
  }
  if (useHouse && d.house) {
    return list.findIndex((x, j) => !used.has(j) && x.house === d.house);
  }
  return -1;
}

function sanitizeNewResident(ir, report, genId) {
  const out = { ...ir };
  for (const f of CRED_FIELDS) if (out[f] !== undefined) { delete out[f]; report.incomingCredsIgnored++; }
  delete out.registeredAt;
  delete out.lastInviteConsumed;
  report.membersDiscardedNew += (ir.members || []).length;
  out.members = [];
  out.id = genId();
  return out;
}

function mergeMember(sm, im, report) {
  const out = { ...sm, ...im };
  out.id = sm.id;
  for (const f of CRED_FIELDS) {
    if (has(sm, f)) {
      if (im[f] !== undefined && im[f] !== sm[f]) report.incomingCredsIgnored++;
      out[f] = sm[f];
    } else {
      if (im[f] !== undefined) report.incomingCredsIgnored++;
      delete out[f];
    }
  }
  if (im.pin === undefined && has(sm, 'pin')) report.memberPinsRestored++;
  for (const f of MEM_REG_FIELDS) {
    if (has(sm, f)) out[f] = sm[f];
  }
  const tok = im.fcmToken || sm.fcmToken;
  if (tok) out.fcmToken = tok; else delete out.fcmToken;
  return out;
}

function mergeMembers(stMembers, incMembers, removedMemberDescs, report) {
  const usedInc = new Set();
  const out = [];
  const matchedStored = new Set();
  const incList = incMembers || [];

  // emparejar cada member entrante con uno guardado; los que no empareja se descartan
  const incToStored = new Map();
  incList.forEach((im, k) => {
    const si = findStored(stMembers, im, matchedStored, false);
    if (si >= 0) { matchedStored.add(si); incToStored.set(si, im); usedInc.add(k); }
  });
  report.membersDiscardedNew += incList.length - usedInc.size;

  // salida en el ORDEN del guardado (los índices de members se usan en sesiones del navegador)
  const removedIdx = new Set();
  for (const d of removedMemberDescs) {
    const i = findStored(stMembers, d, removedIdx, false);
    if (i >= 0) removedIdx.add(i);
  }
  stMembers.forEach((sm, i) => {
    if (removedIdx.has(i)) { report.membersRemoved++; return; }
    if (incToStored.has(i)) out.push(mergeMember(sm, incToStored.get(i), report));
    else { out.push(sm); report.membersKeptNotSent++; }
  });
  return out;
}

function mergeResident(st, ir, removedMemberDescs, report) {
  const out = { ...st, ...ir };
  out.id = st.id;

  // credenciales: nunca del navegador
  for (const f of CRED_FIELDS) {
    if (has(st, f)) {
      if (ir[f] !== undefined && ir[f] !== st[f]) report.incomingCredsIgnored++;
      out[f] = st[f];
    } else {
      if (ir[f] !== undefined) report.incomingCredsIgnored++;
      delete out[f];
    }
  }
  if (ir.pin === undefined && has(st, 'pin')) report.residentPinsRestored++;

  // campos que fija /register: del guardado si ya está registrado
  const registered = has(st, 'registeredAt') || has(st, 'pin') || has(st, 'password') || st.pendingReg === false;
  if (registered) {
    for (const f of RES_REG_FIELDS) {
      if (has(st, f)) {
        if (ir[f] !== undefined && ir[f] !== st[f]) report.registrationFieldsRestored++;
        out[f] = st[f];
      }
    }
  } else {
    delete out.registeredAt; // el navegador no puede declarar a alguien como registrado
  }

  // invitaciones: una copia vieja no puede revivir un token ya consumido
  if (has(st, 'lastInviteConsumed')) out.lastInviteConsumed = st.lastInviteConsumed;
  else delete out.lastInviteConsumed;
  if (out.lastInviteConsumed && (out.inviteToken === out.lastInviteConsumed || out.invitacion_token === out.lastInviteConsumed)) {
    delete out.inviteToken; delete out.inviteExpires; delete out.invitacion_token;
    report.consumedInviteDropped++;
  }

  // fcmToken: se fusiona, nunca se borra por ausencia
  const tok = ir.fcmToken || st.fcmToken;
  if (tok) out.fcmToken = tok; else delete out.fcmToken;

  out.members = mergeMembers(st.members || [], ir.members, removedMemberDescs, report);
  return out;
}

function createFromIncoming(incoming, genId, report) {
  const inc = clone(incoming || {});
  const merged = {};
  for (const k of [...ROOT_CLIENT_FIELDS, ...CREATE_ONLY_FIELDS]) if (inc[k] !== undefined) merged[k] = inc[k];
  merged.residents = (inc.residents || []).map((r) => { report.residentsNew++; return sanitizeNewResident(r, report, genId); });
  report.created = true;
  const adminPinToHash = has(inc, 'adminPin') ? String(inc.adminPin) : null;
  return { merged, adminPinToHash, report };
}

// ── Fusión principal.
//   stored   : documento guardado en Firestore (o null si no existe -> creación)
//   incoming : `data` que manda el navegador
//   removed  : { residents:[{id|email|house}], members:[{resident:{id|email|house}, member:{id|email}}] }
// Devuelve { merged, adminPinToHash, report }. `adminPinToHash` solo se rellena en la creación
// (el llamador debe hashearlo); en documentos existentes el adminPin guardado se conserva siempre.
export function mergeCerrada(stored, incoming, removed = {}, opts = {}) {
  const genId = opts.genId || defaultGenId;
  const report = newReport();
  if (!stored) return createFromIncoming(incoming, genId, report);

  const base = clone(stored);
  report.idsAssigned = ensureIds(base, genId);
  const inc = clone(incoming || {});
  const out = { ...base };

  if (has(inc, 'adminPin')) report.adminPinIgnored = true;
  for (const k of ROOT_CLIENT_FIELDS) if (inc[k] !== undefined) out[k] = inc[k];

  const stRes = base.residents || [];

  // borrados explícitos (resueltos contra lo guardado)
  const removedRes = new Set();
  for (const d of removed.residents || []) {
    const i = findStored(stRes, d, removedRes, true);
    if (i >= 0) removedRes.add(i);
  }
  const removedMembersFor = (si) => {
    const list = [];
    for (const rm of removed.members || []) {
      const ri = findStored(stRes, rm.resident || {}, new Set(), true);
      if (ri === si && rm.member) list.push(rm.member);
    }
    return list;
  };

  // El ORDEN lo dicta lo guardado (una copia vieja o parcial no debe reordenar la lista);
  // los residentes nuevos van al final, en el orden en que llegaron.
  const usedStored = new Set();
  const slots = new Array(stRes.length).fill(null);
  const fresh = [];
  for (const ir of inc.residents || []) {
    const si = findStored(stRes, ir, usedStored, true);
    if (si < 0) {
      fresh.push(sanitizeNewResident(ir, report, genId));
      report.residentsNew++;
      continue;
    }
    usedStored.add(si);
    if (removedRes.has(si)) { report.residentsRemoved++; continue; }
    report.residentsMatched++;
    slots[si] = mergeResident(stRes[si], ir, removedMembersFor(si), report);
  }
  stRes.forEach((sr, i) => {
    if (usedStored.has(i)) return;
    if (removedRes.has(i)) { report.residentsRemoved++; return; }
    // el residente guardado no vino en el push: se conserva, aplicando borrados de members si los hay
    const rm = removedMembersFor(i);
    if (rm.length) {
      const kept = { ...sr };
      kept.members = mergeMembers(sr.members || [], [], rm, report);
      slots[i] = kept;
    } else {
      slots[i] = sr;
    }
    report.residentsKeptNotSent++;
  });
  const outRes = slots.filter(Boolean).concat(fresh);

  out.residents = outRes;
  return { merged: out, adminPinToHash: null, report };
}

// ── PIN de un residente/member (endpoint /admin/set-pin). Puro: recibe el hash ya calculado.
//   target: { id?, email?, house?, member?: { id?, email? } }
export function setPinInDoc(doc, target, pinHash, genId = defaultGenId) {
  const d = clone(doc);
  ensureIds(d, genId);
  const stRes = d.residents || [];
  const ri = findStored(stRes, target || {}, new Set(), true);
  if (ri < 0) return { ok: false, error: 'not_found' };
  const res = stRes[ri];
  if (target.member) {
    const mi = findStored(res.members || [], target.member, new Set(), false);
    if (mi < 0) return { ok: false, error: 'member_not_found' };
    res.members[mi].pin = pinHash;
    delete res.members[mi].password;
  } else {
    if (!res.email) return { ok: false, error: 'not_registered' };
    res.pin = pinHash;
    delete res.password;
  }
  return { ok: true, doc: d };
}

// ── Orquestación del POST /fs con I/O inyectado (testeable sin Firestore).
//   io.read(code)                 -> { doc, updateTime } | null
//   io.writeRaw(code, data)       -> boolean            (comportamiento ACTUAL: reemplazo tal cual)
//   io.writeGuarded(code, doc, p) -> { ok, conflict }   (p = { updateTime } | { exists:false })
//   opts.mode: 'log' (defecto: NO cambia la escritura, solo registra) | 'enforce'
export async function processFsPost({ code, data, removed }, io, opts = {}) {
  const { mode = 'log', log = () => {}, hashPin, genId } = opts;

  if (mode !== 'enforce') {
    try {
      const cur = await io.read(code);
      const { report } = mergeCerrada(cur ? cur.doc : null, data, removed || {}, { genId });
      log({ event: 'fs_merge_dryrun', code, ...report });
    } catch (e) {
      log({ event: 'fs_merge_dryrun_error', code, error: String((e && e.message) || e) });
    }
    const ok = await io.writeRaw(code, data);
    return { ok, mode: 'log' };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await io.read(code);
    const res = mergeCerrada(cur ? cur.doc : null, data, removed || {}, { genId });
    res.merged.code = code;
    if (res.adminPinToHash) res.merged.adminPin = await hashPin(res.adminPinToHash);
    const w = await io.writeGuarded(code, res.merged, cur ? { updateTime: cur.updateTime } : { exists: false });
    if (w.ok) {
      log({ event: 'fs_merge_applied', code, attempt, ...res.report });
      return { ok: true, mode: 'enforce', report: res.report };
    }
    if (!w.conflict) return { ok: false, mode: 'enforce', error: 'write_failed' };
  }
  return { ok: false, mode: 'enforce', error: 'conflict' };
}
