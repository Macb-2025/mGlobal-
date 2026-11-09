import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, requireEspaceActif } from '../lib/auth.js';
import { peutContacter, utilisateurActif, membresConversation, estMembre } from '../lib/messagerie.js';

// Dans un groupe, chaque membre peut lire chaque autre : toutes les paires doivent être autorisées.
const groupeCompatible = (users) =>
  users.every((a, i) => a && users.slice(i + 1).every(b => peutContacter(a, b)));
import { emitToUsers, estEnLigne } from '../lib/realtime.js';

// Messagerie interne : distributeurs (tous rôles), fournisseurs et super-admin.
const r = Router();
r.use(requireAuth, requireEspaceActif);
r.use((req, res, next) => utilisateurActif(req.user.uid) ? next() : res.status(401).json({ error: 'Compte inactif' }));

const MAX_MESSAGE = 4000;
const moi = (req) => utilisateurActif(req.user.uid);

const nomDistributeur = (id) => id
  ? db.prepare(`SELECT nom FROM distributeurs WHERE id = ?`).get(id)?.nom || null
  : null;

function profil(u) {
  return { id: u.id, username: u.username, fullName: u.full_name || u.username, role: u.role,
    distributeur: nomDistributeur(u.distributeur_id), enLigne: estEnLigne(u.id) };
}

// Vue d'une conversation pour un utilisateur : membres, dernier message, non-lus.
function vueConversation(convId, userId) {
  const c = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId);
  if (!c) return null;
  const membres = db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.distributeur_id
    FROM conversation_membres m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? ORDER BY u.full_name, u.username`).all(convId).map(profil);
  const lu = db.prepare(`SELECT dernier_lu_id FROM conversation_membres
    WHERE conversation_id = ? AND user_id = ?`).get(convId, userId)?.dernier_lu_id || 0;
  const dernier = db.prepare(`SELECT m.id, m.contenu, m.created_at, m.auteur_id,
      COALESCE(u.full_name, u.username) AS auteur
    FROM messages m LEFT JOIN users u ON u.id = m.auteur_id
    WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`).get(convId) || null;
  const nonLus = db.prepare(`SELECT COUNT(*) n FROM messages
    WHERE conversation_id = ? AND id > ? AND (auteur_id IS NULL OR auteur_id != ?)`)
    .get(convId, lu, userId).n;
  const autres = membres.filter(m => m.id !== userId);
  const titre = c.type === 'groupe'
    ? (c.titre || autres.map(m => m.fullName).join(', ') || 'Groupe')
    : (autres[0]?.fullName || 'Conversation');
  return { id: c.id, type: c.type, titre, creePar: c.cree_par, updatedAt: c.updated_at,
    membres, dernier, nonLus };
}

function messageVue(id) {
  return db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.contenu, m.created_at AS createdAt,
      m.auteur_id AS auteurId, COALESCE(u.full_name, u.username, 'Compte supprimé') AS auteur, u.role AS auteurRole
    FROM messages m LEFT JOIN users u ON u.id = m.auteur_id WHERE m.id = ?`).get(id);
}

// Prévient chaque membre que la conversation a changé (vue personnalisée : non-lus).
function notifierConversation(convId, type = 'conv:maj') {
  for (const uid of membresConversation(convId))
    emitToUsers([uid], type, { conversation: vueConversation(convId, uid) });
}

function conversationAutorisee(req, res) {
  const id = Number(req.params.id);
  if (!estMembre(id, req.user.uid)) {
    res.status(404).json({ error: 'Conversation introuvable' });
    return null;
  }
  return id;
}

