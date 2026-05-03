// CerradaApp — Cloudflare Worker v4
// GET  /?id=DEVICE&auth=KEY&turn=on|off  → Control Shelly
// POST /notify  { title, body, tokens[] } → Push FCM
// GET  /jb?bin=BIN&key=KEY               → Leer JSONBin
// POST /jb      { bin, key, data }        → Escribir JSONBin
// Cron: cada minuto → ping Shelly

const FIREBASE_SERVER_KEY = 'AIzaSyChuftPnUTXr7KmrVufvMxtmeH14Or0HUU';
const SHELLY_DEVICE = 'e4b063eb85a4';
const SHELLY_AUTH   = 'NDEzZTAzdWlk4C86BD5E1DF2BE2FC2F3C0F4037721A39CDF9388D6B4B15BC5295B801F11A2A689C37770CE435132';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export default {
  async scheduled(event, env, ctx) {
    const body = new URLSearchParams({ id: SHELLY_DEVICE, auth_key: SHELLY_AUTH, channel: '0', turn: 'off' });
    await fetch('https://shelly-258-eu.shelly.cloud/device/relay/control', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
    }).catch(() => {});
  },

  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── RUTA: Proxy JSONBin (para register.html desde WhatsApp)
    if (url.pathname === '/jb') {
      if (request.method === 'GET') {
        const bin = url.searchParams.get('bin');
        const key = url.searchParams.get('key');
        if (!bin || !key) return json({ ok: false, error: 'Faltan bin/key' }, 400);
        try {
          const r = await fetch(`https://api.jsonbin.io/v3/b/${bin}/latest`, {
            headers: { 'X-Master-Key': key }
          });
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

    // ── RUTA: Control Shelly
    if (request.method === 'GET') {
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

    // ── RUTA: Push FCM
    if (request.method === 'POST' && url.pathname === '/notify') {
      try {
        const { title, body, tokens } = await request.json();
        if (!tokens || !tokens.length) return json({ ok: true, sent: 0 });
        const r = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: { 'Authorization': `key=${FIREBASE_SERVER_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            registration_ids: tokens,
            notification: { title, body, icon: 'https://racosta123.github.io/cerradaapp/icon-192.png', vibrate: [200, 100, 200] },
            webpush: { headers: { Urgency: 'high' } }
          })
        });
        const result = await r.json();
        return json({ ok: true, sent: result.success || 0 });
      } catch(e) { return json({ ok: false, error: e.message }, 500); }
    }

    return json({ ok: false, error: 'Ruta no encontrada' }, 404);
  }
};
