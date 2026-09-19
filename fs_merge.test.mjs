// Pruebas OFFLINE de fs_merge.mjs — no tocan Firestore ni la red. Datos 100% ficticios.
// Ejecutar:  node --test fs_merge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCerrada, ensureIds, setPinInDoc, processFsPost } from './fs_merge.mjs';

const H1 = 'pbkdf2$100000$aa$h1', H2 = 'pbkdf2$100000$bb$h2', HM = 'pbkdf2$100000$cc$hm', HA = 'pbkdf2$100000$dd$admin';
let n = 0;
const genId = () => 'gen-' + (++n);

// documento "guardado" en Firestore (crudo, con credenciales)
function stored() {
  return {
    code: 'T-001', name: 'Cerrada Prueba', houses: 20, adminPin: HA, active: true, suspended: false,
    residents: [
      { id: 'r1', house: 'Casa 1', name: 'Ana', email: 'ana@x.com', pin: H1, registeredAt: '2026-01-01', pendingReg: false, active: true,
        fcmToken: 'tok-ana',
        members: [ { id: 'm1', name: 'Beto', email: 'beto@x.com', pin: HM, role: 'family', registeredAt: '2026-02-01', suspended: false } ] },
      { id: 'r2', house: 'Casa 2', name: 'Carlos', email: 'carlos@x.com', pin: H2, registeredAt: '2026-01-05', pendingReg: false, active: true, members: [] },
      { id: 'r3', house: 'Casa 3', name: 'Dora', phone: '555', pendingReg: true, active: true, members: [] }
    ],
    history: [], movements: [], cuotas: {}, cuotaConfig: {}
  };
}
// copia SANEADA como la recibe el navegador por GET /fs (sin pin/password/adminPin)
function sanitized(doc) {
  const c = JSON.parse(JSON.stringify(doc));
  delete c.adminPin;
  for (const r of c.residents) { delete r.pin; delete r.password; for (const m of r.members || []) { delete m.pin; delete m.password; } }
  return c;
}
const byId = (doc, id) => doc.residents.find((r) => r.id === id);

// ─────────────────────────────── (a) push sin pin NO borra el pin guardado
test('(a) push sin pin conserva pin de residente, de member y adminPin', () => {
  const st = stored();
  const inc = sanitized(st);               // el navegador nunca tuvo los pin
  inc.residents[1].phone = '999';          // cambio legítimo (dato editable)
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r1').pin, H1);
  assert.equal(byId(merged, 'r2').pin, H2);
  assert.equal(byId(merged, 'r1').members[0].pin, HM);
  assert.equal(merged.adminPin, HA);
  assert.equal(byId(merged, 'r2').phone, '999');        // el cambio legítimo sí se aplica
  assert.equal(report.residentPinsRestored, 2);
  assert.equal(report.memberPinsRestored, 1);
});

test('(a2) un pin/adminPin FORJADO desde el navegador se ignora', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.adminPin = '1234';
  inc.residents[0].pin = '0000';
  inc.residents[0].password = 'hack';
  inc.residents[0].members[0].pin = '0000';
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(merged.adminPin, HA);
  assert.equal(byId(merged, 'r1').pin, H1);
  assert.equal('password' in byId(merged, 'r1'), false);
  assert.equal(byId(merged, 'r1').members[0].pin, HM);
  assert.equal(report.adminPinIgnored, true);
  assert.ok(report.incomingCredsIgnored >= 3);
});

