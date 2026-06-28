import { Router } from 'express';
import db from '../lib/db.js';
import { signToken, checkPassword, hashPassword, requireAuth } from '../lib/auth.js';

const r = Router();

// Connexion
r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });

  const u = db.prepare(`SELECT * FROM users WHERE username = ? AND actif = 1`).get(String(username).trim());
  if (!u || !checkPassword(password, u.password_hash))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });

  let distributeur = null;
  if (u.distributeur_id) {
    distributeur = db.prepare(`SELECT id, slug, nom, actif, gele FROM distributeurs WHERE id = ?`).get(u.distributeur_id);
    // Blocage total : si l'espace est désactivé ou gelé par le super-admin, aucun
    // utilisateur du distributeur ne peut se connecter (le super-admin garde l'accès).
    if (distributeur && (!distributeur.actif || distributeur.gele))
      return res.status(403).json({ error: distributeur.gele
        ? 'Espace gelé par le super-admin : accès bloqué'
        : 'Espace désactivé par le super-admin' });
  }

  res.json({
    token: signToken(u),
    user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role, distributeur }
  });
});

// Profil courant
r.get('/me', requireAuth, (req, res) => {
  const u = db.prepare(`SELECT id, username, full_name, role, distributeur_id FROM users WHERE id = ?`).get(req.user.uid);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  let distributeur = null;
  if (u.distributeur_id)
    distributeur = db.prepare(`SELECT id, slug, nom FROM distributeurs WHERE id = ?`).get(u.distributeur_id);
  res.json({ id: u.id, username: u.username, fullName: u.full_name, role: u.role, distributeur });
});

// Changement de mot de passe (soi-même)
r.post('/password', requireAuth, (req, res) => {
  const { current, nouveau } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.uid);
  if (!u || !checkPassword(current || '', u.password_hash))
    return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  if (!nouveau || nouveau.length < 6)
    return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(nouveau), u.id);
  res.json({ ok: true });
});

export default r;
