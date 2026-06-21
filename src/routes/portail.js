import { Router } from 'express';
import db from '../lib/db.js';
import { emitToDistributeur } from '../lib/realtime.js';

// Portails publics (sans compte) : un client ou un fournisseur consulte sa
// situation en saisissant simplement son code unique. Le fournisseur peut en plus
// enregistrer une livraison/vente qui alimente le stock du distributeur.
const r = Router();
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const round2 = (v) => Math.round(v * 100) / 100;

// Données du tableau de bord fournisseur (réutilisé après une livraison).
function fournisseurDashboard(fournisseur) {
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

// ── Espace client : situation financière + factures + enlèvements en cours ──
r.post('/portail-public/connexion', (req, res) => {
  const immatriculation = String(req.body?.immatriculation || '').trim().toUpperCase();
  if (!immatriculation) return res.status(400).json({ error: 'Immatriculation requise' });
  const client = db.prepare(`SELECT * FROM clients WHERE immatriculation = ?`).get(immatriculation);
  if (!client) return res.status(404).json({ error: 'Immatriculation inconnue ou invalide.' });

  const distributeur = db.prepare(`SELECT nom, raison_sociale, adresse, ville, telephone, email, logo
    FROM distributeurs WHERE id = ?`).get(client.distributeur_id);
  const factures = db.prepare(`SELECT id, numero, numero_bon, date, montant_ht, montant_tva,
      montant_total, montant_paye, relicat, statut, echeance
    FROM factures WHERE client_id = ? ORDER BY date DESC`).all(client.id);
  const enlevements = db.prepare(`
    SELECT cg.id, cg.quantite_totale, cg.quantite_restante, cg.prix_unitaire, p.nom, p.unite
    FROM commandes_gros cg LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE cg.entite_type = 'CLIENT' AND cg.entite_id = ?
    ORDER BY cg.created_at DESC`).all(client.id);
  // Historique des pesées/livraisons du client (bons de pesage).
  const pesees = db.prepare(`SELECT numero_ticket, date_sortie, produit, poids_net, montant_total, immatriculation
    FROM sorties WHERE distributeur_id = ? AND (immatriculation = ? OR LOWER(client) = LOWER(?))
    ORDER BY date_sortie DESC LIMIT 50`).all(client.distributeur_id, client.immatriculation, client.nom);

  const totFacture = factures.reduce((s, f) => s + (f.montant_total || 0), 0);
  const totRegle = factures.reduce((s, f) => s + (f.montant_paye || 0), 0);

  res.json({
    client: {
      nom: client.nom, immatriculation: client.immatriculation,
      telephone: client.telephone, adresse: client.adresse,
      solde_dette: client.solde_dette, solde_relicat: client.solde_relicat
    },
    distributeur: distributeur || { nom: '' },
    resume: {
      nbFactures: factures.length, totalFacture: totFacture, totalRegle: totRegle,
      nbPesees: pesees.length,
      tonnageTotal: pesees.reduce((s, p) => s + (p.poids_net || 0), 0)
    },
    factures, enlevements, pesees
  });
});

// ── Espace fournisseur : solde dû + produits + livraisons au distributeur ──
r.post('/portail-fournisseur/connexion', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code fournisseur requis' });
  const fournisseur = db.prepare(`SELECT * FROM fournisseurs WHERE code = ? AND actif = 1`).get(code);
  if (!fournisseur) return res.status(404).json({ error: 'Code fournisseur inconnu ou désactivé.' });
  res.json(fournisseurDashboard(fournisseur));
});

// Livraison / vente du fournisseur au distributeur : la marchandise ENTRE dans le
// stock du distributeur (nouvelle entrée de stock) et génère une DÉPENSE en
// comptabilité (achat de stock) ; le solde dû au fournisseur est augmenté.
r.post('/portail-fournisseur/livraison', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code fournisseur requis' });
  const fournisseur = db.prepare(`SELECT * FROM fournisseurs WHERE code = ? AND actif = 1`).get(code);
  if (!fournisseur) return res.status(404).json({ error: 'Code fournisseur inconnu ou désactivé.' });

  const did = fournisseur.distributeur_id;
  const produit = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`)
    .get(num(req.body?.produit_id), did);
  if (!produit) return res.status(404).json({ error: 'Produit introuvable chez ce distributeur.' });
  const qte = round2(num(req.body?.quantite));
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide.' });
  const pu = round2(num(req.body?.prix_unitaire) || num(produit.prix_achat));
  if (pu <= 0) return res.status(400).json({ error: 'Prix unitaire invalide.' });
  const montant = round2(qte * pu);
  const note = (req.body?.note || '').toString();
  const motif = `Livraison fournisseur ${fournisseur.nom} — ${produit.nom}${note ? ' (' + note + ')' : ''}`;

  try {
    const tx = db.transaction(() => {
      // Entrée de stock chez le distributeur (+ mise à jour du dernier prix d'achat
      // et rattachement du produit au fournisseur s'il ne l'était pas).
      db.prepare(`UPDATE produits SET stock_actuel = stock_actuel + ?, prix_achat = ?,
          fournisseur_id = COALESCE(fournisseur_id, ?) WHERE id = ?`).run(qte, pu, fournisseur.id, produit.id);
      db.prepare(`INSERT INTO mouvements_stock
          (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, reference, cree_par)
          VALUES (?,?, 'IN', ?,?,?,?,?,?)`)
        .run(did, produit.id, qte, pu, montant, motif, `FOURN-${fournisseur.id}`, `fournisseur:${fournisseur.code}`);
      // Dépense en comptabilité (achat de stock).
      db.prepare(`INSERT INTO comptabilite
          (distributeur_id, type, categorie, montant, description, fournisseur_id, cree_par)
          VALUES (?, 'SORTIE', 'ACHAT_STOCK', ?, ?, ?, ?)`)
        .run(did, montant, motif, fournisseur.id, `fournisseur:${fournisseur.code}`);
      // Le distributeur doit désormais ce montant au fournisseur.
      db.prepare(`UPDATE fournisseurs SET solde_dette = solde_dette + ? WHERE id = ?`).run(montant, fournisseur.id);
    });
    tx();
    try { emitToDistributeur(did, 'stock:maj', { produitId: produit.id }); } catch {}
    const maj = db.prepare(`SELECT * FROM fournisseurs WHERE id = ?`).get(fournisseur.id);
    res.json({
      ok: true,
      message: `Livraison enregistrée : +${qte} ${produit.unite || ''} de ${produit.nom} ajoutés au stock du distributeur.`,
      ...fournisseurDashboard(maj)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default r;