test('(a3) copia VIEJA (anterior a un registro) no borra el residente/member registrado después', () => {
  const st = stored();
  const inc = sanitized(st);
  // la copia vieja no conoce el email/registro de Dora ni al member Beto
  inc.residents[0].members = [];
  st.residents[2] = { id: 'r3', house: 'Casa 3', name: 'Dora', email: 'dora@x.com', pin: 'pbkdf2$100000$ee$h3', registeredAt: '2026-09-01', pendingReg: false, active: true, members: [] };
  const { merged } = mergeCerrada(st, inc, {}, { genId });
  const dora = byId(merged, 'r3');
  assert.equal(dora.pin, 'pbkdf2$100000$ee$h3');
  assert.equal(dora.email, 'dora@x.com');             // el email NO se pierde (si no, el login quedaría imposible)
  assert.equal(dora.pendingReg, false);
  assert.equal(byId(merged, 'r1').members.length, 1);  // Beto se conserva aunque no venga
  assert.equal(byId(merged, 'r1').members[0].pin, HM);
});

test('(a4) el fcmToken no se borra por ausencia y sí se puede actualizar', () => {
  const st = stored();
  const inc = sanitized(st);
  delete inc.residents[0].fcmToken;
  let { merged } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r1').fcmToken, 'tok-ana');
  inc.residents[0].fcmToken = 'tok-nuevo';
  ({ merged } = mergeCerrada(st, inc, {}, { genId }));
  assert.equal(byId(merged, 'r1').fcmToken, 'tok-nuevo');
});

test('(a5) un token de invitación ya consumido no se revive desde una copia vieja', () => {
  const st = stored();
  st.residents[2].lastInviteConsumed = 'TOK-USADO';
  const inc = sanitized(st);
  inc.residents[2].inviteToken = 'TOK-USADO';
  inc.residents[2].inviteExpires = 123;
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal('inviteToken' in byId(merged, 'r3'), false);
  assert.equal(report.consumedInviteDropped, 1);
  inc.residents[2].inviteToken = 'TOK-NUEVO';   // uno nuevo sí pasa
  assert.equal(byId(mergeCerrada(st, inc, {}, { genId }).merged, 'r3').inviteToken, 'TOK-NUEVO');
});

// ─────────────────────────────── (b) residente nuevo sin pin no se rompe
test('(b) residente realmente nuevo (sin pin) se agrega con id y sin credenciales', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents.push({ house: 'Casa 9', name: 'Nuevo', phone: '1', active: true, mora: false, members: [], pendingReg: true });
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(merged.residents.length, 4);
  const nuevo = merged.residents.find((r) => r.house === 'Casa 9');
  assert.ok(nuevo.id);
  assert.equal('pin' in nuevo, false);
  assert.equal(nuevo.pendingReg, true);
  assert.equal(report.residentsNew, 1);
  assert.equal(byId(merged, 'r1').pin, H1);              // los demás intactos
});

test('(b2) un residente nuevo NO puede colarse con pin/password/registeredAt propios', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents.push({ house: 'Casa 8', name: 'Intruso', email: 'x@x.com', pin: '1234', password: 'p', registeredAt: 'ya', members: [{ name: 'M', email: 'm@x.com', pin: '1' }] });
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  const x = merged.residents.find((r) => r.house === 'Casa 8');
  assert.equal('pin' in x, false);
  assert.equal('password' in x, false);
  assert.equal('registeredAt' in x, false);
  assert.equal(x.members.length, 0);
  assert.equal(report.membersDiscardedNew, 1);
});

test('(b3) creación de una cerrada nueva: sin residentes con credenciales y adminPin para hashear', () => {
  const inc = { code: 'NUEVA-1', name: 'N', houses: 10, adminPin: '4321', residents: [{ house: 'C1', name: 'A', pin: '9999' }], portones: [] };
  const { merged, adminPinToHash, report } = mergeCerrada(null, inc, {}, { genId });
  assert.equal(report.created, true);
  assert.equal(adminPinToHash, '4321');
  assert.equal('adminPin' in merged, false);            // el llamador lo hashea; nunca queda en claro
  assert.equal('pin' in merged.residents[0], false);
});

// ─────────────────────────────── (c) member nuevo del navegador se descarta
test('(c) un member nuevo enviado por el navegador se descarta (solo /register los crea)', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents[1].members.push({ name: 'Falso', email: 'falso@x.com', pin: '1111', role: 'family' });
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r2').members.length, 0);
  assert.equal(report.membersDiscardedNew, 1);
});

