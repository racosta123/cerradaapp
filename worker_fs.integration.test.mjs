// Prueba de INTEGRACIÓN OFFLINE del Worker real (worker_v4.js) contra un Firestore SIMULADO en memoria.
// No usa red ni credenciales reales: fetch global está reemplazado; la clave RSA se genera al vuelo.
// Ejecutar:  node --test worker_fs.integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker from './worker_v4.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const BASE_ENV = { GOOGLE_CREDENTIALS: JSON.stringify({ client_email: 'test@test.iam', private_key: privateKey }) };

// ── conversión JS <-> formato tipado de Firestore (copia mínima, solo para el simulador)
const toFS = (v) => v === null || v === undefined ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(toFS) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFS(x)])) } };
const fromFS = (v) => 'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? parseInt(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue : 'stringValue' in v ? v.stringValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(fromFS)
  : Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFS(x)]));
const toObj = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromFS(v)]));

// ── Firestore simulado
function makeStore() {
  const st = { docs: new Map(), ver: 0, log: [], failNextGuarded: 0, hooks: [] };
  st.put = (code, obj) => { st.docs.set(code, { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toFS(v)])), updateTime: `2026-01-01T00:00:${String(++st.ver).padStart(2, '0')}.000000Z` }); };
  st.get = (code) => { const d = st.docs.get(code); return d ? toObj(d.fields) : null; };
  st.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    const m = u.pathname.match(/\/documents\/cerradas\/(.+)$/);
    if (u.hostname !== 'firestore.googleapis.com' || !m) throw new Error('fetch inesperado a ' + u);
    const code = decodeURIComponent(m[1]);
    const method = init.method || 'GET';
    if (method === 'GET') {
      const d = st.docs.get(code);
      return d ? new Response(JSON.stringify({ name: code, fields: d.fields, updateTime: d.updateTime }), { status: 200 }) : new Response('{}', { status: 404 });
    }
    // PATCH
    const pre = { updateTime: u.searchParams.get('currentDocument.updateTime'), exists: u.searchParams.get('currentDocument.exists') };
    st.log.push({ method, code, guarded: !!(pre.updateTime || pre.exists), pre });
    const cur = st.docs.get(code);
    if (pre.updateTime || pre.exists === 'false') {
      if (st.failNextGuarded > 0) {                       // simula que otro proceso escribió en medio
        st.failNextGuarded--;
        if (cur) cur.updateTime = `2026-01-01T00:01:${String(++st.ver).padStart(2, '0')}.000000Z`;
        for (const h of st.hooks) h();
        return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), { status: 400 });
      }
      if (pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), { status: 400 });
      if (pre.exists === 'false' && cur) return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), { status: 409 });
    }
    const body = JSON.parse(init.body);
    st.docs.set(code, { fields: body.fields, updateTime: `2026-01-01T00:02:${String(++st.ver).padStart(2, '0')}.000000Z` });
    return new Response(JSON.stringify({ fields: body.fields }), { status: 200 });
  };
  return st;
}

async function call(store, env, method, path, body) {
  const realFetch = globalThis.fetch, realLog = console.log;
  const logs = [];
  globalThis.fetch = store.fetch;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const res = await worker.fetch(new Request('https://w.test' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), { ...BASE_ENV, ...env });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    return { status: res.status, data, logs };
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
}

const seed = () => ({
  code: 'T-001', name: 'Cerrada Prueba', houses: 20, adminPin: '1234', active: true, suspended: false,
  residents: [
    { house: 'Casa 1', name: 'Ana', email: 'ana@x.com', pin: 'PLANO-ANA', registeredAt: '2026-01-01', pendingReg: false, active: true,
      members: [{ name: 'Beto', email: 'beto@x.com', pin: 'PLANO-BETO', role: 'family' }] },
    { house: 'Casa 2', name: 'Carlos', email: 'carlos@x.com', pin: 'PLANO-CAR', registeredAt: '2026-01-02', pendingReg: false, active: true, members: [] }
  ],
  history: [], movements: [], cuotas: {}, cuotaConfig: {}
});
const sanitizedPush = (doc) => { const c = JSON.parse(JSON.stringify(doc)); delete c.adminPin; for (const r of c.residents) { delete r.pin; for (const m of r.members || []) delete m.pin; } return c; };

// ─────────────────────────────────────────────────────────────────────────────
test('POR DEFECTO (sin variables): POST /fs escribe EXACTAMENTE como antes y solo registra', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const push = sanitizedPush(seed());
  const r = await call(store, {}, 'POST', '/fs', { code: 'T-001', data: push });
  assert.equal(r.data.ok, true);
  const patch = store.log.filter((x) => x.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].guarded, false);                         // sin precondición: reemplazo, igual que hoy
  const after = store.get('T-001');
  assert.equal(after.residents[0].pin, undefined);               // el comportamiento actual (el bug) NO cambió aún
  const ev = r.logs.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((e) => e && e.event === 'fs_merge_dryrun');
  assert.ok(ev, 'debe registrar el evento de simulación');
  assert.equal(ev.residentPinsRestored, 2);                       // lo que la fusión HABRÍA preservado
  assert.equal(ev.memberPinsRestored, 1);
  assert.equal(ev.adminPinIgnored, false);
  const txt = r.logs.join('\n');
  for (const s of ['PLANO-ANA', 'PLANO-BETO', 'PLANO-CAR', '1234', 'ana@x.com']) assert.equal(txt.includes(s), false, 'el log no debe contener datos sensibles: ' + s);
});

