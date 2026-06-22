import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, requireRole, requireEspaceActif, hashPassword, requireAbonnementActif } from '../lib/auth.js';
import { abonnementResume } from '../lib/abonnement.js';

// Espace Central Propriétaire (Hub). Gère SES sous-boutiques et SES collaborateurs.
// Le périmètre est strictement limité au propriétaire connecté (req.user.pid).
const r = Router();
r.use(requireAuth, requireRole('proprietaire'), requireEspaceActif, requireAbonnementActif);

const NATURES = ['habillement', 'epicerie', 'depot', 'autre'];
// Rôles de terrain qu'un propriétaire peut attribuer dans ses boutiques.
const ROLES_BOUTIQUE = ['admin', 'comptable', 'vendeur', 'stockiste', 'assistante', 'superviseur'];
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Vérifie qu'une boutique appartient bien au propriétaire connecté.
function boutiqueDuProprietaire(id, pid) {
  return db.prepare(`SELECT * FROM distributeurs WHERE id = ? AND proprietaire_id = ?`).get(id, pid);
}

// Résumé de l'espace propriétaire (quota, nombre de boutiques, collaborateurs).
r.get('/me', (req, res) => {
  const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(req.user.pid);
  if (!p) return res.status(404).json({ error: 'Propriétaire introuvable' });
  const nbBoutiques = db.prepare(`SELECT COUNT(*) n FROM distributeurs WHERE proprietaire_id = ?`).get(p.id).n;
  const nbCollabs = db.prepare(`SELECT COUNT(*) n FROM users
    WHERE role != 'fournisseur' AND distributeur_id IN (SELECT id FROM distributeurs WHERE proprietaire_id = ?)`).get(p.id).n;
  res.json({
    id: p.id, nom: p.nom, telephone: p.telephone, email: p.email,
    quota_boutiques: p.quota_boutiques, actif: p.actif,
    nbBoutiques, nbCollabs, quotaDisponible: Math.max(0, p.quota_boutiques - nbBoutiques),
    abonnement: abonnementResume(p)
  });
});

// ───────────── Sous-boutiques ─────────────
r.get('/boutiques', (req, res) => {
  const rows = db.prepare(`
    SELECT d.id, d.nom, d.slug, d.nature, d.actif, d.gele, d.created_at,
           (SELECT COUNT(*) FROM users u WHERE u.distributeur_id = d.id AND u.role != 'fournisseur') AS nbUsers
    FROM distributeurs d WHERE d.proprietaire_id = ? ORDER BY d.nom`).all(req.user.pid);
  res.json(rows);
});

r.post('/boutiques', (req, res) => {
  const { nom, slug, nature } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Nom de la boutique requis' });
  const prop = db.prepare(`SELECT quota_boutiques FROM proprietaires WHERE id = ?`).get(req.user.pid);
  const nbActuel = db.prepare(`SELECT COUNT(*) n FROM distributeurs WHERE proprietaire_id = ?`).get(req.user.pid).n;
  if (nbActuel >= prop.quota_boutiques)
    return res.status(403).json({ error: `Quota atteint (${nbActuel}/${prop.quota_boutiques} boutiques). Contactez le super-admin pour l'augmenter.` });
  const nat = NATURES.includes(nature) ? nature : 'autre';
  const s = slugify(slug || nom);
  try {
    const info = db.prepare(`INSERT INTO distributeurs (slug, nom, proprietaire_id, nature) VALUES (?,?,?,?)`)
      .run(s, nom, req.user.pid, nat);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Une boutique avec ce nom/identifiant existe déjà' });
  }
});

r.patch('/boutiques/:id', (req, res) => {
  const d = boutiqueDuProprietaire(req.params.id, req.user.pid);
  if (!d) return res.status(404).json({ error: 'Boutique introuvable' });
  const { nom, nature, gele } = req.body || {};
  if (nom !== undefined && nom) db.prepare(`UPDATE distributeurs SET nom = ? WHERE id = ?`).run(nom, d.id);
  if (nature !== undefined && NATURES.includes(nature)) db.prepare(`UPDATE distributeurs SET nature = ? WHERE id = ?`).run(nature, d.id);
  if (gele !== undefined) db.prepare(`UPDATE distributeurs SET gele = ? WHERE id = ?`).run(gele ? 1 : 0, d.id);
  res.json({ ok: true, boutique: db.prepare(`SELECT id, nom, nature, actif, gele FROM distributeurs WHERE id = ?`).get(d.id) });
});