test('(c2) el orden de members sigue el del guardado (los índices de sesión no se desalinean)', () => {
  const st = stored();
  st.residents[0].members.push({ id: 'm2', name: 'Caro', email: 'caro@x.com', pin: HM + '2', role: 'family' });
  const inc = sanitized(st);
  inc.residents[0].members.reverse();
  const { merged } = mergeCerrada(st, inc, {}, { genId });
  assert.deepEqual(byId(merged, 'r1').members.map((m) => m.id), ['m1', 'm2']);
});

// ─────────────────────────────── (d) borrados explícitos SÍ se aplican
test('(d) borrado explícito de un residente (por id) se aplica y no se resucita', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents = inc.residents.filter((r) => r.id !== 'r2');      // el admin lo quitó localmente
  const { merged, report } = mergeCerrada(st, inc, { residents: [{ id: 'r2' }] }, { genId });
  assert.equal(merged.residents.some((r) => r.id === 'r2'), false);
  assert.equal(report.residentsRemoved, 1);
  assert.equal(merged.residents.length, 2);
});

test('(d2) SIN lista removed, un residente ausente NO se borra (cliente viejo no borra)', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents = inc.residents.filter((r) => r.id !== 'r2');
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(merged.residents.some((r) => r.id === 'r2'), true);
  assert.equal(byId(merged, 'r2').pin, H2);
  assert.equal(report.residentsKeptNotSent, 1);
});

test('(d3) borrado explícito de un member (por email) se aplica', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents[0].members = [];
  const removed = { members: [{ resident: { id: 'r1' }, member: { email: 'BETO@x.com' } }] };
  const { merged, report } = mergeCerrada(st, inc, removed, { genId });
  assert.equal(byId(merged, 'r1').members.length, 0);
  assert.equal(report.membersRemoved, 1);
});

test('(d4) la lista removed gana aunque el push aún incluya al residente', () => {
  const st = stored();
  const inc = sanitized(st);
  const { merged } = mergeCerrada(st, inc, { residents: [{ id: 'r3' }] }, { genId });
  assert.equal(merged.residents.some((r) => r.id === 'r3'), false);
});

// ─────────────────────────────── emparejamiento id > email > house
test('emparejamiento: renombrar la casa con id conserva las credenciales', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents[0].house = 'Casa 1-B';
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r1').house, 'Casa 1-B');
  assert.equal(byId(merged, 'r1').pin, H1);
  assert.equal(merged.residents.length, 3);
  assert.equal(report.residentsNew, 0);
});

test('emparejamiento de respaldo: cliente viejo SIN id, por email (mayúsculas distintas)', () => {
  const st = stored();
  const inc = sanitized(st);
  for (const r of inc.residents) { delete r.id; for (const m of r.members || []) delete m.id; }
  inc.residents[0].email = 'ANA@X.com';
  inc.residents[0].house = 'Casa 1 renombrada';       // aunque cambie la casa, el email empareja
  const { merged } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r1').pin, H1);
  assert.equal(byId(merged, 'r1').members[0].pin, HM);   // member por email
  assert.equal(merged.residents.length, 3);
});

test('emparejamiento de respaldo: cliente viejo SIN id, residente pendiente, por house', () => {
  const st = stored();
  const inc = sanitized(st);
  for (const r of inc.residents) delete r.id;
  inc.residents[2].name = 'Dora Editada';
  const { merged } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(byId(merged, 'r3').name, 'Dora Editada');
  assert.equal(merged.residents.length, 3);
});

test('un id desconocido NO empareja por email/house (se trata como nuevo, sin credenciales)', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.residents[0].id = 'id-inventado';
  const { merged, report } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(report.residentsNew, 1);
  assert.equal(byId(merged, 'r1').pin, H1);              // el guardado se conserva
  assert.equal('pin' in merged.residents.find((r) => r.id !== 'r1' && r.house === 'Casa 1'), false);
});

