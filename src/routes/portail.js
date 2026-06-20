import { Router } from 'express';
import db from '../lib/db.js';

// Portails publics (sans compte) : un client ou un fournisseur consulte sa
// situation en saisissant simplement son code unique. Lecture seule.
const r = Router();

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

// ── Espace fournisseur : solde dû + produits fournis + approvisionnements ──
r.post('/portail-fournisseur/connexion', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code fournisseur requis' });
  const fournisseur = db.prepare(`SELECT * FROM fournisseurs WHERE code = ? AND actif = 1`).get(code);
  if (!fournisseur) return res.status(404).json({ error: 'Code fournisseur inconnu ou désactivé.' });

  const distributeur = db.prepare(`SELECT nom FROM distributeurs WHERE id = ?`).get(fournisseur.distributeur_id);
  const produits = db.prepare(`SELECT id, nom, unite, stock_actuel, prix_achat
    FROM produits WHERE fournisseur_id = ? ORDER BY nom`).all(fournisseur.id);
  const approvisionnements = db.prepare(`SELECT date, categorie, montant, description
    FROM comptabilite WHERE fournisseur_id = ? ORDER BY date DESC LIMIT 100`).all(fournisseur.id);

  res.json({
    fournisseur: { nom: fournisseur.nom, code: fournisseur.code, solde_dette: fournisseur.solde_dette },
    distributeur: distributeur ? distributeur.nom : '',
    produits, approvisionnements
  });
});

export default r;