// ───────────── Tableau de bord consolidé (multi-boutiques) ─────────────
r.get('/dashboard', (req, res) => {
  const mois = new Date().toISOString().slice(0, 7);
  const boutiques = db.prepare(`SELECT id, nom, nature, actif, gele FROM distributeurs WHERE proprietaire_id = ? ORDER BY nom`).all(req.user.pid);
  const parBoutique = boutiques.map(b => {
    const fact = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(montant_total),0) ca,
        COALESCE(SUM(montant_paye),0) encaisse
      FROM factures WHERE distributeur_id = ?`).get(b.id);
    const caMois = db.prepare(`SELECT COALESCE(SUM(montant_total),0) ca
      FROM factures WHERE distributeur_id = ? AND substr(date,1,7) = ?`).get(b.id, mois).ca;
    const creances = db.prepare(`SELECT COALESCE(SUM(solde_dette),0) d FROM clients WHERE distributeur_id = ?`).get(b.id).d;
    const stock = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(stock_actuel * prix_vente_gros),0) valeur,
        COALESCE(SUM(CASE WHEN stock_actuel <= stock_alerte THEN 1 ELSE 0 END),0) alertes
      FROM produits WHERE distributeur_id = ?`).get(b.id);
    return { id: b.id, nom: b.nom, nature: b.nature, actif: b.actif, gele: b.gele,
      nbFactures: fact.nb, ca: fact.ca, caMois, encaisse: fact.encaisse,
      creances, nbProduits: stock.nb, valeurStock: stock.valeur, alertesStock: stock.alertes };
  });
  const sum = (k) => parBoutique.reduce((t, b) => t + (b[k] || 0), 0);
  res.json({
    totaux: {
      nbBoutiques: boutiques.length,
      ca: sum('ca'), caMois: sum('caMois'), encaisse: sum('encaisse'),
      creances: sum('creances'), valeurStock: sum('valeurStock'), alertesStock: sum('alertesStock')
    },
    parBoutique
  });
});

// ───────────── Transferts de stock entre boutiques ─────────────
// Produits d'une de SES boutiques (pour choisir l'article à transférer).
r.get('/produits', (req, res) => {
  const did = Number(req.query.distributeurId);
  if (!boutiqueDuProprietaire(did, req.user.pid)) return res.status(403).json({ error: 'Boutique hors de votre réseau' });
  res.json(db.prepare(`SELECT id, nom, unite, stock_actuel, prix_achat, prix_vente_gros
    FROM produits WHERE distributeur_id = ? ORDER BY nom`).all(did));
});

