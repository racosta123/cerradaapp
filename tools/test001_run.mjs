// Secuencia de pruebas a–e contra TEST-001 (Firestore real, vía Worker). Solo escribe en TEST-001.
const W = 'https://shelly-proxy.acosta4770.workers.dev';
const CODE = 'TEST-001';
let P = { admin: '4827', ana: '2468', beto: '1357', carlos: '3690' };
const E = { ana: 'ana.prueba@example.test', beto: 'beto.prueba@example.test', carlos: 'carlos.prueba@example.test', dora: 'dora.prueba@example.test' };
let fails = 0;

async function api(method, path, body) {
  if (method === 'POST' && body && body.code !== CODE && !(path === '/login')) throw new Error('ABORTADO: solo se escribe en ' + CODE);
  const r = await fetch(W + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const chk = (id, txt, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK ' : 'FALLA'} ${id} ${txt}${extra ? ' — ' + extra : ''}`); };
const loginRes = (email, pass) => api('POST', '/login', { mode: 'resident', code: CODE, email, pass });
const loginAdm = (pass) => api('POST', '/login', { mode: 'admin', code: CODE, pass });
const getRec = async () => (await api('GET', `/fs?code=${CODE}`)).data.record;
const push = (rec, removed) => api('POST', '/fs', { code: CODE, data: rec, ...(removed ? { removed } : {}) });
const okLogin = (r) => r.status === 200 && r.data && r.data.ok === true;
async function allLoginsOk(label, pins = P) {
  const rs = [await loginRes(E.ana, pins.ana), await loginRes(E.beto, pins.beto), await loginRes(E.carlos, pins.carlos), await loginAdm(pins.admin)];
  chk(label, 'logins vigentes (Ana, Beto, Carlos, admin)', rs.every(okLogin), rs.map((x) => x.status).join('/'));
}
const snapIds = (rec) => JSON.stringify(rec.residents.map((r) => [r.house, r.id, (r.members || []).map((m) => m.id)]));

const initial = await getRec();
const ids0 = snapIds(initial);
console.log('línea base TEST-001:', initial.residents.length, 'residentes;', initial.residents.reduce((a, r) => a + (r.members || []).length, 0), 'familiar(es)\n');
await allLoginsOk('base', P);

console.log('\n=== (a) fsPush "malo": residents SIN pin (copia saneada del navegador) ===');
let rec = await getRec();
rec.residents.find((r) => r.house === 'Casa 2').phone = '555-0101';         // cambio legítimo del admin
let r = await push(rec);
chk('a1', 'POST /fs con residents sin pin', r.data && r.data.ok === true, `HTTP ${r.status}`);
await allLoginsOk('a1', P);
chk('a1', 'el cambio legítimo SÍ se aplicó (teléfono de Casa 2)', (await getRec()).residents.find((x) => x.house === 'Casa 2').phone === '555-0101');

rec = await getRec();                                                        // intento de forjar credenciales
rec.adminPin = '0000';
rec.residents.find((x) => x.house === 'Casa 1').pin = '0000';
rec.residents.find((x) => x.house === 'Casa 1').members[0].pin = '0000';
rec.residents.find((x) => x.house === 'Casa 2').password = 'hack';
r = await push(rec);
chk('a2', 'push con pin/adminPin/password FORJADOS', r.data && r.data.ok === true, `HTTP ${r.status}`);
await allLoginsOk('a2', P);
const forged = [await loginRes(E.ana, '0000'), await loginRes(E.beto, '0000'), await loginRes(E.carlos, 'hack'), await loginAdm('0000')];
chk('a2', 'los valores forjados NO sirven para entrar', forged.every((x) => x.status === 401), forged.map((x) => x.status).join('/'));

rec = await getRec();                                                        // copia vieja: solo conoce Casa 3, sin el familiar
rec.residents = rec.residents.filter((x) => x.house === 'Casa 1'); rec.residents[0].members = [];
r = await push(rec);
chk('a3', 'push de copia VIEJA (solo Casa 1 y sin su familiar; faltan Casa 2 y Casa 3)', r.data && r.data.ok === true, `HTTP ${r.status}`);
await allLoginsOk('a3', P);
const after3 = await getRec();
chk('a3', 'los residentes/familiar ausentes se conservaron', after3.residents.length === 3 && after3.residents.find((x) => x.house === 'Casa 1').members.length === 1);

rec = await getRec();                                                        // familiar inyectado desde el navegador
rec.residents.find((x) => x.house === 'Casa 2').members = [{ name: 'Falso', email: 'falso@example.test', pin: '1111', role: 'family' }];
r = await push(rec);
const falso = await loginRes('falso@example.test', '1111');
chk('a4', 'familiar NUEVO enviado por el navegador se descarta', r.data.ok === true && falso.status === 401 && (await getRec()).residents.find((x) => x.house === 'Casa 2').members.length === 0, `login falso HTTP ${falso.status}`);

rec = await getRec();                                                        // borrado explícito (residente temporal)
rec.residents.push({ house: 'Casa 9 TEMP', name: 'Temporal', phone: '', active: true, mora: false, moraNote: '', members: [], pendingReg: true });
await push(rec);
let withTemp = await getRec();
const hadTemp = withTemp.residents.some((x) => x.house === 'Casa 9 TEMP');
const tempId = (withTemp.residents.find((x) => x.house === 'Casa 9 TEMP') || {}).id;
withTemp.residents = withTemp.residents.filter((x) => x.house !== 'Casa 9 TEMP');
await push(withTemp);                                                        // sin removed: NO debe borrarse
const keptWithoutRemoved = (await getRec()).residents.some((x) => x.house === 'Casa 9 TEMP');
await push(withTemp, { residents: [{ id: tempId }] });                       // con removed: sí
const goneWithRemoved = !(await getRec()).residents.some((x) => x.house === 'Casa 9 TEMP');
chk('a5', 'residente temporal: se agrega, NO se borra sin removed, SÍ se borra con removed', hadTemp && keptWithoutRemoved && goneWithRemoved, `agregado=${hadTemp} sinRemoved=${keptWithoutRemoved ? 'sigue' : 'borrado'} conRemoved=${goneWithRemoved ? 'borrado' : 'sigue'}`);
await allLoginsOk('a5', P);

console.log('\n=== (c) /admin/set-pin ===');
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: 'mal', target: { email: E.ana }, newPin: '9753' });
chk('c0', 'adminPin incorrecto -> 401', r.status === 401, `HTTP ${r.status}`);
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.ana }, newPin: '12ab' });
chk('c0', 'PIN inválido (no numérico) -> 400', r.status === 400, `HTTP ${r.status}`);
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { house: 'Casa 3' }, newPin: '9753' });
chk('c0', 'residente sin correo/registro -> no permite fijar PIN', r.status === 404 || r.status === 409, `HTTP ${r.status}`);
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.ana }, newPin: '9753' });
chk('c1', 'set-pin de Ana -> 9753', r.status === 200 && r.data.ok === true, `HTTP ${r.status}`);
const cNew = await loginRes(E.ana, '9753'), cOld = await loginRes(E.ana, P.ana);
chk('c2', 'Ana entra con el PIN nuevo', okLogin(cNew), `HTTP ${cNew.status}`);
chk('c2', 'el PIN anterior de Ana ya no sirve', cOld.status === 401, `HTTP ${cOld.status}`);
r = await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.ana, member: { email: E.beto } }, newPin: '8642' });
const bNew = await loginRes(E.beto, '8642');
chk('c3', 'set-pin de un FAMILIAR (Beto) y entra con él', r.status === 200 && okLogin(bNew), `HTTP ${r.status}/${bNew.status}`);
await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.ana }, newPin: P.ana });      // restaurar fixture
await api('POST', '/admin/set-pin', { code: CODE, adminPin: P.admin, target: { email: E.ana, member: { email: E.beto } }, newPin: P.beto });
await allLoginsOk('c4', P);