// ───────────── Contacts joignables ─────────────
r.get('/contacts', (req, res) => {
  const me = moi(req);
  if (!me) return res.status(401).json({ error: 'Compte inactif' });
  const candidats = me.role === 'superadmin'
    ? db.prepare(`SELECT id, username, full_name, role, distributeur_id FROM users WHERE actif = 1`).all()
    : db.prepare(`SELECT id, username, full_name, role, distributeur_id FROM users
        WHERE actif = 1 AND (distributeur_id = ? OR role = 'superadmin')`).all(me.distributeur_id);
  const rows = candidats.filter(u => peutContacter(me, u)).map(profil)
    .sort((a, b) => (a.distributeur || '').localeCompare(b.distributeur || '') || a.fullName.localeCompare(b.fullName));
  res.json(rows);
});

// ───────────── Conversations ─────────────
r.get('/conversations', (req, res) => {
  const ids = db.prepare(`SELECT c.id FROM conversations c
    JOIN conversation_membres m ON m.conversation_id = c.id AND m.user_id = ?
    ORDER BY c.updated_at DESC, c.id DESC`).all(req.user.uid).map(x => x.id);
  res.json(ids.map(id => vueConversation(id, req.user.uid)));
});

r.get('/non-lus', (req, res) => {
  const n = db.prepare(`SELECT COUNT(*) n FROM messages msg
    JOIN conversation_membres m ON m.conversation_id = msg.conversation_id AND m.user_id = ?
    WHERE msg.id > m.dernier_lu_id AND (msg.auteur_id IS NULL OR msg.auteur_id != ?)`)
    .get(req.user.uid, req.user.uid).n;
  res.json({ nonLus: n });
});

// Ouvre (ou retrouve) une conversation directe, ou crée un groupe.
r.post('/conversations', (req, res) => {
  const me = moi(req);
  if (!me) return res.status(401).json({ error: 'Compte inactif' });
  const { type, userId, titre, membres } = req.body || {};

  if (type === 'groupe') {
    const ids = [...new Set((Array.isArray(membres) ? membres : []).map(Number))].filter(id => id && id !== me.id);
    if (!ids.length) return res.status(400).json({ error: 'Choisissez au moins un participant' });
    const users = ids.map(utilisateurActif);
    if (!groupeCompatible([me, ...users]))
      return res.status(403).json({ error: 'Un des participants n\'est pas joignable' });
    const nom = String(titre || '').trim().slice(0, 120);
    if (!nom) return res.status(400).json({ error: 'Nom du groupe requis' });
    const convId = db.transaction(() => {
      const c = db.prepare(`INSERT INTO conversations (type, titre, distributeur_id, cree_par)
        VALUES ('groupe', ?, ?, ?)`).run(nom, me.distributeur_id || null, me.id).lastInsertRowid;
      const add = db.prepare(`INSERT INTO conversation_membres (conversation_id, user_id) VALUES (?, ?)`);
      for (const uid of [me.id, ...ids]) add.run(c, uid);
      return c;
    })();
    notifierConversation(convId, 'conv:nouvelle');
    return res.json(vueConversation(convId, me.id));
  }

  const autre = utilisateurActif(Number(userId));
  if (!peutContacter(me, autre)) return res.status(403).json({ error: 'Ce contact n\'est pas joignable' });
  const existante = db.prepare(`SELECT c.id FROM conversations c
    JOIN conversation_membres a ON a.conversation_id = c.id AND a.user_id = ?
    JOIN conversation_membres b ON b.conversation_id = c.id AND b.user_id = ?
    WHERE c.type = 'direct' LIMIT 1`).get(me.id, autre.id);
  if (existante) return res.json(vueConversation(existante.id, me.id));
  const convId = db.transaction(() => {
    const c = db.prepare(`INSERT INTO conversations (type, distributeur_id, cree_par) VALUES ('direct', ?, ?)`)
      .run(me.distributeur_id || autre.distributeur_id || null, me.id).lastInsertRowid;
    const add = db.prepare(`INSERT INTO conversation_membres (conversation_id, user_id) VALUES (?, ?)`);
    add.run(c, me.id); add.run(c, autre.id);
    return c;
  })();
  res.json(vueConversation(convId, me.id));
});