test("FS_MERGE_MODE='enforce': el mismo push conserva pines y adminPin y escribe con precondición", async () => {
  const store = makeStore(); store.put('T-001', seed());
  const r = await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'T-001', data: sanitizedPush(seed()) });
  assert.equal(r.data.ok, true);
  const patch = store.log.filter((x) => x.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].guarded, true);
  assert.ok(patch[0].pre.updateTime);
  const after = store.get('T-001');
  assert.equal(after.residents[0].pin, 'PLANO-ANA');
  assert.equal(after.residents[0].members[0].pin, 'PLANO-BETO');
  assert.equal(after.residents[1].pin, 'PLANO-CAR');
  assert.equal(after.adminPin, '1234');
});

test("'enforce': un conflicto de concurrencia se reintenta y no pisa la escritura ajena", async () => {
  const store = makeStore(); store.put('T-001', seed());
  store.failNextGuarded = 1;
  store.hooks.push(() => {                                        // "/register" registra a una casa nueva en medio
    const d = store.get('T-001'); d.residents.push({ house: 'Casa 7', name: 'Nueva', email: 'n@x.com', pin: 'pbkdf2$100000$aa$bb', registeredAt: 'hoy', pendingReg: false, members: [] });
    const u = store.docs.get('T-001').updateTime; store.put('T-001', d); store.docs.get('T-001').updateTime = u.replace(':01.', ':01.'); store.hooks.length = 0;
  });
  const r = await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'T-001', data: sanitizedPush(seed()) });
  assert.equal(r.data.ok, true);
  const after = store.get('T-001');
  assert.equal(after.residents.some((x) => x.house === 'Casa 7' && x.pin === 'pbkdf2$100000$aa$bb'), true);
  assert.equal(after.residents[0].pin, 'PLANO-ANA');
});

test("'enforce': borrado explícito con removed se aplica; sin removed el residente sigue", async () => {
  const store = makeStore(); store.put('T-001', seed());
  const push = sanitizedPush(seed()); push.residents = push.residents.slice(0, 1);      // el navegador ya no lista a Casa 2
  await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'T-001', data: push });
  assert.equal(store.get('T-001').residents.length, 2);                                   // sin removed: se conserva
  await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'T-001', data: push, removed: { residents: [{ email: 'carlos@x.com' }] } });
  assert.equal(store.get('T-001').residents.length, 1);
});

test("'enforce': creación de una cerrada nueva hashea el adminPin y usa exists=false", async () => {
  const store = makeStore();
  const r = await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'NUEVA-1', data: { code: 'NUEVA-1', name: 'N', houses: 5, adminPin: '4321', residents: [{ house: 'C1', name: 'A', pin: '9999' }], portones: [] } });
  assert.equal(r.data.ok, true);
  assert.equal(store.log[0].pre.exists, 'false');
  const d = store.get('NUEVA-1');
  assert.ok(d.adminPin.startsWith('pbkdf2$'));
  assert.equal(d.residents[0].pin, undefined);
  const login = await call(store, {}, 'POST', '/login', { mode: 'admin', code: 'NUEVA-1', pass: '4321' });
  assert.equal(login.data.ok, true);                                                     // el hash es utilizable por /login
});

// ─────────────────────────────────────────────────────────────────────────────
test('GET /fs: sin FS_ID_BACKFILL no cambia nada (sin ids, sin escrituras)', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const r = await call(store, {}, 'GET', '/fs?code=T-001');
  assert.equal(r.status, 200);
  assert.equal(r.data.record.residents[0].id, undefined);
  assert.equal(store.log.length, 0);
  assert.equal('pin' in r.data.record.residents[0], false);
  assert.equal('adminPin' in r.data.record, false);
});

test("GET /fs con FS_ID_BACKFILL='on': asigna ids, los PERSISTE una sola vez y los devuelve", async () => {
  const store = makeStore(); store.put('T-001', seed());
  const r1 = await call(store, { FS_ID_BACKFILL: 'on' }, 'GET', '/fs?code=T-001');
  const ids = r1.data.record.residents.map((x) => x.id);
  assert.ok(ids.every(Boolean));
  assert.ok(r1.data.record.residents[0].members[0].id);
  assert.equal(store.log.length, 1);
  const saved = store.get('T-001');
  assert.equal(saved.residents[0].id, ids[0]);                                            // persistido
  assert.equal(saved.residents[0].pin, 'PLANO-ANA');                                      // y las credenciales intactas
  assert.equal(saved.adminPin, '1234');
  const r2 = await call(store, { FS_ID_BACKFILL: 'on' }, 'GET', '/fs?code=T-001');
  assert.deepEqual(r2.data.record.residents.map((x) => x.id), ids);                       // estables
  assert.equal(store.log.length, 1);                                                      // sin nueva escritura
  assert.equal('pin' in r2.data.record.residents[0], false);                              // la respuesta sigue saneada
});

