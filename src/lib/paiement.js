// Logique d'abonnement & paiement partagée (Module 2 manuel + Module 8 passerelle).
import { customAlphabet } from 'nanoid';
import db from './db.js';
import { ajouterMois, abonnementResume } from './abonnement.js';

const genToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

export function nouveauToken() { return genToken(); }

// Montant mensuel de référence d'un propriétaire (>= 0).
export function montantMensuel(p) { return Math.max(0, Number(p.abonnement_montant) || 0); }

// Nouvelle échéance après règlement de `nbMois` : repart de l'échéance courante si
// encore valide, sinon d'aujourd'hui (pas de perte ni de cumul indu).
export function nouvelleEcheance(p, nbMois) {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const base = (p.abonnement_echeance && p.abonnement_echeance >= aujourdhui) ? p.abonnement_echeance : aujourdhui;
  return ajouterMois(base, Math.max(1, parseInt(nbMois, 10) || 1));
}

// Crée un paiement automatique « en attente » (avant redirection vers le fournisseur).
// Retourne { id, token, montant, mois, echeancePrevue }.
export function creerPaiementEnAttente({ proprietaireId, montant, methode, mois, provider }) {
  const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(proprietaireId);
  if (!p) throw new Error('Propriétaire introuvable');
  const nbMois = Math.max(1, parseInt(mois, 10) || 1);
  const mt = Number(montant) > 0 ? Number(montant) : montantMensuel(p) * nbMois;
  const token = nouveauToken();
  const echeancePrevue = nouvelleEcheance(p, nbMois);
  const info = db.prepare(`INSERT INTO paiements
      (proprietaire_id, montant, methode, mois, periode_debut, periode_fin, type, statut, provider, token)
      VALUES (?,?,?,?,?,?, 'auto', 'en_attente', ?, ?)`)
    .run(p.id, Math.max(0, mt), methode || provider || 'en ligne', nbMois, p.abonnement_echeance || null, echeancePrevue, provider || null, token);
  return { id: info.lastInsertRowid, token, montant: Math.max(0, mt), mois: nbMois, echeancePrevue };
}

// Valide un paiement (manuel ou auto) : insère/au besoin met à jour la ligne, prolonge
// l'échéance et réactive l'abonnement, en une transaction. Retourne { echeance, proprietaire }.
export function validerPaiement({ proprietaireId, montant, methode, mois, reference, note, valideePar, type, provider, providerRef }) {
  const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(proprietaireId);
  if (!p) throw new Error('Propriétaire introuvable');
  const nbMois = Math.max(1, parseInt(mois, 10) || 1);
  const nouvelle = nouvelleEcheance(p, nbMois);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO paiements
        (proprietaire_id, montant, methode, mois, periode_debut, periode_fin, reference, note, valide_par, type, statut, provider, provider_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'valide', ?, ?)`)
      .run(p.id, Math.max(0, Number(montant) || 0), methode || '', nbMois, p.abonnement_echeance || null, nouvelle,
           reference || '', note || '', valideePar || 'superadmin', type || 'manuel', provider || null, providerRef || null);
    db.prepare(`UPDATE proprietaires SET abonnement_echeance = ?, abonnement_statut = 'actif' WHERE id = ?`).run(nouvelle, p.id);
  });
  tx();
  const maj = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(p.id);
  return { echeance: nouvelle, proprietaire: { ...maj, abonnement: abonnementResume(maj) } };
}

// Confirme un paiement automatique en attente (appelé par le webhook du fournisseur) :
// passe la ligne à 'valide', enregistre la référence et prolonge l'abonnement (idempotent).
export function confirmerPaiementAuto(token, providerRef) {
  const pay = db.prepare(`SELECT * FROM paiements WHERE token = ?`).get(token);
  if (!pay) throw new Error('Paiement introuvable');
  if (pay.statut === 'valide') {
    const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(pay.proprietaire_id);
    return { dejaValide: true, echeance: pay.periode_fin, proprietaire: { ...p, abonnement: abonnementResume(p) } };
  }
  const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(pay.proprietaire_id);
  const nouvelle = nouvelleEcheance(p, pay.mois);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE paiements SET statut = 'valide', provider_ref = ?, periode_fin = ?, valide_par = 'passerelle' WHERE id = ?`)
      .run(providerRef || pay.provider_ref || null, nouvelle, pay.id);
    db.prepare(`UPDATE proprietaires SET abonnement_echeance = ?, abonnement_statut = 'actif' WHERE id = ?`).run(nouvelle, p.id);
  });
  tx();
  const maj = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(p.id);
  return { dejaValide: false, echeance: nouvelle, proprietaire: { ...maj, abonnement: abonnementResume(maj) } };
}

export function marquerEchec(token) {
  db.prepare(`UPDATE paiements SET statut = 'echoue' WHERE token = ? AND statut = 'en_attente'`).run(token);
}
