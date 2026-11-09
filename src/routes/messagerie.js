import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import db, { DATA_DIR } from '../lib/db.js';
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
const MAX_PIECE = 10 * 1024 * 1024;   // 10 Mo par fichier / message vocal
const MAX_VOCAL_S = 180;
const PIECES_DIR = path.join(DATA_DIR, 'messagerie');
fs.mkdirSync(PIECES_DIR, { recursive: true });
// Types affichables directement (aperçu image, lecteur audio) ; le reste est servi en téléchargement.
const TYPES_INLINE = /^(image\/(png|jpeg|gif|webp)|audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac))$/;
const tailleLisible = (o) => o < 1024 * 1024 ? `${Math.max(1, Math.round(o / 1024))} Ko` : `${(o / 1048576).toFixed(1)} Mo`;
const dureeLisible = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  const m = db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.contenu, m.created_at AS createdAt,
      m.auteur_id AS auteurId, COALESCE(u.full_name, u.username, 'Compte supprimé') AS auteur, u.role AS auteurRole,
      m.piece_fichier, m.piece_nom, m.piece_type, m.piece_taille, m.piece_duree
    FROM messages m LEFT JOIN users u ON u.id = m.auteur_id WHERE m.id = ?`).get(id);
  if (!m) return m;
  const { piece_fichier, piece_nom, piece_type, piece_taille, piece_duree, ...vue } = m;
  vue.piece = piece_fichier
    ? { nom: piece_nom, type: piece_type, taille: piece_taille, duree: piece_duree, vocal: piece_duree != null }
    : null;
  return vue;
}

// Enregistre un message (texte et/ou pièce jointe) et le diffuse aux membres.
function publierMessage(convId, auteurId, contenu, piece = null) {
  const msgId = db.transaction(() => {
    const m = db.prepare(`INSERT INTO messages (conversation_id, auteur_id, contenu,
        piece_fichier, piece_nom, piece_type, piece_taille, piece_duree) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(convId, auteurId, contenu, piece?.fichier ?? null, piece?.nom ?? null, piece?.type ?? null,
        piece?.taille ?? null, piece?.duree ?? null).lastInsertRowid;
    db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(convId);
    db.prepare(`UPDATE conversation_membres SET dernier_lu_id = ? WHERE conversation_id = ? AND user_id = ?`)
      .run(m, convId, auteurId);
    return m;
  })();
  const message = messageVue(msgId);
  for (const uid of membresConversation(convId))
    emitToUsers([uid], 'msg:nouveau', { message, conversation: vueConversation(convId, uid) });
  return message;
}

function supprimerPieces(convId) {
  for (const { f } of db.prepare(`SELECT piece_fichier f FROM messages WHERE conversation_id = ? AND piece_fichier IS NOT NULL`).all(convId))
    fs.rm(path.join(PIECES_DIR, f), { force: true }, () => {});
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
  const lectures = db.prepare(`SELECT user_id AS userId, dernier_lu_id AS dernierLuId, rejoint_apres_id AS depuisId
    FROM conversation_membres WHERE conversation_id = ? AND user_id != ?`).all(id, req.user.uid);
  res.json({ messages: rows, lectures, plus: rows.length === limit });
});

r.post('/conversations/:id/messages', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const contenu = String(req.body?.contenu || '').trim();
  if (!contenu) return res.status(400).json({ error: 'Message vide' });
  if (contenu.length > MAX_MESSAGE)
    return res.status(400).json({ error: `Message trop long (${MAX_MESSAGE} caractères max.)` });
  res.json(publierMessage(id, req.user.uid, contenu));
});

