// CerradaApp — Cloudflare Worker v5
// GET  /?id=DEVICE&auth=KEY&turn=on|off  → Control Shelly (legacy)
// POST /shelly  { shellyId, shellyServer, seconds }  → Control Shelly v2
// POST /notify  { title, body, tokens[] }            → Push FCM HTTP v1
// GET  /jb?bin=BIN&key=KEY               → Leer JSONBin
// POST /jb      { bin, key, data }        → Escribir JSONBin
// GET  /fs?code=CODE                     → Leer Firestore
// POST /fs      { code, data }            → Escribir Firestore
// POST /register { code, house, token, isFamiliar, name, email, pin } → Registrar usuario
// Cron: cada minuto → ping Shelly

// ── Secrets de Cloudflare requeridos:
// GOOGLE_CREDENTIALS → JSON completo de la cuenta de servicio de Google (service account key)
// SHELLY_AUTH        → clave de autenticación de Shelly Cloud

const SHELLY_DEVICE    = 'e4b063eb85a4';
const FIREBASE_PROJECT = 'cerradaapp-7179e';
const ICON_URL         = 'https://racosta123.github.io/cerradaapp/icons/icon-192x192.png';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// === Hashing de contraseñas (PBKDF2-SHA256) ===
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArr = new Uint8Array(bits);
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...hashArr].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$100000$${saltHex}$${hashHex}`;
}

async function verifyPassword(password, stored) {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = new Uint8Array(parts[2].match(/.{2}/g).map(h => parseInt(h, 16)));
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      keyMaterial, 256
    );
    const hashArr = new Uint8Array(bits);
    const hashHex = [...hashArr].map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === parts[3];
  } catch (e) {
    return false;
  }
}

// ── Genera un OAuth2 Access Token para cualquier scope de Google
async function getGoogleToken(scope, env) {
  const creds = JSON.parse(env.GOOGLE_CREDENTIALS);
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const b64url = str => btoa(str).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const headerB64  = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const toSign     = `${headerB64}.${payloadB64}`;

  const pem     = creds.private_key.replace(/\\n/g, '\n');
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyBuf  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8', keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(sig)));
  const jwt    = `${toSign}.${sigB64}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No se obtuvo access_token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Convierte un valor JS al formato tipado de Firestore REST API
function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFS) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFS(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// ── Convierte un valor tipado de Firestore a JS nativo
function fromFS(val) {
  if (!val) return null;
  if ('nullValue'    in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return parseInt(val.integerValue);
  if ('doubleValue'  in val) return val.doubleValue;
  if ('stringValue'  in val) return val.stringValue;
  if ('arrayValue'   in val) return (val.arrayValue.values || []).map(fromFS);
  if ('mapValue'     in val) {
    const obj = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) obj[k] = fromFS(v);
    return obj;
  }
  return null;
}

function docToObj(doc) {
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = fromFS(v);
  return obj;
}

function objToDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFS(v);
  return { fields };
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ── Devuelve una copia profunda de la cerrada SIN credenciales (para exponer al navegador)
function sanitizeCerrada(cerrada) {
  const c = JSON.parse(JSON.stringify(cerrada));
  if (Array.isArray(c.residents)) {
    for (const r of c.residents) {
      delete r.pin; delete r.password;
      if (Array.isArray(r.members)) {
        for (const m of r.members) { delete m.pin; delete m.password; }
      }
    }
  }
  if (c.adminPin) delete c.adminPin;
  return c;
}

// ── Leer cerrada de Firestore
async function fsRead(code, env) {
  const token = await getGoogleToken('https://www.googleapis.com/auth/datastore', env);
  const r = await fetch(`${FS_BASE}/cerradas/${encodeURIComponent(code)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const doc = await r.json();
  if (!doc.fields) return null;
  return docToObj(doc);
}

// ── Escribir/actualizar cerrada en Firestore (PATCH = crear o reemplazar)
async function fsWrite(code, data, env) {
  const token = await getGoogleToken('https://www.googleapis.com/auth/datastore', env);
  const r = await fetch(`${FS_BASE}/cerradas/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(objToDoc(data))
  });
  return r.ok;
}

// ── Envía una notificación FCM a UN token via HTTP v1
async function sendFCMv1(token, title, body, accessToken) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          webpush: {
            notification: {
              title, body,
              icon:    ICON_URL,
              vibrate: [200, 100, 200]
            },
            headers: { Urgency: 'high' }
          }
        }
      })
    }
  );
  return res.ok;
}

