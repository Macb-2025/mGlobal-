import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, requireRole, hashPassword, requireEspaceActif } from '../lib/auth.js';
import { newKey } from '../lib/db.js';

const r = Router();
r.use(requireAuth);

const ROLES_DISTRIB = ['admin', 'superviseur', 'operateur'];

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

// Contrôle total du super-admin : activer/désactiver et geler/dégeler un espace.
r.patch('/distributeurs/:id', requireRole('superadmin'), (req, res) => {
  const d = db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Distributeur introuvable' });
  const { actif, gele } = req.body || {};
  if (actif !== undefined) db.prepare(`UPDATE distributeurs SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, d.id);
  if (gele  !== undefined) db.prepare(`UPDATE distributeurs SET gele  = ? WHERE id = ?`).run(gele ? 1 : 0, d.id);
  const maj = db.prepare(`SELECT id, nom, actif, gele FROM distributeurs WHERE id = ?`).get(d.id);
  res.json({ ok: true, distributeur: maj });
});

r.get('/sites', requireRole('superadmin'), (req, res) => {
  res.json(db.prepare(`SELECT id, nom, site_key, actif, last_seen, created_at FROM sites ORDER BY id`).all());
});

r.post('/sites/:id/rotate', requireRole('superadmin'), (req, res) => {
  const k = newKey();
  db.prepare(`UPDATE sites SET site_key = ? WHERE id = ?`).run(k, req.params.id);
  res.json({ ok: true, site_key: k });
});

export default r;