// ─────────────────────────────── otros invariantes
test('backfill: ensureIds asigna ids a lo que no tiene y es idempotente', () => {
  const st = stored();
  delete st.residents[0].id; delete st.residents[0].members[0].id;
  const c = JSON.parse(JSON.stringify(st));
  assert.equal(ensureIds(c, genId), 2);
  assert.equal(ensureIds(c, genId), 0);
});

test('idempotencia: fusionar el documento guardado consigo mismo no cambia nada', () => {
  const st = stored();
  const { merged } = mergeCerrada(st, st, {}, { genId });
  assert.deepEqual(merged, st);
});

test('la raíz: campos desconocidos guardados se conservan y los ausentes no se borran', () => {
  const st = stored();
  st.campoInterno = 'x';
  const inc = { name: 'Nombre nuevo', residents: [] };
  const { merged } = mergeCerrada(st, inc, {}, { genId });
  assert.equal(merged.name, 'Nombre nuevo');
  assert.equal(merged.campoInterno, 'x');
  assert.equal(merged.houses, 20);
  assert.equal(merged.residents.length, 3);              // ninguno se borra
});

test('el reporte de log no contiene valores de credenciales', () => {
  const st = stored();
  const inc = sanitized(st);
  inc.adminPin = 'SECRETO-ADMIN';
  inc.residents[0].pin = 'SECRETO-PIN';
  const { report } = mergeCerrada(st, inc, {}, { genId });
  const txt = JSON.stringify(report);
  for (const s of ['SECRETO', 'pbkdf2', H1, HA]) assert.equal(txt.includes(s), false);
});

// ─────────────────────────────── setPinInDoc (endpoint /admin/set-pin)
test('setPinInDoc: pone el hash al residente (por email) y al member (por id)', () => {
  const st = stored();
  let r = setPinInDoc(st, { email: 'ANA@x.com' }, 'HASH-NUEVO', genId);
  assert.equal(r.ok, true);
  assert.equal(byId(r.doc, 'r1').pin, 'HASH-NUEVO');
  r = setPinInDoc(st, { id: 'r1', member: { id: 'm1' } }, 'HASH-M', genId);
  assert.equal(byId(r.doc, 'r1').members[0].pin, 'HASH-M');
  assert.equal(st.residents[0].pin, H1);                  // no muta el original
});

test('setPinInDoc: errores (no existe / sin registrar / member inexistente)', () => {
  const st = stored();
  assert.equal(setPinInDoc(st, { id: 'nope' }, 'H', genId).error, 'not_found');
  assert.equal(setPinInDoc(st, { id: 'r3' }, 'H', genId).error, 'not_registered');   // Dora no tiene correo
  assert.equal(setPinInDoc(st, { id: 'r1', member: { id: 'zz' } }, 'H', genId).error, 'member_not_found');
});

// ─────────────────────────────── orquestación (processFsPost) con I/O simulado
function fakeIO(initial) {
  const s = { doc: initial, updateTime: 't1', writes: [], raw: [], failNext: 0, readCount: 0 };
  return {
    s,
    async read() { s.readCount++; return s.doc ? { doc: JSON.parse(JSON.stringify(s.doc)), updateTime: s.updateTime } : null; },
    async writeRaw(code, data) { s.raw.push(data); return true; },
    async writeGuarded(code, doc, pre) {
      if (s.failNext > 0) { s.failNext--; s.updateTime = 't' + (s.readCount + 1); return { ok: false, conflict: true }; }
      s.writes.push({ doc, pre }); s.doc = doc; return { ok: true };
    }
  };
}

