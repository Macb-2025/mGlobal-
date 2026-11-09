import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { JWT_SECRET, etatDistributeur } from './auth.js';
import { peutContacter, estMembre, membresConversation } from './messagerie.js';

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
      const actif = db.prepare(`SELECT 1 FROM users WHERE id = ? AND actif = 1`).get(u.uid);
      if (!actif) return null;
      return { kind: 'user', uid: u.uid, role: u.role, did: u.did || null, username: u.username };
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
    if (ctx.kind !== 'user') return;
    const premiereConnexion = connexionsUtilisateur(ctx.uid) === 1;
    if (premiereConnexion && messagerieAutorisee(ctx)) emitPresence(ctx, true);
    ws.on('message', (raw) => onUserMessage(ws, raw));
    ws.on('close', () => { if (connexionsUtilisateur(ctx.uid) === 0) emitPresence(ctx, false); });
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
  console.log('[mGlobal Cloud] WebSocket temps réel prêt sur /ws');
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

// ───────────── Messagerie : ciblage par utilisateur & présence ─────────────
function connexionsUtilisateur(uid) {
  let n = 0;
  if (!wss) return n;
  for (const ws of wss.clients)
    if (ws.ctx?.kind === 'user' && ws.ctx.uid === uid && ws.readyState === 1) n++;
  return n;
}

export const estEnLigne = (uid) => connexionsUtilisateur(uid) > 0;

// Messagerie : un compte désactivé ou un espace gelé/désactivé ne reçoit plus rien,
// même sur une connexion ouverte avant le blocage.
function messagerieAutorisee(ctx) {
  if (!db.prepare(`SELECT 1 FROM users WHERE id = ? AND actif = 1`).get(ctx.uid)) return false;
  if (ctx.role === 'superadmin') return true;
  const e = etatDistributeur(ctx.did);
  return e.existe && !e.bloque;
}

export function emitToUsers(userIds, type, payload) {
  if (!wss || !userIds?.length) return;
  const cible = new Set(userIds);
  const autorise = new Map();
  for (const ws of wss.clients) {
    const c = ws.ctx;
    if (c?.kind !== 'user' || !cible.has(c.uid)) continue;
    if (!autorise.has(c.uid)) autorise.set(c.uid, messagerieAutorisee(c));
    if (autorise.get(c.uid)) send(ws, { type, ...payload });
  }
}

// Présence (en ligne / hors ligne) diffusée aux seuls contacts autorisés.
function emitPresence(ctx, enLigne) {
  if (!wss) return;
  const moi = { id: ctx.uid, role: ctx.role, distributeur_id: ctx.did };
  for (const ws of wss.clients) {
    const c = ws.ctx;
    if (c?.kind !== 'user' || c.uid === ctx.uid) continue;
    if (peutContacter(moi, { id: c.uid, role: c.role, distributeur_id: c.did }) && messagerieAutorisee(c))
      send(ws, { type: 'presence', userId: ctx.uid, enLigne });
  }
}

// Messages entrants des navigateurs : indicateur « en train d'écrire ».
function onUserMessage(ws, raw) {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m?.type !== 'msg:ecrit' || !messagerieAutorisee(ws.ctx)) return;
  const convId = Number(m.conversationId);
  if (!convId || !estMembre(convId, ws.ctx.uid)) return;
  const autres = membresConversation(convId).filter(u => u !== ws.ctx.uid);
  emitToUsers(autres, 'msg:ecrit', { conversationId: convId, userId: ws.ctx.uid, nom: ws.ctx.username });
}
