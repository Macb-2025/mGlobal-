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

  let distributeur = null, proprietaire = null;
  if (u.distributeur_id) {
    distributeur = db.prepare(`SELECT d.id, d.slug, d.nom, d.actif, d.gele, d.nature, d.proprietaire_id,
                                      p.actif AS prop_actif
                               FROM distributeurs d
                               LEFT JOIN proprietaires p ON p.id = d.proprietaire_id
                               WHERE d.id = ?`).get(u.distributeur_id);
    // Blocage total : si l'espace (ou son propriétaire parent) est désactivé ou gelé
    // par le super-admin, aucun utilisateur de la boutique ne peut se connecter.
    if (distributeur) {
      const propBloque = distributeur.proprietaire_id != null && !distributeur.prop_actif;
      if (!distributeur.actif || distributeur.gele || propBloque)
        return res.status(403).json({ error: distributeur.gele
          ? 'Espace gelé par le super-admin : accès bloqué'
          : propBloque
            ? 'Espace propriétaire désactivé par le super-admin'
            : 'Espace désactivé par le super-admin' });
    }
  }
  if (u.proprietaire_id) {
    proprietaire = db.prepare(`SELECT id, nom, actif, quota_boutiques FROM proprietaires WHERE id = ?`).get(u.proprietaire_id);
    if (proprietaire && !proprietaire.actif)
      return res.status(403).json({ error: 'Espace propriétaire désactivé par le super-admin' });
  }

  res.json({
    token: signToken(u),
    user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role, distributeur, proprietaire }
  });
});

// Profil courant
r.get('/me', requireAuth, (req, res) => {
  const u = db.prepare(`SELECT id, username, full_name, role, distributeur_id, proprietaire_id FROM users WHERE id = ?`).get(req.user.uid);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  let distributeur = null, proprietaire = null;
  if (u.distributeur_id)
    distributeur = db.prepare(`SELECT id, slug, nom, nature FROM distributeurs WHERE id = ?`).get(u.distributeur_id);
  if (u.proprietaire_id)
    proprietaire = db.prepare(`SELECT id, nom, quota_boutiques FROM proprietaires WHERE id = ?`).get(u.proprietaire_id);
  res.json({ id: u.id, username: u.username, fullName: u.full_name, role: u.role, distributeur, proprietaire });
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