// Pièce jointe : corps brut (fichier ou enregistrement audio), métadonnées en en-têtes.
//   X-Nom-Fichier (encodeURIComponent), X-Type-Fichier (type MIME réel), X-Duree (secondes, messages vocaux)
r.post('/conversations/:id/pieces', (req, res, next) => {
  if (!conversationAutorisee(req, res)) return;
  express.raw({ type: () => true, limit: MAX_PIECE })(req, res, (err) => {
    if (err) return res.status(err.status === 413 ? 413 : 400)
      .json({ error: err.status === 413 ? 'Fichier trop volumineux (10 Mo max.)' : 'Envoi invalide' });
    next();
  });
}, (req, res) => {
  const id = Number(req.params.id);
  const data = req.body;
  if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: 'Fichier vide' });
  let nom = 'fichier';
  try { nom = decodeURIComponent(String(req.get('X-Nom-Fichier') || 'fichier')); } catch {}
  nom = nom.replace(/[\\/\x00-\x1f"]/g, '_').trim().slice(0, 150) || 'fichier';
  const type = String(req.get('X-Type-Fichier') || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
  const dureeBrute = req.get('X-Duree');
  const duree = dureeBrute != null ? Math.round(Number(dureeBrute)) : null;
  if (duree != null) {
    if (!type.startsWith('audio/') || !(duree >= 0)) return res.status(400).json({ error: 'Message vocal invalide' });
    if (duree > MAX_VOCAL_S + 2) return res.status(400).json({ error: 'Message vocal trop long (3 min max.)' });
  }
  const fichier = nanoid(24);
  fs.writeFileSync(path.join(PIECES_DIR, fichier), data);
  const contenu = duree != null ? `🎤 Message vocal (${dureeLisible(duree)})` : `📎 ${nom} (${tailleLisible(data.length)})`;
  res.json(publierMessage(id, req.user.uid, contenu, { fichier, nom, type, taille: data.length, duree }));
});

// Téléchargement d'une pièce jointe, réservé aux membres de la conversation.
r.get('/pieces/:messageId', (req, res) => {
  const m = db.prepare(`SELECT conversation_id c, piece_fichier f, piece_nom n, piece_type t FROM messages WHERE id = ?`)
    .get(Number(req.params.messageId));
  if (!m?.f || !estMembre(m.c, req.user.uid)) return res.status(404).json({ error: 'Fichier introuvable' });
  const chemin = path.join(PIECES_DIR, m.f);
  if (!fs.existsSync(chemin)) return res.status(404).json({ error: 'Fichier introuvable' });
  const inline = TYPES_INLINE.test(m.t || '');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', inline ? m.t : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.n || 'fichier')}`);
  res.sendFile(chemin);
});

// Marque la conversation comme lue jusqu'au dernier message.
r.post('/conversations/:id/lu', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const max = db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM messages WHERE conversation_id = ?`).get(id).m;
  db.prepare(`UPDATE conversation_membres SET dernier_lu_id = ? WHERE conversation_id = ? AND user_id = ?`)
    .run(max, id, req.user.uid);
  const autres = membresConversation(id).filter(u => u !== req.user.uid);
  const { depuisId } = db.prepare(`SELECT rejoint_apres_id AS depuisId FROM conversation_membres
    WHERE conversation_id = ? AND user_id = ?`).get(id, req.user.uid);
  emitToUsers(autres, 'msg:lu', { conversationId: id, userId: req.user.uid, dernierLuId: max, depuisId });
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
  const add = db.prepare(`INSERT OR IGNORE INTO conversation_membres (conversation_id, user_id, dernier_lu_id, rejoint_apres_id)
    VALUES (?, ?, ?, ?)`);
  const max = db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM messages WHERE conversation_id = ?`).get(id).m;
  db.transaction(() => { for (const uid of ids) add.run(id, uid, max, max); })();
  notifierConversation(id);
  res.json(vueConversation(id, me.id));
});

r.delete('/conversations/:id/membres/moi', (req, res) => {
  const id = conversationAutorisee(req, res); if (!id) return;
  const c = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  if (c.type !== 'groupe') return res.status(400).json({ error: 'Impossible de quitter une conversation directe' });
  db.prepare(`DELETE FROM conversation_membres WHERE conversation_id = ? AND user_id = ?`).run(id, req.user.uid);
  if (!membresConversation(id).length) {
    supprimerPieces(id);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }
  else notifierConversation(id);
  res.json({ ok: true });
});

export default r;
