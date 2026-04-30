// CerradaApp Service Worker — v4
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyChuftPnUTXr7KmrVufvMxtmeH14Or0HUU",
  authDomain: "cerradaapp-7179e.firebaseapp.com",
  projectId: "cerradaapp-7179e",
  storageBucket: "cerradaapp-7179e.firebasestorage.app",
  messagingSenderId: "481439052062",
  appId: "1:481439052062:web:c3a0a104bae74763cf590f"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'CerradaApp', {
    body: body || '',
    icon: '/cerradaapp/icon-192.png',
    badge: '/cerradaapp/icon-192.png',
    vibrate: [200, 100, 200]
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window',includeUncontrolled:true}).then(cs => {
      const ex = cs.find(c => c.url.includes('cerradaapp'));
      if (ex) return ex.focus();
      return clients.openWindow('https://racosta123.github.io/cerradaapp/');
    })
  );
});

const CACHE = 'cerradaapp-v4';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/cerradaapp/','/cerradaapp/index.html'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.searchParams.has('reg')) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(fetch(e.request).then(res=>{const clone=res.clone();caches.open(CACHE).then(c=>c.put(e.request,clone));return res;}).catch(()=>caches.match(e.request)));
});