test('con ids persistidos, renombrar la casa desde el navegador no pierde el pin (modo enforce)', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const g = await call(store, { FS_ID_BACKFILL: 'on' }, 'GET', '/fs?code=T-001');
  const push = sanitizedPush(g.data.record); push.residents[0].house = 'Casa 1-B';
  await call(store, { FS_MERGE_MODE: 'enforce' }, 'POST', '/fs', { code: 'T-001', data: push });
  const after = store.get('T-001');
  assert.equal(after.residents[0].house, 'Casa 1-B');
  assert.equal(after.residents[0].pin, 'PLANO-ANA');
  assert.equal(after.residents.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
test('/admin/*: inactivos (404) mientras ADMIN_PIN_ENDPOINTS no sea "on"', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const a = await call(store, {}, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: '1234', target: { email: 'ana@x.com' }, newPin: '5555' });
  const b = await call(store, {}, 'POST', '/admin/change-pin', { code: 'T-001', oldPin: '1234', newPin: '7777' });
  assert.equal(a.status, 404); assert.equal(b.status, 404);
  assert.equal(store.log.length, 0);
});

test('/admin/set-pin: valida el adminPin guardado, hashea y el residente entra con el PIN nuevo', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const env = { ADMIN_PIN_ENDPOINTS: 'on' };
  const bad = await call(store, env, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: 'mal', target: { email: 'ana@x.com' }, newPin: '5555' });
  assert.equal(bad.status, 401);
  const noCerrada = await call(store, env, 'POST', '/admin/set-pin', { code: 'NOEXISTE', adminPin: '1234', target: { email: 'ana@x.com' }, newPin: '5555' });
  assert.equal(noCerrada.status, 401);                                                    // no revela si existe
  assert.equal((await call(store, env, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: '1234', target: { email: 'ana@x.com' }, newPin: 'abc' })).status, 400);
  assert.equal(store.log.length, 0);                                                      // nada se escribió aún
  const ok = await call(store, env, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: '1234', target: { email: 'ana@x.com' }, newPin: '5555' });
  assert.equal(ok.status, 200);
  const d = store.get('T-001');
  assert.ok(d.residents[0].pin.startsWith('pbkdf2$'));
  assert.equal(d.residents[1].pin, 'PLANO-CAR');                                          // los demás intactos
  const login = await call(store, {}, 'POST', '/login', { mode: 'resident', code: 'T-001', email: 'ana@x.com', pass: '5555' });
  assert.equal(login.data.ok, true);
  const old = await call(store, {}, 'POST', '/login', { mode: 'resident', code: 'T-001', email: 'ana@x.com', pass: 'PLANO-ANA' });
  assert.equal(old.status, 401);
});

test('/admin/set-pin: PIN de un familiar (member) y errores de destino', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const env = { ADMIN_PIN_ENDPOINTS: 'on' };
  const ok = await call(store, env, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: '1234', target: { email: 'ana@x.com', member: { email: 'beto@x.com' } }, newPin: '4444' });
  assert.equal(ok.status, 200);
  const login = await call(store, {}, 'POST', '/login', { mode: 'resident', code: 'T-001', email: 'beto@x.com', pass: '4444' });
  assert.equal(login.data.ok, true);
  const nf = await call(store, env, 'POST', '/admin/set-pin', { code: 'T-001', adminPin: '1234', target: { email: 'nadie@x.com' }, newPin: '4444' });
  assert.equal(nf.status, 404);
});

test('/admin/change-pin: valida el PIN actual y el nuevo (hasheado) sirve para /login admin', async () => {
  const store = makeStore(); store.put('T-001', seed());
  const env = { ADMIN_PIN_ENDPOINTS: 'on' };
  assert.equal((await call(store, env, 'POST', '/admin/change-pin', { code: 'T-001', oldPin: 'mal', newPin: '7777' })).status, 401);
  assert.equal((await call(store, env, 'POST', '/admin/change-pin', { code: 'T-001', oldPin: '1234', newPin: '12' })).status, 400);
  const ok = await call(store, env, 'POST', '/admin/change-pin', { code: 'T-001', oldPin: '1234', newPin: '7777' });
  assert.equal(ok.status, 200);
  assert.ok(store.get('T-001').adminPin.startsWith('pbkdf2$'));
  assert.equal(store.get('T-001').residents[0].pin, 'PLANO-ANA');                         // el resto del documento intacto
  assert.equal((await call(store, {}, 'POST', '/login', { mode: 'admin', code: 'T-001', pass: '7777' })).data.ok, true);
  assert.equal((await call(store, {}, 'POST', '/login', { mode: 'admin', code: 'T-001', pass: '1234' })).status, 401);
});
