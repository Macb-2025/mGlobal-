import { Router } from 'express';
import { customAlphabet } from 'nanoid';
import db from '../lib/db.js';
import { requireAuth, requireRole, hashPassword, requireEspaceActif } from '../lib/auth.js';
import { newKey } from '../lib/db.js';

const r = Router();
r.use(requireAuth);

const codeFournisseur = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

// Rôles d'un espace distributeur. 'operateur' est conservé (compatibilité des
// comptes existants) mais remplacé par 'comptable' et 'assistante' à la création.
const ROLES_DISTRIB = ['admin', 'superviseur', 'comptable', 'assistante', 'operateur'];

// ───────────── Espace : gestion des utilisateurs & rôles ─────────────
// admin distributeur → gère SES utilisateurs ; superadmin → gère tout le monde.

function targetDistributeur(req) {
  if (req.user.role === 'superadmin') return req.body.distributeurId || req.query.distributeurId || null;
  return req.user.did;
}

r.get('/users', requireRole('superadmin', 'admin'), (req, res) => {
  if (req.user.role === 'superadmin') {
    const did = req.query.distributeurId;
    const rows = did
      ? db.prepare(`SELECT u.id,u.username,u.full_name,u.role,u.actif,u.distributeur_id
                    FROM users u WHERE u.distributeur_id = ? ORDER BY u.username`).all(did)
      : db.prepare(`SELECT u.id,u.username,u.full_name,u.role,u.actif,u.distributeur_id
                    FROM users u ORDER BY u.distributeur_id, u.username`).all();
    return res.json(rows);
  }
  const rows = db.prepare(`SELECT id,username,full_name,role,actif,distributeur_id
    FROM users WHERE distributeur_id = ? ORDER BY username`).all(req.user.did);
  res.json(rows);
});

r.post('/users', requireRole('superadmin', 'admin'), requireEspaceActif, (req, res) => {
  const { username, password, fullName, role } = req.body || {};
  const did = targetDistributeur(req);
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  if (!did) return res.status(400).json({ error: 'Distributeur cible requis' });
  if (!ROLES_DISTRIB.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  const exists = db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(String(username).trim());
  if (exists) return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  const info = db.prepare(`INSERT INTO users (distributeur_id, username, password_hash, full_name, role)
    VALUES (?,?,?,?,?)`).run(did, String(username).trim(), hashPassword(password), fullName || '', role);
  res.json({ ok: true, id: info.lastInsertRowid });
});

r.patch('/users/:id', requireRole('superadmin', 'admin'), requireEspaceActif, (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (req.user.role === 'admin' && u.distributeur_id !== req.user.did)
    return res.status(403).json({ error: 'Hors de votre espace' });
  if (u.role === 'superadmin') return res.status(403).json({ error: 'Compte protégé' });
  const { role, actif, password, fullName } = req.body || {};
  if (role && ROLES_DISTRIB.includes(role))
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, u.id);
  if (actif !== undefined)
    db.prepare(`UPDATE users SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, u.id);
  if (password) db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), u.id);
  if (fullName !== undefined) db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(fullName, u.id);
  res.json({ ok: true });
});

r.delete('/users/:id', requireRole('superadmin', 'admin'), requireEspaceActif, (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (req.user.role === 'admin' && u.distributeur_id !== req.user.did)
    return res.status(403).json({ error: 'Hors de votre espace' });
  if (u.role === 'superadmin') return res.status(403).json({ error: 'Compte protégé' });
  db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id);
  res.json({ ok: true });
});

// ───────────── Super-admin : distributeurs & sites ─────────────
r.get('/distributeurs', requireRole('superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.distributeur_id = d.id) AS nbUsers,
           (SELECT COUNT(*) FROM bons_commande b WHERE b.distributeur_id = d.id) AS nbBons
    FROM distributeurs d ORDER BY d.nom`).all();
  res.json(rows);
});

r.post('/distributeurs', requireRole('superadmin'), (req, res) => {
  const { nom, slug } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const s = (slug || nom).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  try {
    const info = db.prepare(`INSERT INTO distributeurs (slug, nom) VALUES (?,?)`).run(s, nom);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Ce distributeur existe déjà' });
  }
});

// Contrôle total du super-admin : activer/désactiver, geler/dégeler, modifier un espace.
r.patch('/distributeurs/:id', requireRole('superadmin'), (req, res) => {
  const d = db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Distributeur introuvable' });
  const { actif, gele, nom } = req.body || {};
  if (actif !== undefined) db.prepare(`UPDATE distributeurs SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, d.id);
  if (gele  !== undefined) db.prepare(`UPDATE distributeurs SET gele  = ? WHERE id = ?`).run(gele ? 1 : 0, d.id);
  if (nom !== undefined && nom.trim()) db.prepare(`UPDATE distributeurs SET nom = ? WHERE id = ?`).run(nom.trim(), d.id);
  const maj = db.prepare(`SELECT id, nom, actif, gele FROM distributeurs WHERE id = ?`).get(d.id);
  res.json({ ok: true, distributeur: maj });
});

// Supprimer un distributeur (et toutes ses données en cascade).
r.delete('/distributeurs/:id', requireRole('superadmin'), (req, res) => {
  const d = db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Distributeur introuvable' });
  db.prepare(`DELETE FROM distributeurs WHERE id = ?`).run(d.id);
  // Détacher les sites liés (ne pas les supprimer, juste délier)
  db.prepare(`UPDATE sites SET distributeur_id = NULL WHERE distributeur_id = ?`).run(d.id);
  res.json({ ok: true });
});

// ───────────── Super-admin : comptes fournisseurs (login + mot de passe) ─────────────
// Un compte fournisseur = une entité « fournisseurs » + un utilisateur (rôle 'fournisseur')
// rattaché à un distributeur. Le fournisseur se connecte sur la page de connexion normale.
r.get('/fournisseurs-comptes', requireRole('superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.username, u.full_name, u.actif, u.distributeur_id, u.fournisseur_id,
           f.nom AS fournisseur_nom, f.code AS fournisseur_code, f.telephone, f.solde_dette,
           d.nom AS distributeur_nom
    FROM users u
    JOIN fournisseurs f ON f.id = u.fournisseur_id
    LEFT JOIN distributeurs d ON d.id = u.distributeur_id
    WHERE u.role = 'fournisseur' ORDER BY d.nom, f.nom`).all();
  res.json(rows);
});

