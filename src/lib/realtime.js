import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { JWT_SECRET } from './auth.js';

// Hub temps réel : navigateurs (distributeurs) + postes pont bascule.
// Permet de pousser instantanément : nouveaux bons de commande, changements de
// statut (suivi d'avancement) et poids live, sans polling.
let wss = null;

// Chaque client garde son contexte d'autorisation pour le filtrage des messages.
//   kind: 'user' | 'site'
//   role, did (distributeur), siteId
function authClient(url) {
  try {
    const q = new URLSearchParams(url.split('?')[1] || '');
    const token = q.get('token');
    const siteKey = q.get('siteKey');
    if (token) {
      const u = jwt.verify(token, JWT_SECRET);
      return { kind: 'user', role: u.role, did: u.did || null, username: u.username };
    }
    if (siteKey) {
      const site = db.prepare(`SELECT * FROM sites WHERE site_key = ? AND actif = 1`).get(siteKey);
      if (site) return { kind: 'site', siteId: site.id, nom: site.nom };
    }
  } catch { /* token invalide */ }
  return null;
}

export function initRealtime(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const ctx = authClient(req.url || '');
    if (!ctx) { ws.close(4001, 'non autorisé'); return; }
    ws.ctx = ctx;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'hello', kind: ctx.kind, ts: new Date().toISOString() }));
  });

  // Heartbeat : ferme les connexions mortes
  const ping = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);
  wss.on('close', () => clearInterval(ping));
  console.log('[mGlobal Business] WebSocket temps réel prêt sur /ws');
}

// Diffusion ciblée.
//   audience: 'sites'  → tous les postes pont bascule
//             'dist'   → navigateurs d'un distributeur (did) + superadmins
//             'all'    → tout le monde
function send(ws, obj) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

export function emitToSites(type, payload) {
  if (!wss) return;
  for (const ws of wss.clients)
    if (ws.ctx?.kind === 'site') send(ws, { type, ...payload });
}

export function emitToDistributeur(did, type, payload) {
  if (!wss) return;
  for (const ws of wss.clients) {
    const c = ws.ctx;
    if (!c || c.kind !== 'user') continue;
    if (c.role === 'superadmin' || c.did === did) send(ws, { type, ...payload });
  }
}

export function emitToAll(type, payload) {
  if (!wss) return;
  for (const ws of wss.clients) send(ws, { type, ...payload });
}
