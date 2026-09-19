// Pruebas OFFLINE de POST /shelly y de la ruta antigua GET / (Fase 1). fetch está simulado: NO se llama a Shelly real.
// Ejecutar:  node --test worker_shelly.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker_v4.js';

const AUTH = 'CLAVE-SHELLY-DE-PRUEBA';
const FIXED = 'shelly-274-eu.shelly.cloud';
const ENV = { SHELLY_AUTH: AUTH, SHELLY_SERVER: FIXED };

// Ejecuta una petición al Worker con fetch simulado y devuelve lo que "salió" hacia la red.
async function run(method, path, body, env = ENV, rawBody) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || 'GET', body: init.body ? String(init.body) : '' });
    return new Response(JSON.stringify({ isok: true, data: { device_id: 'x' } }), { status: 200 });
  };
  try {
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (rawBody !== undefined) init.body = rawBody; else if (body) init.body = JSON.stringify(body);
    const res = await worker.fetch(new Request('https://w.test' + path, init), env);
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    return { status: res.status, data, text, calls };
  } finally { globalThis.fetch = realFetch; }
}
const form = (s) => Object.fromEntries(new URLSearchParams(s));

// ─────────────────────────────── el flujo ACTUAL sigue funcionando igual
test('flujo actual del cliente: mismo destino, mismos parámetros y respuesta intacta', async () => {
  const r = await run('POST', '/shelly', { shellyId: '34cdb07be470', shellyServer: FIXED, seconds: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, `https://${FIXED}/device/relay/control`);
  assert.equal(r.calls[0].method, 'POST');
  assert.deepEqual(form(r.calls[0].body), { id: '34cdb07be470', auth_key: AUTH, channel: '0', turn: 'on', timer: '5' });
  assert.equal(r.data.isok, true);                       // el cliente lee data.isok: se devuelve la respuesta de Shelly tal cual
});

test('sin la variable SHELLY_SERVER se usa el respaldo (mismo host que hoy)', async () => {
  const r = await run('POST', '/shelly', { shellyId: 'abc123def456', seconds: 5 }, { SHELLY_AUTH: AUTH });
  assert.equal(r.calls[0].url, `https://${FIXED}/device/relay/control`);
});

test('seconds: por defecto 5, tope 60 y valores raros -> 5', async () => {
  const t = async (seconds) => form((await run('POST', '/shelly', { shellyId: 'abc123def456', seconds })).calls[0].body).timer;
  assert.equal(await t(undefined), '5');
  assert.equal(await t(999), '60');
  assert.equal(await t(12), '12');
  assert.equal(await t('abc'), '5');
  assert.equal(await t(0), '5');
});

test('sin shellyId se usa el dispositivo por defecto del Worker (comportamiento actual)', async () => {
  const r = await run('POST', '/shelly', { seconds: 5 });
  assert.equal(form(r.calls[0].body).id, '34cdb07be470');
});

// ─────────────────────────────── el servidor ya NO lo decide el cliente
test('un shellyServer malicioso del cliente se IGNORA: el secret solo viaja al host fijo', async () => {
  const malos = ['evil.example', 'shelly-274-eu.shelly.cloud.evil.com', 'user@evil.com', 'evil.com/x?', 'evil.com:8443', 'localhost', '169.254.169.254'];
  for (const shellyServer of malos) {
    const r = await run('POST', '/shelly', { shellyId: 'abc123def456', shellyServer, seconds: 5 });
    assert.equal(r.calls.length, 1, shellyServer);
    assert.equal(r.calls[0].url, `https://${FIXED}/device/relay/control`, 'destino para ' + shellyServer);
    for (const c of r.calls) assert.equal(c.url.includes('evil') || c.url.includes('localhost') || c.url.includes('169.254'), false);
  }
});

test('SHELLY_SERVER de la configuración manda (y el cliente sigue ignorado)', async () => {
  const r = await run('POST', '/shelly', { shellyId: 'abc123def456', shellyServer: 'evil.example' }, { SHELLY_AUTH: AUTH, SHELLY_SERVER: 'shelly-59-eu.shelly.cloud' });
  assert.equal(r.calls[0].url, 'https://shelly-59-eu.shelly.cloud/device/relay/control');
});

// ─────────────────────────────── ruta antigua GET / apagada
test('la ruta antigua GET /?id=..&auth=..&turn=.. responde 404 y NO llama a Shelly', async () => {
  for (const path of ['/?id=abc123def456&auth=cualquiera&turn=on', '/?id=abc123def456&turn=off', '/?turn=on', '/']) {
    const r = await run('GET', path);
    assert.equal(r.status, 404, path);
    assert.equal(r.calls.length, 0, 'no debe haber ninguna llamada externa: ' + path);
  }
});

test('POST / tampoco hace nada (404) y no llama a Shelly', async () => {
  const r = await run('POST', '/', { id: 'abc123def456', turn: 'on' });
  assert.equal(r.status, 404);
  assert.equal(r.calls.length, 0);
});

// ─────────────────────────────── el resto no cambió
test('cuerpo inválido en /shelly: 500 sin llamar a Shelly (sondeo seguro de "está vivo")', async () => {
  const r = await run('POST', '/shelly', null, ENV, '{no es json');
  assert.equal(r.status, 500);
  assert.equal(r.calls.length, 0);
});

test('preflight CORS y ruta desconocida siguen igual', async () => {
  const opt = await run('OPTIONS', '/shelly');
  assert.equal(opt.status, 200);
  const nf = await run('GET', '/no-existe');
  assert.equal(nf.status, 404);
});

test('el cron de apagado automático sigue enviando "off" al dispositivo fijo', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => { calls.push({ url: String(input), body: String(init.body || '') }); return new Response('{}', { status: 200 }); };
  try { await worker.scheduled({}, { SHELLY_AUTH: AUTH }, {}); } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://${FIXED}/device/relay/control`);
  assert.deepEqual(form(calls[0].body), { id: '34cdb07be470', auth_key: AUTH, channel: '0', turn: 'off' });
});