r.post('/fournisseurs-comptes', requireRole('superadmin'), (req, res) => {
  const { distributeurId, nom, telephone, adresse, username, password } = req.body || {};
  if (!distributeurId) return res.status(400).json({ error: 'Distributeur requis' });
  if (!nom) return res.status(400).json({ error: 'Nom du fournisseur requis' });
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  const dist = db.prepare(`SELECT id FROM distributeurs WHERE id = ?`).get(distributeurId);
  if (!dist) return res.status(404).json({ error: 'Distributeur introuvable' });
  if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(String(username).trim()))
    return res.status(409).json({ error: 'Cet identifiant existe déjà' });

  let code;
  for (let i = 0; i < 6; i++) {
    code = 'FRN-' + codeFournisseur();
    if (!db.prepare(`SELECT 1 FROM fournisseurs WHERE code = ?`).get(code)) break;
  }
  try {
    const tx = db.transaction(() => {
      const f = db.prepare(`INSERT INTO fournisseurs (distributeur_id, code, nom, telephone, adresse)
        VALUES (?,?,?,?,?)`).run(distributeurId, code, nom, telephone || '', adresse || '');
      const u = db.prepare(`INSERT INTO users (distributeur_id, fournisseur_id, username, password_hash, full_name, role)
        VALUES (?,?,?,?,?, 'fournisseur')`)
        .run(distributeurId, f.lastInsertRowid, String(username).trim(), hashPassword(password), nom);
      return { fournisseurId: f.lastInsertRowid, userId: u.lastInsertRowid };
    });
    const ids = tx();
    res.json({ ok: true, code, ...ids });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

r.patch('/fournisseurs-comptes/:id', requireRole('superadmin'), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'fournisseur'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Compte fournisseur introuvable' });
  const { actif, password, nom, telephone } = req.body || {};
  if (actif !== undefined) db.prepare(`UPDATE users SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, u.id);
  if (password) db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), u.id);
  if (nom !== undefined) {
    db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(nom, u.id);
    db.prepare(`UPDATE fournisseurs SET nom = ? WHERE id = ?`).run(nom, u.fournisseur_id);
  }
  if (telephone !== undefined) db.prepare(`UPDATE fournisseurs SET telephone = ? WHERE id = ?`).run(telephone, u.fournisseur_id);
  res.json({ ok: true });
});

r.delete('/fournisseurs-comptes/:id', requireRole('superadmin'), (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'fournisseur'`).get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Compte fournisseur introuvable' });
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id);
    if (u.fournisseur_id)
      db.prepare(`DELETE FROM fournisseurs WHERE id = ?`).run(u.fournisseur_id);
  });
  tx();
  res.json({ ok: true });
});

// ───────────── Super-admin : sites (ponts bascule) multi-pont ─────────────
r.get('/sites', requireRole('superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.nom, s.site_key, s.actif, s.last_seen, s.created_at,
           s.distributeur_id, d.nom AS distributeur_nom
    FROM sites s LEFT JOIN distributeurs d ON d.id = s.distributeur_id
    ORDER BY s.id`).all();
  res.json(rows);
});

// Créer un nouveau site (pont bascule), optionnellement lié à un distributeur.
r.post('/sites', requireRole('superadmin'), (req, res) => {
  const { nom, distributeur_id } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Nom du pont bascule requis' });
  const sk = newKey();
  const info = db.prepare(`INSERT INTO sites (nom, site_key, distributeur_id) VALUES (?,?,?)`)
    .run(nom, sk, distributeur_id || null);
  // Créer une licence par défaut
  const lk = 'LIC-' + newKey();
  db.prepare(`INSERT INTO licences (site_id, license_key, status) VALUES (?, ?, 'ACTIVE')`)
    .run(info.lastInsertRowid, lk);
  res.json({ ok: true, id: info.lastInsertRowid, site_key: sk, license_key: lk });
});

// Modifier un site (nom, distributeur rattaché, actif).
r.patch('/sites/:id', requireRole('superadmin'), (req, res) => {
  const s = db.prepare(`SELECT * FROM sites WHERE id = ?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Site introuvable' });
  const { nom, distributeur_id, actif } = req.body || {};
  if (nom !== undefined) db.prepare(`UPDATE sites SET nom = ? WHERE id = ?`).run(nom, s.id);
  if (distributeur_id !== undefined)
    db.prepare(`UPDATE sites SET distributeur_id = ? WHERE id = ?`).run(distributeur_id || null, s.id);
  if (actif !== undefined) db.prepare(`UPDATE sites SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, s.id);
  res.json({ ok: true });
});

// Supprimer un site.
r.delete('/sites/:id', requireRole('superadmin'), (req, res) => {
  const info = db.prepare(`DELETE FROM sites WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Site introuvable' });
  res.json({ ok: true });
});

r.post('/sites/:id/rotate', requireRole('superadmin'), (req, res) => {
  const k = newKey();
  db.prepare(`UPDATE sites SET site_key = ? WHERE id = ?`).run(k, req.params.id);
  res.json({ ok: true, site_key: k });
});

export default r;
