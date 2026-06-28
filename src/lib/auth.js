import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mglobal-dev-secret-change-me';
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';

export const hashPassword = (p) => bcrypt.hashSync(p, 10);
export const checkPassword = (p, hash) => bcrypt.compareSync(p, hash);

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, did: user.distributeur_id || null,
      fid: user.fournisseur_id || null, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Authentification utilisateur (JWT) → req.user
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée ou invalide' });
  }
}

// Restriction par rôle
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Accès refusé (rôle insuffisant)' });
    next();
  };
}

// Authentification du poste pont bascule (clé de site) → req.site
// Vérifie également le statut de la licence (anti-clonage).
export function requireSite(req, res, next) {
  const k = req.headers['x-site-key'] || req.query.siteKey || '';
  const site = db.prepare(`SELECT * FROM sites WHERE site_key = ? AND actif = 1`).get(k);
  if (!site) return res.status(401).json({ error: 'Clé de liaison invalide' });

  // Vérification licence : refuser les licences révoquées ou expirées.
  const lic = db.prepare(`SELECT status, expires_at FROM licences WHERE site_id = ? ORDER BY id DESC LIMIT 1`)
    .get(site.id);
  if (lic) {
    if (lic.status === 'REVOKED')
      return res.status(403).json({ error: 'Licence révoquée', license_status: 'REVOKED' });
    if (lic.status === 'EXPIRED' || (lic.expires_at && new Date(lic.expires_at) < new Date()))
      return res.status(403).json({ error: 'Licence expirée', license_status: 'EXPIRED' });
  }

  db.prepare(`UPDATE sites SET last_seen = datetime('now') WHERE id = ?`).run(site.id);
  req.site = site;
  next();
}

// Portée tenant : superadmin voit tout ; sinon limité à son distributeur.
// Retourne l'id distributeur effectif (ou null = global pour superadmin).
export function scopeDistributeur(req) {
  if (req.user.role === 'superadmin') {
    const q = req.query.distributeurId;
    return q ? Number(q) : null; // null = tous
  }
  return req.user.did;
}

// État de blocage d'un espace distributeur (désactivé ou gelé par le super-admin).
export function etatDistributeur(did) {
  if (!did) return { existe: false };
  const d = db.prepare(`SELECT id, actif, gele FROM distributeurs WHERE id = ?`).get(did);
  if (!d) return { existe: false };
  return { existe: true, actif: !!d.actif, gele: !!d.gele, bloque: !d.actif || !!d.gele };
}

// Interdit aux super-admins l'accès aux données métier des distributeurs.
export function denySuperadmin(req, res, next) {
  if (req.user.role === 'superadmin')
    return res.status(403).json({ error: 'Le super-admin n\'a pas accès aux données des distributeurs' });
  next();
}

// Interdit aux comptes fournisseurs l'accès aux modules métier du distributeur :
// un fournisseur ne dispose que de son espace dédié (/espace-fournisseur).
export function denyFournisseur(req, res, next) {
  if (req.user.role === 'fournisseur')
    return res.status(403).json({ error: 'Accès réservé à l\'espace fournisseur' });
  next();
}

// Bloque toute action si l'espace du distributeur est désactivé ou gelé.
export function requireEspaceActif(req, res, next) {
  if (req.user.role === 'superadmin') return next();
  const e = etatDistributeur(req.user.did);
  if (!e.existe) return res.status(403).json({ error: 'Espace distributeur introuvable' });
  if (e.bloque)
    return res.status(403).json({ error: e.gele
      ? 'Espace gelé par le super-admin : accès bloqué'
      : 'Espace désactivé par le super-admin' });
  next();
}

export { JWT_SECRET };