export default {
  // Cron: apagar relay Shelly cada minuto como seguridad
  async scheduled(event, env, ctx) {
    const auth = env.SHELLY_AUTH || '';
    const body = new URLSearchParams({ id: SHELLY_DEVICE, auth_key: auth, channel: '0', turn: 'off' });
    await fetch('https://shelly-258-eu.shelly.cloud/device/relay/control', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
    }).catch(() => {});
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── Control Shelly (POST /shelly)
    if (request.method === 'POST' && url.pathname === '/shelly') {
      try {
        const { shellyId, shellyServer, seconds } = await request.json();
        const id   = shellyId   || SHELLY_DEVICE;
        const srv  = shellyServer || 'shelly-258-eu.shelly.cloud';
        const auth = env.SHELLY_AUTH || '';
        const sec  = Math.min(parseInt(seconds) || 5, 60);

        const body = new URLSearchParams({ id, auth_key: auth, channel: '0', turn: 'on', timer: String(sec) });
        const r = await fetch(`https://${srv}/device/relay/control`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
        });
        const data = await r.text();
        return new Response(data, { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Control Shelly (GET legacy)
    if (request.method === 'GET' && url.pathname === '/') {
      const turn = url.searchParams.get('turn') || 'on';
      const id   = url.searchParams.get('id');
      const auth = url.searchParams.get('auth');
      if (!id || !auth) return json({ ok: false, error: 'Faltan parametros id/auth' }, 400);
      const body = new URLSearchParams({ id, auth_key: auth, channel: '0', turn });
      try {
        const r = await fetch('https://shelly-258-eu.shelly.cloud/device/relay/control', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
        });
        const data = await r.text();
        return new Response(data, { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Push FCM HTTP v1 (POST /notify)
    if (request.method === 'POST' && url.pathname === '/notify') {
      try {
        const { title, body, tokens } = await request.json();
        if (!tokens || !tokens.length) return json({ ok: true, sent: 0 });

        const accessToken = await getGoogleToken('https://www.googleapis.com/auth/firebase.messaging', env);

        const results = await Promise.allSettled(
          tokens.map(t => sendFCMv1(t, title, body, accessToken))
        );

        const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
        return json({ ok: true, sent, total: tokens.length });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Leer Firestore (GET /fs?code=CODE)
    if (request.method === 'GET' && url.pathname === '/fs') {
      const code = url.searchParams.get('code');
      if (!code) return json({ ok: false, error: 'Falta code' }, 400);
      try {
        const record = await fsRead(code, env);
        if (!record) return json({ ok: false, error: 'No encontrado' }, 404);
        return json({ ok: true, record: sanitizeCerrada(record) });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Escribir Firestore (POST /fs)
    if (request.method === 'POST' && url.pathname === '/fs') {
      try {
        const { code, data } = await request.json();
        if (!code || !data) return json({ ok: false, error: 'Faltan code/data' }, 400);
        const ok = await fsWrite(code, data, env);
        return json({ ok });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Login server-side (POST /login) — verifica credenciales y devuelve datos mínimos
    if (request.method === 'POST' && url.pathname === '/login') {
      try {
        const body = await request.json();
        const mode = body.mode || 'resident'; // compatibilidad hacia atrás

        // ── MASTER — usuario + clave maestra desde secrets
        if (mode === 'master') {
          const { user, pass } = body;
          if (!user || !pass) return json({ ok: false, error: 'Faltan datos' }, 400);
          // TODO: mover a secrets antes de producción
          const MASTER_USER = env.MASTER_USER || 'MASTER';
          const MASTER_KEY  = env.MASTER_KEY  || 'MASTER2025';
          if (user === MASTER_USER && pass === MASTER_KEY) {
            return json({ ok: true, user: { role: 'master' } });
          }
          return json({ ok: false, error: 'Credenciales incorrectas' }, 401);
        }

        // ── ADMIN — código de cerrada + adminPin
        if (mode === 'admin') {
          const { code, pass } = body;
          if (!code || !pass) return json({ ok: false, error: 'Faltan datos' }, 400);

          const cerrada = await fsRead(code, env);
          // No revelar si la cerrada existe: mismo fallo que credenciales incorrectas
          if (!cerrada) return json({ ok: false, error: 'Credenciales incorrectas' }, 401);

          const stored = cerrada.adminPin;
          let okPass = false;
          if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) {
            okPass = await verifyPassword(pass, stored);
          } else if (stored != null) {
            okPass = pass === String(stored);
          }

          if (!okPass) return json({ ok: false, error: 'Credenciales incorrectas' }, 401);
          return json({ ok: true, user: { role: 'admin', cerradaCode: cerrada.code || code } });
        }

        // ── RESIDENT (por defecto) — email + pass
        const { code, email, pass } = body;
        if (!code || !email || !pass) {
          return json({ ok: false, error: 'Faltan datos' }, 400);
        }

        const cerrada = await fsRead(code, env);
        // No revelar si la cerrada existe: mismo fallo que credenciales incorrectas
        if (!cerrada) return json({ ok: false, error: 'Credenciales incorrectas' }, 401);

        const wanted = String(email).trim().toLowerCase();

        // Buscar coincidencia por email en residents[] y sus members[]
        let match = null; // { user, house, role }
        for (const res of cerrada.residents || []) {
          if (res.email && String(res.email).trim().toLowerCase() === wanted) {
            match = { user: res, house: res.house, role: res.role || res.rol || 'resident' };
            break;
          }
          for (const m of res.members || []) {
            if (m.email && String(m.email).trim().toLowerCase() === wanted) {
              match = { user: m, house: res.house, role: m.role || m.rol || 'family' };
              break;
            }
          }
          if (match) break;
        }

        if (!match) return json({ ok: false, error: 'Credenciales incorrectas' }, 401);

        // Verificar contraseña con compatibilidad temporal (hash pbkdf2 o texto plano legacy)
        const stored = match.user.password ?? match.user.pin;
        let okPass = false;
        if (typeof stored === 'string' && stored.startsWith('pbkdf2$')) {
          okPass = await verifyPassword(pass, stored);
        } else if (stored != null) {
          okPass = pass === stored;
        }

        if (!okPass) return json({ ok: false, error: 'Credenciales incorrectas' }, 401);

        // Devolver SOLO datos mínimos — nunca password/pin ni la lista completa
        return json({
          ok: true,
          user: {
            name:  match.user.name,
            email: match.user.email,
            house: match.house,
            role:  match.role,
            code:  cerrada.code || code
          }
        });
      } catch(e) { return json({ ok: false, error: 'Error interno' }, 500); }
    }

    // ── Registro de usuario (POST /register)
    if (request.method === 'POST' && url.pathname === '/register') {
      try {
        const { code, house, token: inviteToken, isFamiliar, name, email, pin } = await request.json();
        if (!code || !house || !inviteToken || !name || !email || !pin) {
          return json({ ok: false, error: 'Faltan campos requeridos' }, 400);
        }

        // Validaciones básicas
        if (pin.length < 4 || !/^\d+$/.test(pin)) {
          return json({ ok: false, error: 'PIN inválido' }, 400);
        }
        if (!email.includes('@')) {
          return json({ ok: false, error: 'Correo inválido' }, 400);
        }

        // Hashear el pin una sola vez — nunca se almacena en texto plano
        const pinHash = await hashPassword(pin);

        // Leer cerrada actualizada de Firestore
        const cerrada = await fsRead(code, env);
        if (!cerrada) return json({ ok: false, error: 'Cerrada no encontrada' }, 404);

        // Encontrar la casa
        const resIdx = (cerrada.residents || []).findIndex(r => r.house === house);
        if (resIdx < 0) return json({ ok: false, error: 'Casa no encontrada' }, 404);

        const res = cerrada.residents[resIdx];

        // Validar token de invitación
        if (!res.inviteToken || res.inviteToken !== inviteToken) {
          return json({ ok: false, error: 'Token de invitación inválido' }, 403);
        }

        // Validar expiración (7 días)
        if (res.inviteExpires && Date.now() > res.inviteExpires) {
          return json({ ok: false, error: 'Invitación expirada — pide una nueva al administrador' }, 403);
        }

        // Verificar que el correo no esté registrado ya en otra casa
        const emailUsado = (cerrada.residents || []).some((r, idx) => {
          if (idx === resIdx) return r.email === email && !isFamiliar;
          if (r.email === email) return true;
          return (r.members || []).some(m => m.email === email);
        });
        if (emailUsado) return json({ ok: false, error: 'Este correo ya está registrado' }, 409);

        if (!res.members) res.members = [];

        if (isFamiliar) {
          // Agregar familiar
          if (res.members.length >= 5) {
            return json({ ok: false, error: 'Esta casa ya tiene el máximo de 5 miembros' }, 400);
          }
          res.members.push({
            name,
            email,
            pin: pinHash,
            role: 'family',
            active: true,
            suspended: false,
            registeredAt: new Date().toISOString()
          });
        } else {
          // Registrar como jefe de familia
          res.name        = name;
          res.email       = email;
          res.pin         = pinHash;
          res.pendingReg  = false;
          res.registeredAt = new Date().toISOString();
        }

        // Invalidar el token (uso único)
        delete res.inviteToken;
        delete res.inviteExpires;

        cerrada.residents[resIdx] = res;
        cerrada.updatedAt = new Date().toISOString();

        const ok = await fsWrite(code, cerrada, env);
        return json({ ok });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    // ── Proxy JSONBin (GET /jb)
    if (url.pathname === '/jb') {
      if (request.method === 'GET') {
        const bin = url.searchParams.get('bin');
        const key = url.searchParams.get('key');
        if (!bin || !key) return json({ ok: false, error: 'Faltan bin/key' }, 400);
        try {
          const r    = await fetch(`https://api.jsonbin.io/v3/b/${bin}/latest`, { headers: { 'X-Master-Key': key } });
          const data = await r.json();
          return json({ ok: true, record: data.record });
        } catch(e) { return json({ ok: false, error: e.message }, 500); }
      }
      if (request.method === 'POST') {
        try {
          const { bin, key, data } = await request.json();
          if (!bin || !key || !data) return json({ ok: false, error: 'Faltan parametros' }, 400);
          const r = await fetch(`https://api.jsonbin.io/v3/b/${bin}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Master-Key': key },
            body: JSON.stringify(data)
          });
          return json({ ok: r.ok });
        } catch(e) { return json({ ok: false, error: e.message }, 500); }
      }
    }

    return json({ ok: false, error: 'Ruta no encontrada' }, 404);
  }
};