console.log('\n=== (d) /admin/change-pin ===');
r = await api('POST', '/admin/change-pin', { code: CODE, oldPin: 'mal', newPin: '5931' });
chk('d0', 'PIN actual incorrecto -> 401', r.status === 401, `HTTP ${r.status}`);
r = await api('POST', '/admin/change-pin', { code: CODE, oldPin: P.admin, newPin: '12' });
chk('d0', 'PIN nuevo inválido -> 400', r.status === 400, `HTTP ${r.status}`);
r = await api('POST', '/admin/change-pin', { code: CODE, oldPin: P.admin, newPin: '5931' });
chk('d1', 'change-pin del admin 4827 -> 5931', r.status === 200 && r.data.ok === true, `HTTP ${r.status}`);
const dNew = await loginAdm('5931'), dOld = await loginAdm(P.admin);
chk('d2', 'login admin con el PIN nuevo', okLogin(dNew), `HTTP ${dNew.status}`);
chk('d2', 'el PIN anterior del admin ya no sirve', dOld.status === 401, `HTTP ${dOld.status}`);
const resOk = [await loginRes(E.ana, P.ana), await loginRes(E.beto, P.beto), await loginRes(E.carlos, P.carlos)];
chk('d3', 'los PIN de residentes siguen intactos tras cambiar el del admin', resOk.every(okLogin), resOk.map((x) => x.status).join('/'));
await api('POST', '/admin/change-pin', { code: CODE, oldPin: '5931', newPin: P.admin });                               // restaurar fixture
chk('d4', 'PIN del admin restaurado a su valor de fixture', okLogin(await loginAdm(P.admin)));

console.log('\n=== (e) ids inmutables ===');
const final1 = await getRec(), final2 = await getRec();
const allHaveIds = final1.residents.every((x) => x.id && (x.members || []).every((m) => m.id));
chk('e1', 'todos los residentes y familiares tienen id', allHaveIds, `${final1.residents.length} residentes, ${final1.residents.reduce((a, x) => a + (x.members || []).length, 0)} familiar(es)`);
chk('e2', 'los ids son estables entre lecturas (persistidos)', snapIds(final1) === snapIds(final2));
chk('e3', 'los ids no cambiaron tras todos los pushes, renombres y PIN', snapIds(final1) === ids0);
chk('e4', 'la respuesta sigue saneada (sin pin/adminPin)', !('adminPin' in final1) && final1.residents.every((x) => !('pin' in x) && !('password' in x) && (x.members || []).every((m) => !('pin' in m))));

console.log(fails === 0 ? '\nRESULTADO: todas las comprobaciones OK' : `\nRESULTADO: ${fails} comprobación(es) FALLARON`);
