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
      pid: user.proprietaire_id || null,
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
export function requireSite(req, res, next) {
  const k = req.headers['x-site-key'] || req.query.siteKey || '';
  const site = db.prepare(`SELECT * FROM sites WHERE site_key = ? AND actif = 1`).get(k);
  if (!site) return res.status(401).json({ error: 'Clé de liaison invalide' });
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
// Tient compte du verrouillage en cascade : si le propriétaire parent est désactivé,
// la boutique est bloquée même si elle est active individuellement.
export function etatDistributeur(did) {
  if (!did) return { existe: false };
  const d = db.prepare(`SELECT d.id, d.actif, d.gele, d.proprietaire_id,
                               p.actif AS prop_actif
                        FROM distributeurs d
                        LEFT JOIN proprietaires p ON p.id = d.proprietaire_id
                        WHERE d.id = ?`).get(did);
  if (!d) return { existe: false };
  const proprietaireBloque = d.proprietaire_id != null && !d.prop_actif;
  return { existe: true, actif: !!d.actif, gele: !!d.gele, proprietaireBloque,
    bloque: !d.actif || !!d.gele || proprietaireBloque };
}

// État d'un espace propriétaire (désactivé à distance par le super-admin).
export function etatProprietaire(pid) {
  if (!pid) return { existe: false };
  const p = db.prepare(`SELECT id, actif FROM proprietaires WHERE id = ?`).get(pid);
  if (!p) return { existe: false };
  return { existe: true, actif: !!p.actif, bloque: !p.actif };
}

// Boutiques (ids) appartenant à un propriétaire.
export function boutiquesDuProprietaire(pid) {
  if (!pid) return [];
  return db.prepare(`SELECT id FROM distributeurs WHERE proprietaire_id = ?`).all(pid).map(r => r.id);
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
  // Compte propriétaire : son espace est bloqué si désactivé par le super-admin.
  if (req.user.role === 'proprietaire') {
    const ep = etatProprietaire(req.user.pid);
    if (!ep.existe) return res.status(403).json({ error: 'Espace propriétaire introuvable' });
    if (ep.bloque) return res.status(403).json({ error: 'Espace propriétaire désactivé par le super-admin' });
    return next();
  }
  const e = etatDistributeur(req.user.did);
  if (!e.existe) return res.status(403).json({ error: 'Espace distributeur introuvable' });
  if (e.bloque)
    return res.status(403).json({ error: e.gele
      ? 'Espace gelé par le super-admin : accès bloqué'
      : e.proprietaireBloque
        ? 'Espace propriétaire désactivé par le super-admin'
        : 'Espace désactivé par le super-admin' });
  next();
}

export { JWT_SECRET };
