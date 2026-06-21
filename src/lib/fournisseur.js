import db from './db.js';
import { emitToDistributeur } from './realtime.js';

const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const round2 = (v) => Math.round(v * 100) / 100;

// Données du tableau de bord d'un fournisseur (solde, produits, catalogue, historique).
export function dashboardFournisseur(fournisseur) {
  const distributeur = db.prepare(`SELECT nom, devise FROM distributeurs WHERE id = ?`).get(fournisseur.distributeur_id);
  const produits = db.prepare(`SELECT id, nom, unite, stock_actuel, prix_achat
    FROM produits WHERE fournisseur_id = ? ORDER BY nom`).all(fournisseur.id);
  // Catalogue complet du distributeur : le fournisseur peut livrer n'importe quel produit.
  const catalogue = db.prepare(`SELECT id, nom, unite, stock_actuel, prix_achat
    FROM produits WHERE distributeur_id = ? ORDER BY nom`).all(fournisseur.distributeur_id);
  const approvisionnements = db.prepare(`SELECT date, categorie, montant, description
    FROM comptabilite WHERE fournisseur_id = ? ORDER BY date DESC LIMIT 100`).all(fournisseur.id);
  const totalLivre = approvisionnements.reduce((s, a) => s + (a.montant || 0), 0);
  return {
    fournisseur: { nom: fournisseur.nom, code: fournisseur.code, solde_dette: fournisseur.solde_dette },
    distributeur: distributeur ? distributeur.nom : '',
    devise: distributeur?.devise || 'FCFA',
    resume: { nbProduits: produits.length, totalLivre, nbAppros: approvisionnements.length },
    produits, catalogue, approvisionnements
  };
}

// Livraison / vente du fournisseur au distributeur : la marchandise ENTRE dans le
// stock du distributeur (nouvelle entrée de stock), génère une DÉPENSE en
// comptabilité (achat de stock) et augmente le solde dû au fournisseur.
export function livraisonFournisseur(fournisseur, body) {
  const did = fournisseur.distributeur_id;
  const produit = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`)
    .get(num(body?.produit_id), did);
  if (!produit) throw new Error('Produit introuvable chez ce distributeur.');
  const qte = round2(num(body?.quantite));
  if (qte <= 0) throw new Error('Quantité invalide.');
  const pu = round2(num(body?.prix_unitaire) || num(produit.prix_achat));
  if (pu <= 0) throw new Error('Prix unitaire invalide.');
  const montant = round2(qte * pu);
  const note = (body?.note || '').toString();
  const motif = `Livraison fournisseur ${fournisseur.nom} — ${produit.nom}${note ? ' (' + note + ')' : ''}`;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel + ?, prix_achat = ?,
        fournisseur_id = COALESCE(fournisseur_id, ?) WHERE id = ?`).run(qte, pu, fournisseur.id, produit.id);
    db.prepare(`INSERT INTO mouvements_stock
        (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, reference, cree_par)
        VALUES (?,?, 'IN', ?,?,?,?,?,?)`)
      .run(did, produit.id, qte, pu, montant, motif, `FOURN-${fournisseur.id}`, `fournisseur:${fournisseur.code}`);
    db.prepare(`INSERT INTO comptabilite
        (distributeur_id, type, categorie, montant, description, fournisseur_id, cree_par)
        VALUES (?, 'SORTIE', 'ACHAT_STOCK', ?, ?, ?, ?)`)
      .run(did, montant, motif, fournisseur.id, `fournisseur:${fournisseur.code}`);
    db.prepare(`UPDATE fournisseurs SET solde_dette = solde_dette + ? WHERE id = ?`).run(montant, fournisseur.id);
  });
  tx();
  try { emitToDistributeur(did, 'stock:maj', { produitId: produit.id }); } catch {}
  const maj = db.prepare(`SELECT * FROM fournisseurs WHERE id = ?`).get(fournisseur.id);
  return {
    ok: true,
    message: `Livraison enregistrée : +${qte} ${produit.unite || ''} de ${produit.nom} ajoutés au stock du distributeur.`,
    ...dashboardFournisseur(maj)
  };
}