test("modo 'log' (por defecto): la escritura es EXACTAMENTE la actual y solo se registra", async () => {
  const st = stored();
  const io = fakeIO(st);
  const logs = [];
  const data = sanitized(st);                             // sin pin
  const res = await processFsPost({ code: 'T-001', data }, io, { log: (e) => logs.push(e), genId });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'log');
  assert.deepEqual(io.s.raw, [data]);                     // se escribió tal cual, sin fusión
  assert.equal(io.s.writes.length, 0);                    // no hubo escritura protegida
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'fs_merge_dryrun');
  assert.equal(logs[0].residentPinsRestored, 2);          // muestra lo que la fusión HARÍA
  assert.equal(logs[0].memberPinsRestored, 1);
});

test("modo 'log': si la lectura/fusión falla, igual se escribe como hoy", async () => {
  const io = fakeIO(stored());
  io.read = async () => { throw new Error('firestore caído'); };
  const logs = [];
  const data = { name: 'x' };
  const res = await processFsPost({ code: 'T-001', data }, io, { log: (e) => logs.push(e) });
  assert.equal(res.ok, true);
  assert.deepEqual(io.s.raw, [data]);
  assert.equal(logs[0].event, 'fs_merge_dryrun_error');
});

test("modo 'enforce': escribe el documento fusionado con precondición updateTime", async () => {
  const st = stored();
  const io = fakeIO(st);
  const res = await processFsPost({ code: 'T-001', data: sanitized(st) }, io, { mode: 'enforce', genId, hashPin: async (p) => 'H(' + p + ')' });
  assert.equal(res.ok, true);
  assert.equal(io.s.raw.length, 0);
  assert.deepEqual(io.s.writes[0].pre, { updateTime: 't1' });
  assert.equal(byId(io.s.writes[0].doc, 'r1').pin, H1);
  assert.equal(io.s.writes[0].doc.adminPin, HA);
});

test("modo 'enforce': ante conflicto vuelve a leer y a fusionar (no pisa una escritura concurrente)", async () => {
  const st = stored();
  const io = fakeIO(st);
  io.s.failNext = 1;                                       // el primer intento choca
  const orig = io.read;
  let leidas = 0;
  io.read = async () => {                                  // entre intentos "/register" registra a Dora
    leidas++;
    if (leidas === 2) io.s.doc.residents[2] = { id: 'r3', house: 'Casa 3', name: 'Dora', email: 'dora@x.com', pin: 'pbkdf2$100000$ee$h3', registeredAt: 'hoy', pendingReg: false, members: [] };
    return orig();
  };
  const res = await processFsPost({ code: 'T-001', data: sanitized(st) }, io, { mode: 'enforce', genId });
  assert.equal(res.ok, true);
  assert.equal(leidas, 2);
  assert.equal(byId(io.s.doc, 'r3').pin, 'pbkdf2$100000$ee$h3');   // el registro concurrente sobrevive
});

test("modo 'enforce': tras 3 conflictos seguidos falla sin escribir", async () => {
  const io = fakeIO(stored());
  io.s.failNext = 5;
  const res = await processFsPost({ code: 'T-001', data: sanitized(stored()) }, io, { mode: 'enforce', genId });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'conflict');
  assert.equal(io.s.writes.length, 0);
});

test("modo 'enforce': cerrada inexistente = creación, con exists:false y adminPin hasheado", async () => {
  const io = fakeIO(null);
  const inc = { code: 'NUEVA-1', name: 'N', houses: 5, adminPin: '4321', residents: [{ house: 'C1', name: 'A', pin: '9' }] };
  const res = await processFsPost({ code: 'NUEVA-1', data: inc }, io, { mode: 'enforce', genId, hashPin: async (p) => 'H(' + p + ')' });
  assert.equal(res.ok, true);
  assert.deepEqual(io.s.writes[0].pre, { exists: false });
  assert.equal(io.s.writes[0].doc.adminPin, 'H(4321)');
  assert.equal('pin' in io.s.writes[0].doc.residents[0], false);
});
