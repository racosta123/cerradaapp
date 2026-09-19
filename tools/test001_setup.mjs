// Crea la cerrada de prueba TEST-001 (datos FICTICIOS) en Firestore real, solo a través del Worker.
// SEGURO: cualquier POST con un code distinto de TEST-001 aborta.
const W = 'https://shelly-proxy.acosta4770.workers.dev';
const CODE = 'TEST-001';
const P = { admin: '4827', ana: '2468', beto: '1357', carlos: '3690' };
const E = { ana: 'ana.prueba@example.test', beto: 'beto.prueba@example.test', carlos: 'carlos.prueba@example.test' };

async function api(method, path, body) {
  if (method === 'POST' && body && body.code !== CODE) throw new Error('ABORTADO: solo se permite escribir en ' + CODE + ' (recibido ' + body.code + ')');
  const r = await fetch(W + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const step = (n, t, ok, extra = '') => console.log(`${ok ? 'OK ' : 'FALLA'} ${n} ${t}${extra ? ' — ' + extra : ''}`);
const login = async (email, pass) => (await api('POST', '/login', { mode: 'resident', code: CODE, email, pass }));

// S1. Crear la cerrada (ruta de creación: exists=false, adminPin hasheado por el Worker)
let r = await api('GET', `/fs?code=${CODE}`);
if (r.status !== 404) { console.log('TEST-001 ya existe (HTTP ' + r.status + '); no se recrea.'); process.exit(0); }
r = await api('POST', '/fs', { code: CODE, data: {
  code: CODE, name: 'Cerrada de Prueba (ficticia)', houses: 10, adminPin: P.admin, adminName: 'Admin Prueba', adminPhone: '+00 0000 0000',
  price: 0, active: true, suspended: false, portones: [{ id: 'p1', label: 'Porton prueba', ip: '', shellyId: '', time: 5, icon: '' }],
  history: [], movements: [], cuotas: {}, cuotaConfig: {}, createdAt: new Date().toISOString(),
  residents: [
    { house: 'Casa 1', name: 'Ana Prueba', phone: '', active: true, mora: false, moraNote: '', members: [], pendingReg: true },
    { house: 'Casa 2', name: 'Carlos Prueba', phone: '', email: E.carlos, active: true, mora: false, moraNote: '', members: [], pendingReg: false },
    { house: 'Casa 3', name: 'Dora Prueba', phone: '', active: true, mora: false, moraNote: '', members: [], pendingReg: true }
  ] } });
step('S1', 'crear TEST-001 (POST /fs, creación)', r.status === 200 && r.data.ok === true, `HTTP ${r.status} ok=${r.data && r.data.ok}`);
if (!(r.data && r.data.ok)) process.exit(1);

// helper: copia "de navegador" (saneada, con ids) + cambio + push
async function browserPush(mutate) {
  const g = await api('GET', `/fs?code=${CODE}`);
  const rec = g.data.record; mutate(rec);
  return api('POST', '/fs', { code: CODE, data: rec });
}

// S2. Ana: token de invitación (lo escribe el navegador) + registro real por /register
r = await browserPush((rec) => { const c = rec.residents.find((x) => x.house === 'Casa 1'); c.inviteToken = 'TEST-TOK-ANA'; c.inviteExpires = Date.now() + 7 * 864e5; });
step('S2a', 'token de invitación de Casa 1 vía /fs', r.data && r.data.ok === true);
r = await api('POST', '/register', { code: CODE, house: 'Casa 1', token: 'TEST-TOK-ANA', isFamiliar: false, name: 'Ana Prueba', email: E.ana, pin: P.ana });
step('S2b', 'registro de Ana (jefa) por /register', r.data && r.data.ok === true, `HTTP ${r.status}`);
let l = await login(E.ana, P.ana);
step('S2c', 'Ana entra con su PIN', l.status === 200 && l.data.ok === true, `HTTP ${l.status}`);

// S3. Beto (familiar de Casa 1): token + /register isFamiliar
r = await browserPush((rec) => { const c = rec.residents.find((x) => x.house === 'Casa 1'); c.inviteToken = 'TEST-TOK-BETO'; c.inviteExpires = Date.now() + 7 * 864e5; });
step('S3a', 'token de invitación para familiar vía /fs (no borra a Ana)', r.data && r.data.ok === true);
r = await api('POST', '/register', { code: CODE, house: 'Casa 1', token: 'TEST-TOK-BETO', isFamiliar: true, name: 'Beto Prueba', email: E.beto, pin: P.beto });
step('S3b', 'registro de Beto (familiar) por /register', r.data && r.data.ok === true, `HTTP ${r.status}`);
l = await login(E.beto, P.beto);
step('S3c', 'Beto entra con su PIN', l.status === 200 && l.data.ok === true, `HTTP ${l.status}`);

// S4. Carlos: PIN fijado con /admin/set-pin
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.carlos }, newPin: P.carlos });
step('S4a', 'PIN de Carlos con /admin/set-pin', r.status === 200 && r.data.ok === true, `HTTP ${r.status}`);
l = await login(E.carlos, P.carlos);
step('S4b', 'Carlos entra con su PIN', l.status === 200 && l.data.ok === true, `HTTP ${l.status}`);

// S5. Dora: pendiente, sin correo ni PIN
l = await login('dora.prueba@example.test', '0000');
step('S5', 'Dora (pendiente) no puede entrar', l.status === 401, `HTTP ${l.status}`);

// Estado final (saneado)
const g = await api('GET', `/fs?code=${CODE}`);
const res = g.data.record.residents;
console.log('\nESTADO INICIAL TEST-001 (saneado):');
for (const x of res) console.log(` - ${x.house}: id=${x.id ? 'sí' : 'no'} email=${x.email ? 'sí' : 'no'} pendingReg=${x.pendingReg} members=${(x.members || []).length}` + ((x.members || []).map((m) => ` [member id=${m.id ? 'sí' : 'no'}]`).join('')));