r.get('/conversations/:id', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  res.json(vueConversation(id, req.user.uid));
});

// ───────────── Messages ─────────────
r.get('/conversations/:id/messages', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const avant = Number(req.query.avant) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(`SELECT m.id FROM messages m WHERE m.conversation_id = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT ?`).all(id, avant, limit).map(x => messageVue(x.id)).reverse();
  // Lecture : position de lecture des autres membres (accusés « Vu »).
  const lectures = db.prepare(`SELECT user_id AS userId, dernier_lu_id AS dernierLuId
    FROM conversation_membres WHERE conversation_id = ? AND user_id != ?`).all(id, req.user.uid);
  res.json({ messages: rows, lectures, plus: rows.length === limit });
});

r.post('/conversations/:id/messages', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const contenu = String(req.body?.contenu || '').trim();
  if (!contenu) return res.status(400).json({ error: 'Message vide' });
  if (contenu.length > MAX_MESSAGE)
    return res.status(400).json({ error: `Message trop long (${MAX_MESSAGE} caractères max.)` });
  const msgId = db.transaction(() => {
    const m = db.prepare(`INSERT INTO messages (conversation_id, auteur_id, contenu) VALUES (?, ?, ?)`)
      .run(id, req.user.uid, contenu).lastInsertRowid;
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(id);
    db.prepare(`UPDATE conversation_membres SET dernier_lu_id = ? WHERE conversation_id = ? AND user_id = ?`)
      .run(m, id, req.user.uid);
    return m;
  })();
  const message = messageVue(msgId);
  for (const uid of membresConversation(id))
    emitToUsers([uid], 'msg:nouveau', { message, conversation: vueConversation(id, uid) });
  res.json(message);
});

// Marque la conversation comme lue jusqu'au dernier message.
r.post('/conversations/:id/lu', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const max = db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM messages WHERE conversation_id = ?`).get(id).m;
  db.prepare(`UPDATE conversation_membres SET dernier_lu_id = ? WHERE conversation_id = ? AND user_id = ?`)
    .run(max, id, req.user.uid);
  const autres = membresConversation(id).filter(u => u !== req.user.uid);
  emitToUsers(autres, 'msg:lu', { conversationId: id, userId: req.user.uid, dernierLuId: max });
  res.json({ ok: true, dernierLuId: max });
});

// ───────────── Gestion des groupes ─────────────
r.post('/conversations/:id/membres', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const c = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  if (c.type !== 'groupe') return res.status(400).json({ error: 'Seuls les groupes acceptent de nouveaux membres' });
  const me = moi(req);
  const ids = [...new Set((req.body?.userIds || []).map(Number))].filter(Boolean);
  const users = ids.map(utilisateurActif);
  const actuels = membresConversation(id);
  const nouveaux = users.filter(u => !u || !actuels.includes(u.id));
  const existants = actuels.map(utilisateurActif).filter(Boolean);
  if (!ids.length || users.some(u => !peutContacter(me, u)) || !groupeCompatible([...existants, ...nouveaux]))
    return res.status(403).json({ error: 'Participant non joignable' });
  const add = db.prepare(`INSERT OR IGNORE INTO conversation_membres (conversation_id, user_id, dernier_lu_id)
    VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?))`);
  db.transaction(() => { for (const uid of ids) add.run(id, uid, id); })();
  notifierConversation(id);
  res.json(vueConversation(id, me.id));
});

r.delete('/conversations/:id/membres/moi', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const c = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  if (c.type !== 'groupe') return res.status(400).json({ error: 'Impossible de quitter une conversation directe' });
  db.prepare(`DELETE FROM conversation_membres WHERE conversation_id = ? AND user_id = ?`).run(id, req.user.uid);
  if (!membresConversation(id).length) db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  else notifierConversation(id);
  res.json({ ok: true });
});

export default r;
