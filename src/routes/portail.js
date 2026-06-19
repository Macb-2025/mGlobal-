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

  const distributeur = db.prepare(`SELECT nom FROM distributeurs WHERE id = ?`).get(client.distributeur_id);
  const factures = db.prepare(`SELECT id, numero, date, montant_total, montant_paye, relicat
    FROM factures WHERE client_id = ? ORDER BY date DESC`).all(client.id);
  const enlevements = db.prepare(`
    SELECT cg.id, cg.quantite_totale, cg.quantite_restante, p.nom
    FROM commandes_gros cg LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE cg.entite_type = 'CLIENT' AND cg.entite_id = ?
    ORDER BY cg.created_at DESC`).all(client.id);

  res.json({
    client: {
      nom: client.nom, immatriculation: client.immatriculation,
      solde_dette: client.solde_dette, solde_relicat: client.solde_relicat
    },
    distributeur: distributeur ? distributeur.nom : '',
    factures, enlevements
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