r.post('/transferts', (req, res) => {
  const { sourceId, destId, produitId, quantite, note } = req.body || {};
  const qte = Number(quantite) || 0;
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  if (Number(sourceId) === Number(destId)) return res.status(400).json({ error: 'Source et destination identiques' });
  const src = boutiqueDuProprietaire(sourceId, req.user.pid);
  const dst = boutiqueDuProprietaire(destId, req.user.pid);
  if (!src || !dst) return res.status(403).json({ error: 'Boutique(s) hors de votre réseau' });
  const prod = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(produitId, src.id);
  if (!prod) return res.status(404).json({ error: 'Produit introuvable dans la boutique source' });
  if (prod.stock_actuel < qte) return res.status(400).json({ error: `Stock insuffisant (${prod.stock_actuel} ${prod.unite || ''})` });

  const tx = db.transaction(() => {
    // Décrément source + mouvement OUT.
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel - ? WHERE id = ?`).run(qte, prod.id);
    db.prepare(`INSERT INTO mouvements_stock (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, reference, cree_par)
      VALUES (?,?, 'OUT', ?,?,?, 'TRANSFERT', ?, ?)`)
      .run(src.id, prod.id, qte, prod.prix_achat, qte * prod.prix_achat, `Vers ${dst.nom}`, req.user.username || 'proprietaire');
    // Produit destination : même nom, créé si absent (hérite des prix/unité).
    let dprod = db.prepare(`SELECT * FROM produits WHERE distributeur_id = ? AND nom = ?`).get(dst.id, prod.nom);
    if (!dprod) {
      const info = db.prepare(`INSERT INTO produits (distributeur_id, nom, unite, stock_actuel, prix_achat, prix_vente_gros)
        VALUES (?,?,?,?,?,?)`).run(dst.id, prod.nom, prod.unite, 0, prod.prix_achat, prod.prix_vente_gros);
      dprod = { id: info.lastInsertRowid };
    }
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel + ? WHERE id = ?`).run(qte, dprod.id);
    db.prepare(`INSERT INTO mouvements_stock (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, reference, cree_par)
      VALUES (?,?, 'IN', ?,?,?, 'TRANSFERT', ?, ?)`)
      .run(dst.id, dprod.id, qte, prod.prix_achat, qte * prod.prix_achat, `Depuis ${src.nom}`, req.user.username || 'proprietaire');
    db.prepare(`INSERT INTO transferts_stock (proprietaire_id, source_id, dest_id, produit_nom, quantite, unite, note, par)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.user.pid, src.id, dst.id, prod.nom, qte, prod.unite || '', note || '', req.user.username || 'proprietaire');
  });
  tx();
  res.json({ ok: true });
});

r.get('/transferts', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, s.nom AS source_nom, d.nom AS dest_nom
    FROM transferts_stock t
    JOIN distributeurs s ON s.id = t.source_id
    JOIN distributeurs d ON d.id = t.dest_id
    WHERE t.proprietaire_id = ? ORDER BY t.created_at DESC LIMIT 200`).all(req.user.pid);
  res.json(rows);
});

// ───────────── RH centralisée (collaborateurs de toutes les boutiques) ─────────────
r.get('/collaborateurs', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, u.actif, u.distributeur_id, d.nom AS boutique_nom
    FROM users u JOIN distributeurs d ON d.id = u.distributeur_id
    WHERE d.proprietaire_id = ? AND u.role != 'fournisseur'
    ORDER BY d.nom, u.username`).all(req.user.pid);
  res.json(rows);
});

r.post('/collaborateurs', (req, res) => {
  const { distributeurId, username, password, fullName, role } = req.body || {};
  if (!distributeurId) return res.status(400).json({ error: 'Boutique cible requise' });
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
  if (!ROLES_BOUTIQUE.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  if (!boutiqueDuProprietaire(distributeurId, req.user.pid))
    return res.status(403).json({ error: 'Cette boutique ne fait pas partie de votre réseau' });
  if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(String(username).trim()))
    return res.status(409).json({ error: 'Cet identifiant existe déjà' });
  const info = db.prepare(`INSERT INTO users (distributeur_id, username, password_hash, full_name, role)
    VALUES (?,?,?,?,?)`).run(distributeurId, String(username).trim(), hashPassword(password), fullName || '', role);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// Mutation incluse : changer la boutique d'affectation d'un collaborateur.
r.patch('/collaborateurs/:id', (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!u || u.role === 'fournisseur' || !u.distributeur_id) return res.status(404).json({ error: 'Collaborateur introuvable' });
  if (!boutiqueDuProprietaire(u.distributeur_id, req.user.pid))
    return res.status(403).json({ error: 'Hors de votre réseau' });
  const { role, actif, password, fullName, distributeurId } = req.body || {};
  if (role && ROLES_BOUTIQUE.includes(role)) db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, u.id);
  if (actif !== undefined) db.prepare(`UPDATE users SET actif = ? WHERE id = ?`).run(actif ? 1 : 0, u.id);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), u.id);
  }
  if (fullName !== undefined) db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(fullName, u.id);
  if (distributeurId !== undefined) {
    if (!boutiqueDuProprietaire(distributeurId, req.user.pid))
      return res.status(403).json({ error: 'Boutique de mutation hors de votre réseau' });
    db.prepare(`UPDATE users SET distributeur_id = ? WHERE id = ?`).run(distributeurId, u.id);
  }
  res.json({ ok: true });
});

r.delete('/collaborateurs/:id', (req, res) => {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
  if (!u || u.role === 'fournisseur' || !u.distributeur_id) return res.status(404).json({ error: 'Collaborateur introuvable' });
  if (!boutiqueDuProprietaire(u.distributeur_id, req.user.pid))
    return res.status(403).json({ error: 'Hors de votre réseau' });
  db.prepare(`DELETE FROM users WHERE id = ?`).run(u.id);
  res.json({ ok: true });
});

export default r;
