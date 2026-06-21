import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../lib/db.js';
import { customAlphabet } from 'nanoid';
import { requireAuth, denySuperadmin, denyFournisseur, requireEspaceActif, requireRole } from '../lib/auth.js';
import { factureHtml } from '../lib/facture.js';
import { signerBon } from '../lib/signature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');

const r = Router();
// Tous les modules métier appartiennent à un distributeur : authentification
// obligatoire, aucun accès super-admin, et blocage si l'espace est gelé/désactivé.
r.use(requireAuth, denySuperadmin, denyFournisseur, requireEspaceActif);

const codeImmat = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const round2 = (v) => Math.round(v * 100) / 100;

// Distributeur courant (jamais null ici : le super-admin est bloqué en amont).
const did = (req) => req.user.did;

// Identité / paramètres de facturation du distributeur courant.
const profilDistributeur = (id) => db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(id);

// Écriture comptable interne (caisse). Centralise le journal des mouvements.
function ecritureCompta(distributeurId, { type, categorie, montant, description, clientId, fournisseurId, factureId, par }) {
  return db.prepare(`INSERT INTO comptabilite
    (distributeur_id, type, categorie, montant, description, client_id, fournisseur_id, facture_id, cree_par)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(distributeurId, type, categorie || null, round2(num(montant)), description || null,
         clientId || null, fournisseurId || null, factureId || null, par || null);
}

// ══════════════════════════════════════════
// 1. CLIENTS (carnet d'adresses du distributeur)
// ══════════════════════════════════════════
r.get('/clients', (req, res) => {
  res.json(db.prepare(`SELECT * FROM clients WHERE distributeur_id = ? ORDER BY nom`).all(did(req)));
});

r.post('/clients', (req, res) => {
  const { nom, telephone, adresse } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Le nom du client est requis' });
  let immatriculation;
  // Génère un code d'accès portail unique.
  for (let i = 0; i < 5; i++) {
    immatriculation = 'MGL-' + codeImmat();
    if (!db.prepare(`SELECT 1 FROM clients WHERE immatriculation = ?`).get(immatriculation)) break;
  }
  const info = db.prepare(`INSERT INTO clients (distributeur_id, immatriculation, nom, telephone, adresse)
    VALUES (?,?,?,?,?)`).run(did(req), immatriculation, nom, telephone || '', adresse || '');
  res.json(db.prepare(`SELECT * FROM clients WHERE id = ?`).get(info.lastInsertRowid));
});

r.put('/clients/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!c) return res.status(404).json({ error: 'Client introuvable' });
  const { nom, telephone, adresse } = req.body || {};
  db.prepare(`UPDATE clients SET nom = ?, telephone = ?, adresse = ? WHERE id = ?`)
    .run(nom ?? c.nom, telephone ?? c.telephone, adresse ?? c.adresse, c.id);
  res.json({ ok: true });
});

r.delete('/clients/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM clients WHERE id = ? AND distributeur_id = ?`).run(req.params.id, did(req));
  if (!info.changes) return res.status(404).json({ error: 'Client introuvable' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 2. FOURNISSEURS (chacun avec son code d'espace privé)
// ══════════════════════════════════════════
r.get('/fournisseurs', (req, res) => {
  res.json(db.prepare(`SELECT * FROM fournisseurs WHERE distributeur_id = ? ORDER BY nom`).all(did(req)));
});

r.post('/fournisseurs', (req, res) => {
  const { nom, telephone, adresse } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Le nom du fournisseur est requis' });
  let code;
  for (let i = 0; i < 5; i++) {
    code = 'FRN-' + codeImmat();
    if (!db.prepare(`SELECT 1 FROM fournisseurs WHERE code = ?`).get(code)) break;
  }
  const info = db.prepare(`INSERT INTO fournisseurs (distributeur_id, code, nom, telephone, adresse)
    VALUES (?,?,?,?,?)`).run(did(req), code, nom, telephone || '', adresse || '');
  res.json(db.prepare(`SELECT * FROM fournisseurs WHERE id = ?`).get(info.lastInsertRowid));
});

r.put('/fournisseurs/:id', (req, res) => {
  const f = db.prepare(`SELECT * FROM fournisseurs WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!f) return res.status(404).json({ error: 'Fournisseur introuvable' });
  const { nom, telephone, adresse, actif } = req.body || {};
  db.prepare(`UPDATE fournisseurs SET nom = ?, telephone = ?, adresse = ?, actif = ? WHERE id = ?`)
    .run(nom ?? f.nom, telephone ?? f.telephone, adresse ?? f.adresse,
         actif === undefined ? f.actif : (actif ? 1 : 0), f.id);
  res.json({ ok: true });
});

r.delete('/fournisseurs/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM fournisseurs WHERE id = ? AND distributeur_id = ?`).run(req.params.id, did(req));
  if (!info.changes) return res.status(404).json({ error: 'Fournisseur introuvable' });
  res.json({ ok: true });
});

// Règlement d'une dette envers un fournisseur (sortie de caisse).
r.post('/fournisseurs/:id/reglement', (req, res) => {
  const f = db.prepare(`SELECT * FROM fournisseurs WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!f) return res.status(404).json({ error: 'Fournisseur introuvable' });
  const montant = round2(num(req.body?.montant));
  if (montant <= 0) return res.status(400).json({ error: 'Montant invalide' });
  db.prepare(`UPDATE fournisseurs SET solde_dette = MAX(0, solde_dette - ?) WHERE id = ?`).run(montant, f.id);
  ecritureCompta(did(req), { type: 'SORTIE', categorie: 'REGLEMENT_FOURNISSEUR', montant,
    description: `Règlement fournisseur ${f.nom}`, fournisseurId: f.id, par: req.user.username });
  res.json({ ok: true, fournisseur: db.prepare(`SELECT * FROM fournisseurs WHERE id = ?`).get(f.id) });
});

// ══════════════════════════════════════════
// 3. PRODUITS & GESTION DU STOCK
// ══════════════════════════════════════════
r.get('/produits', (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, f.nom AS fournisseur_nom FROM produits p
    LEFT JOIN fournisseurs f ON f.id = p.fournisseur_id
    WHERE p.distributeur_id = ? ORDER BY p.nom`).all(did(req)));
});

r.post('/produits', (req, res) => {
  const { nom, reference, description, unite, stock_actuel, stock_alerte,
    prix_achat, prix_vente, prix_vente_gros, tva, fournisseur_id } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Le nom du produit est requis' });
  const tvaDef = profilDistributeur(did(req))?.tva_defaut ?? 18;
  const info = db.prepare(`INSERT INTO produits
    (distributeur_id, nom, reference, description, unite, stock_actuel, stock_alerte,
     prix_achat, prix_vente, prix_vente_gros, tva, fournisseur_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(did(req), nom, reference || '', description || '', unite || 't',
      num(stock_actuel), num(stock_alerte, 10), num(prix_achat), num(prix_vente),
      num(prix_vente_gros), tva != null ? num(tva, tvaDef) : tvaDef, fournisseur_id || null);
  res.json(db.prepare(`SELECT * FROM produits WHERE id = ?`).get(info.lastInsertRowid));
});

r.put('/produits/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const b = req.body || {};
  db.prepare(`UPDATE produits SET nom=?, reference=?, description=?, unite=?, stock_alerte=?,
      prix_achat=?, prix_vente=?, prix_vente_gros=?, tva=?, fournisseur_id=? WHERE id=?`)
    .run(b.nom ?? p.nom, b.reference ?? p.reference, b.description ?? p.description, b.unite ?? p.unite,
      b.stock_alerte != null ? num(b.stock_alerte) : p.stock_alerte,
      b.prix_achat != null ? num(b.prix_achat) : p.prix_achat,
      b.prix_vente != null ? num(b.prix_vente) : p.prix_vente,
      b.prix_vente_gros != null ? num(b.prix_vente_gros) : p.prix_vente_gros,
      b.tva != null ? num(b.tva) : p.tva,
      b.fournisseur_id !== undefined ? (b.fournisseur_id || null) : p.fournisseur_id, p.id);
  res.json({ ok: true });
});

r.delete('/produits/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM produits WHERE id = ? AND distributeur_id = ?`).run(req.params.id, did(req));
  if (!info.changes) return res.status(404).json({ error: 'Produit introuvable' });
  res.json({ ok: true });
});

// Approvisionnement : entrée de stock + dette fournisseur + écriture comptable (achat).
r.post('/produits/:id/approvisionner', (req, res) => {
  const p = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const quantite = num(req.body?.quantite);
  const prix_achat = num(req.body?.prix_achat, p.prix_achat);
  const fournisseur_id = req.body?.fournisseur_id || p.fournisseur_id || null;
  if (quantite <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  const montant = round2(quantite * prix_achat);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel + ?, prix_achat = ?, fournisseur_id = COALESCE(?, fournisseur_id) WHERE id = ?`)
      .run(quantite, prix_achat, fournisseur_id, p.id);
    if (fournisseur_id)
      db.prepare(`UPDATE fournisseurs SET solde_dette = solde_dette + ? WHERE id = ? AND distributeur_id = ?`)
        .run(montant, fournisseur_id, did(req));
    ecritureCompta(did(req), { type: 'SORTIE', categorie: 'ACHAT_STOCK', montant,
      description: `Approvisionnement ${p.nom} (${quantite} ${p.unite})`,
      fournisseurId: fournisseur_id, par: req.user.username });
    db.prepare(`INSERT INTO mouvements_stock
      (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, cree_par)
      VALUES (?,?,?,?,?,?,?,?)`).run(did(req), p.id, 'IN', quantite, prix_achat, montant,
        `Approvisionnement ${p.nom}`, req.user.username);
  });
  tx();
  res.json({ ok: true, produit: db.prepare(`SELECT * FROM produits WHERE id = ?`).get(p.id) });
});

// Mouvement de stock manuel : entrée (dépense) ou sortie (revenu) hors document.
r.post('/produits/:id/mouvement', (req, res) => {
  const p = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const sens = req.body?.sens === 'IN' ? 'IN' : (req.body?.sens === 'OUT' ? 'OUT' : null);
  if (!sens) return res.status(400).json({ error: 'Sens invalide (IN = entrée, OUT = sortie)' });
  const quantite = num(req.body?.quantite);
  if (quantite <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  // Prix par défaut : achat pour une entrée, vente pour une sortie.
  const prix = req.body?.prix_unitaire != null ? num(req.body.prix_unitaire)
    : (sens === 'IN' ? p.prix_achat : (p.prix_vente || p.prix_vente_gros));
  const motif = (req.body?.motif || '').toString()
    || (sens === 'IN' ? `Entrée de stock ${p.nom}` : `Sortie de stock ${p.nom}`);
  const tx = db.transaction(() =>
    mouvementStock(did(req), p, sens, quantite, prix, { motif, compta: true, username: req.user.username }));
  const montant = tx();
  res.json({ ok: true, montant, produit: db.prepare(`SELECT * FROM produits WHERE id = ?`).get(p.id) });
});

// Historique des mouvements de stock (tous produits ou un produit donné).
r.get('/mouvements-stock', (req, res) => {
  const pid = req.query.produit_id ? Number(req.query.produit_id) : null;
  const params = pid ? { did: did(req), pid } : { did: did(req) };
  const rows = db.prepare(`SELECT m.*, p.nom AS produit_nom, p.unite FROM mouvements_stock m
    LEFT JOIN produits p ON p.id = m.produit_id
    WHERE m.distributeur_id = @did ${pid ? 'AND m.produit_id = @pid' : ''}
    ORDER BY m.date DESC, m.id DESC LIMIT 500`).all(params);
  res.json(rows);
});

r.get('/stocks/alertes', (req, res) => {
  res.json(db.prepare(`SELECT id, nom, unite, stock_actuel, stock_alerte FROM produits
    WHERE distributeur_id = ? AND stock_actuel <= stock_alerte ORDER BY stock_actuel`).all(did(req)));
});

// ══════════════════════════════════════════
// 4. FACTURATION & RELICAT
// ══════════════════════════════════════════
r.get('/factures', (req, res) => {
  res.json(db.prepare(`
    SELECT fa.*, c.nom AS client_nom_ref, c.immatriculation FROM factures fa
    LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.distributeur_id = ? ORDER BY fa.date DESC, fa.id DESC LIMIT 500`).all(did(req)));
});

// Pré-remplissage d'une facture à partir du NUMÉRO DE BON (clé maîtresse).
// On charge automatiquement client, produit, quantité (poids pesé), prix unitaire
// et TVA dans des lignes prêtes à facturer.
r.get('/factures/depuis-bon/:numero', (req, res) => {
  const numero = String(req.params.numero || '').trim().replace(/^#/, '');
  if (!numero) return res.status(400).json({ error: 'Numéro de bon requis' });
  // Recherche par numéro séquentiel OU par référence (BC-...).
  const bon = db.prepare(`SELECT * FROM bons_commande
    WHERE distributeur_id = ? AND (CAST(numero AS TEXT) = ? OR reference = ?)
    ORDER BY id DESC LIMIT 1`).get(did(req), numero, numero);
  if (!bon) return res.status(404).json({ error: 'Bon introuvable dans votre espace' });

  // Déjà facturé ? On le signale (sans bloquer la consultation).
  const dejaFacture = db.prepare(`SELECT numero FROM factures WHERE distributeur_id = ? AND numero_bon = ?`)
    .get(did(req), bon.reference || String(bon.numero));

  // Quantité : poids net pesé si disponible, sinon quantité prévue.
  const quantite = round2(num(bon.poids_net) || num(bon.quantite_prevue));
  // Produit du catalogue (correspondance par nom) pour récupérer prix de vente + TVA.
  const prod = bon.produit
    ? db.prepare(`SELECT * FROM produits WHERE distributeur_id = ? AND LOWER(nom) = LOWER(?) LIMIT 1`).get(did(req), bon.produit)
    : null;
  // Si le bon a été pesé, on récupère le prix unitaire réel depuis la sortie associée.
  const sortie = bon.source_sortie_id
    ? db.prepare(`SELECT prix_unitaire, montant_total FROM sorties WHERE id = ? AND distributeur_id = ?`)
        .get(bon.source_sortie_id, did(req))
    : null;
  const tvaDef = profilDistributeur(did(req))?.tva_defaut ?? 18;
  const prixUnitaire = round2(num(sortie?.prix_unitaire) || num(prod?.prix_vente) || num(prod?.prix_vente_gros));
  const tva = prod ? num(prod.tva, tvaDef) : tvaDef;
  // Rapprochement client (par immatriculation puis par nom).
  let client = null;
  if (bon.immatriculation)
    client = db.prepare(`SELECT id, nom, immatriculation FROM clients WHERE distributeur_id = ? AND immatriculation = ?`).get(did(req), bon.immatriculation);
  if (!client && bon.client)
    client = db.prepare(`SELECT id, nom, immatriculation FROM clients WHERE distributeur_id = ? AND LOWER(nom) = LOWER(?) LIMIT 1`).get(did(req), bon.client);

  res.json({
    bon: {
      id: bon.id, numero: bon.numero, reference: bon.reference, statut: bon.statut,
      client: bon.client, immatriculation: bon.immatriculation, produit: bon.produit,
      chauffeur: bon.chauffeur, destination: bon.destination,
      quantite, unite: prod?.unite || 't', poidsNet: bon.poids_net, numeroTicket: bon.numero_ticket
    },
    client,
    dejaFacture: dejaFacture ? dejaFacture.numero : null,
    lignes: [{
      produit_id: prod?.id || null,
      designation: bon.produit || 'Marchandise',
      quantite,
      unite: prod?.unite || 't',
      prix_unitaire: prixUnitaire,
      remise: 0,
      tva
    }]
  });
});

// Calcule les totaux HT/TVA/TTC d'un ensemble de lignes.
function calculerLignes(lignesBrutes, remiseGlobale = 0) {
  const lignes = [];
  let ht = 0, tvaTot = 0;
  for (const l of (lignesBrutes || [])) {
    const q = num(l.quantite), pu = num(l.prix_unitaire), remise = num(l.remise), taux = num(l.tva);
    if (q <= 0 || !l.designation) continue;
    const brut = q * pu;
    const mHT = round2(brut * (1 - remise / 100));
    const mTVA = round2(mHT * taux / 100);
    ht += mHT; tvaTot += mTVA;
    lignes.push({ produit_id: l.produit_id || null, designation: String(l.designation),
      quantite: q, unite: l.unite || '', prix_unitaire: pu, remise, tva: taux,
      montant_ht: mHT, montant_tva: mTVA, montant_ttc: round2(mHT + mTVA) });
  }
  const htRemise = round2(ht * (1 - num(remiseGlobale) / 100));
  // La remise globale s'applique au HT ; la TVA est recalculée au prorata.
  const ratio = ht > 0 ? htRemise / ht : 1;
  const tvaFinal = round2(tvaTot * ratio);
  return { lignes, montant_ht: htRemise, montant_tva: tvaFinal, montant_ttc: round2(htRemise + tvaFinal) };
}

// Mouvement de stock + écriture comptable optionnelle. À appeler DANS une transaction.
// IN (entrée/achat) → dépense ; OUT (sortie/vente) → revenu.
function mouvementStock(distId, prod, sens, quantite, prixUnitaire, { motif, reference, compta = true, username } = {}) {
  const q = round2(num(quantite));
  if (q <= 0 || !prod) return 0;
  const pu = round2(num(prixUnitaire));
  const montant = round2(q * pu);
  if (sens === 'IN') {
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel + ? WHERE id = ? AND distributeur_id = ?`).run(q, prod.id, distId);
    if (compta) ecritureCompta(distId, { type: 'SORTIE', categorie: 'ACHAT_STOCK', montant,
      description: motif || `Entrée de stock ${prod.nom}`, par: username });
  } else {
    db.prepare(`UPDATE produits SET stock_actuel = stock_actuel - ? WHERE id = ? AND distributeur_id = ?`).run(q, prod.id, distId);
    if (compta) ecritureCompta(distId, { type: 'ENTREE', categorie: 'VENTE_STOCK', montant,
      description: motif || `Sortie de stock ${prod.nom}`, par: username });
  }
  db.prepare(`INSERT INTO mouvements_stock
    (distributeur_id, produit_id, sens, quantite, prix_unitaire, montant, motif, reference, cree_par)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(distId, prod.id, sens, q, pu, montant, motif || null, reference || null, username || null);
  return montant;
}

// Création d'une facture (réutilisée par la facturation manuelle ET la vente en gros).
// Doit être exécutée DANS une transaction. Lève une erreur en cas d'entrée invalide.
function creerFacture(distId, b, username, { deduireStock = false } = {}) {
  const lignesBrutes = Array.isArray(b.lignes) ? b.lignes : [];
  const remiseGlobale = num(b.remise_globale);
  let calc;
  if (lignesBrutes.length) {
    calc = calculerLignes(lignesBrutes, remiseGlobale);
    if (!calc.lignes.length) throw new Error('Aucune ligne valide');
  } else {
    const total = round2(num(b.montant_total));
    if (total <= 0) throw new Error('Renseignez au moins une ligne ou un montant total');
    calc = { lignes: [], montant_ht: total, montant_tva: 0, montant_ttc: total };
  }
  const total = calc.montant_ttc;
  const paye = round2(num(b.montant_paye));

  let client = null;
  if (b.client_id) {
    client = db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(b.client_id, distId);
    if (!client) throw new Error('Client introuvable dans votre espace');
  }
  const relicat = round2(total - paye); // >0 : dette ; <0 : trop-perçu
  const annee = new Date().getFullYear();
  const seq = db.prepare(`SELECT COUNT(*) n FROM factures WHERE distributeur_id = ? AND substr(date,1,4) = ?`)
    .get(distId, String(annee)).n + 1;
  const numero = `FAC-${annee}-${String(seq).padStart(4, '0')}`;
  const statut = relicat <= 0 ? 'payee' : (paye > 0 ? 'partielle' : 'emise');

  const info = db.prepare(`INSERT INTO factures
    (distributeur_id, numero, numero_bon, client_id, client_nom, montant_ht, montant_tva,
     montant_total, montant_paye, relicat, remise_globale, echeance, statut, mode_paiement, note, cree_par)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      distId, numero, b.numero_bon || null, b.client_id || null,
      client ? client.nom : (b.client_nom || null),
      calc.montant_ht, calc.montant_tva, total, paye, relicat, remiseGlobale,
      b.echeance || null, statut, b.mode_paiement || null, b.note || '', username);
  const fid = info.lastInsertRowid;
  const insL = db.prepare(`INSERT INTO facture_lignes
    (facture_id, produit_id, designation, quantite, unite, prix_unitaire, remise, tva, montant_ht, montant_tva, montant_ttc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of calc.lignes) {
    insL.run(fid, l.produit_id, l.designation, l.quantite, l.unite, l.prix_unitaire, l.remise, l.tva,
      l.montant_ht, l.montant_tva, l.montant_ttc);
    // Suivi stock : la vente fait sortir la marchandise du stock (revenu = encaissement facture).
    if (deduireStock && l.produit_id) {
      const prod = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(l.produit_id, distId);
      if (prod) mouvementStock(distId, prod, 'OUT', l.quantite, l.prix_unitaire,
        { motif: `Vente facture ${numero}`, reference: numero, compta: false, username });
    }
  }
  if (client) {
    if (relicat > 0) db.prepare(`UPDATE clients SET solde_dette = solde_dette + ? WHERE id = ?`).run(relicat, client.id);
    else if (relicat < 0) db.prepare(`UPDATE clients SET solde_relicat = solde_relicat + ? WHERE id = ?`).run(Math.abs(relicat), client.id);
  }
  if (paye > 0)
    ecritureCompta(distId, { type: 'ENTREE', categorie: 'VENTE', montant: paye,
      description: `Encaissement facture ${numero}`, clientId: b.client_id || null,
      factureId: fid, par: username });
  return { id: fid, numero, relicat, montant_ht: calc.montant_ht, montant_tva: calc.montant_tva, montant_ttc: total };
}

r.post('/factures', (req, res) => {
  try {
    const tx = db.transaction(() => creerFacture(did(req), req.body || {}, req.user.username, { deduireStock: true }));
    const r2 = tx();
    res.json({ ok: true, ...r2 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Détail d'une facture (avec ses lignes) au format JSON.
r.get('/factures/:id', (req, res) => {
  const fa = db.prepare(`SELECT fa.*, c.nom AS client_nom_ref, c.immatriculation, c.telephone, c.adresse
    FROM factures fa LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.id = ? AND fa.distributeur_id = ?`).get(req.params.id, did(req));
  if (!fa) return res.status(404).json({ error: 'Facture introuvable' });
  const lignes = db.prepare(`SELECT * FROM facture_lignes WHERE facture_id = ? ORDER BY id`).all(fa.id);
  res.json({ ...fa, lignes });
});

// Facture imprimable (HTML) — modèle professionnel.
r.get('/factures/:id/imprimer', (req, res) => {
  const fa = db.prepare(`SELECT fa.*, c.nom AS client_nom_ref, c.immatriculation, c.telephone, c.adresse
    FROM factures fa LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.id = ? AND fa.distributeur_id = ?`).get(req.params.id, did(req));
  if (!fa) return res.status(404).send('Facture introuvable');
  const lignes = db.prepare(`SELECT * FROM facture_lignes WHERE facture_id = ? ORDER BY id`).all(fa.id);
  const vendeur = profilDistributeur(did(req));
  res.set('Content-Type', 'text/html; charset=utf-8').send(factureHtml({ ...fa, lignes }, vendeur));
});

// Liste des clients ayant une dette ou un relicat (module gestion du relicat).
r.get('/relicat', (req, res) => {
  res.json(db.prepare(`SELECT id, immatriculation, nom, telephone, solde_dette, solde_relicat
    FROM clients WHERE distributeur_id = ? AND (solde_dette > 0 OR solde_relicat > 0)
    ORDER BY solde_dette DESC`).all(did(req)));
});

// Règlement d'une dette client : encaisse un montant, solde la dette, et verse
// l'éventuel excédent dans le relicat (acompte disponible) du client.
r.post('/relicat/reglement', (req, res) => {
  const client = db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(req.body?.client_id, did(req));
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const montant = round2(num(req.body?.montant));
  if (montant <= 0) return res.status(400).json({ error: 'Montant invalide' });

  const tx = db.transaction(() => {
    const surDette = Math.min(montant, client.solde_dette);
    const surplus = round2(montant - surDette);
    db.prepare(`UPDATE clients SET solde_dette = solde_dette - ?, solde_relicat = solde_relicat + ? WHERE id = ?`)
      .run(surDette, surplus, client.id);
    ecritureCompta(did(req), { type: 'ENTREE', categorie: 'REGLEMENT_CLIENT', montant,
      description: `Règlement client ${client.nom}`, clientId: client.id, par: req.user.username });
  });
  tx();
  res.json({ ok: true, client: db.prepare(`SELECT * FROM clients WHERE id = ?`).get(client.id) });
});

// Situation détaillée d'un client : solde harmonisé (dette − relicat) + détail des
// factures (reste à payer) et historique des règlements encaissés.
r.get('/relicat/:id/detail', (req, res) => {
  const client = db.prepare(`SELECT id, nom, immatriculation, telephone, adresse, solde_dette, solde_relicat
    FROM clients WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  const factures = db.prepare(`SELECT id, numero, numero_bon, date, montant_total, montant_paye, relicat, statut
    FROM factures WHERE distributeur_id = ? AND client_id = ? ORDER BY date DESC, id DESC`).all(did(req), client.id);
  const reglements = db.prepare(`SELECT date, montant, description FROM comptabilite
    WHERE distributeur_id = ? AND client_id = ? AND categorie = 'REGLEMENT_CLIENT'
    ORDER BY date DESC, id DESC`).all(did(req), client.id);
  const totalFacture = round2(factures.reduce((s, f) => s + num(f.montant_total), 0));
  const totalRegle = round2(factures.reduce((s, f) => s + num(f.montant_paye), 0));
  res.json({
    client,
    solde_net: round2(num(client.solde_dette) - num(client.solde_relicat)),
    totalFacture, totalRegle,
    factures, reglements
  });
});

// ══════════════════════════════════════════
// 5. COMPTABILITÉ (journal de caisse)
// ══════════════════════════════════════════
r.get('/comptabilite', (req, res) => {
  const from = (req.query.from || '1970-01-01') + ' 00:00:00';
  const to = (req.query.to || '2999-12-31') + ' 23:59:59';
  const rows = db.prepare(`
    SELECT co.*, c.nom AS client_nom, f.nom AS fournisseur_nom FROM comptabilite co
    LEFT JOIN clients c ON c.id = co.client_id
    LEFT JOIN fournisseurs f ON f.id = co.fournisseur_id
    WHERE co.distributeur_id = ? AND co.date BETWEEN ? AND ?
    ORDER BY co.date DESC, co.id DESC LIMIT 1000`).all(did(req), from, to);
  res.json(rows);
});

r.get('/comptabilite/resume', (req, res) => {
  const from = (req.query.from || '1970-01-01') + ' 00:00:00';
  const to = (req.query.to || '2999-12-31') + ' 23:59:59';
  const agg = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='ENTREE' THEN montant END),0) AS totalEntrees,
      COALESCE(SUM(CASE WHEN type='SORTIE' THEN montant END),0) AS totalSorties
    FROM comptabilite WHERE distributeur_id = ? AND date BETWEEN ? AND ?`).get(did(req), from, to);
  const parCategorie = db.prepare(`
    SELECT type, categorie, ROUND(SUM(montant),2) AS total FROM comptabilite
    WHERE distributeur_id = ? AND date BETWEEN ? AND ?
    GROUP BY type, categorie ORDER BY total DESC`).all(did(req), from, to);
  res.json({
    totalEntrees: round2(agg.totalEntrees),
    totalSorties: round2(agg.totalSorties),
    solde: round2(agg.totalEntrees - agg.totalSorties),
    parCategorie
  });
});

// Écriture manuelle (dépense / recette diverse).
r.post('/comptabilite', (req, res) => {
  const { type, categorie, montant, description } = req.body || {};
  if (!['ENTREE', 'SORTIE'].includes(type)) return res.status(400).json({ error: 'Type invalide (ENTREE/SORTIE)' });
  if (num(montant) <= 0) return res.status(400).json({ error: 'Montant invalide' });
  const info = ecritureCompta(did(req), { type, categorie: categorie || 'DIVERS', montant,
    description: description || '', par: req.user.username });
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ══════════════════════════════════════════
// 6. VENTES EN GROS & ENLÈVEMENTS (relicat marchandise)
// ══════════════════════════════════════════
r.get('/commandes-gros', (req, res) => {
  res.json(db.prepare(`
    SELECT cg.*, p.nom AS produit_nom, p.unite,
      CASE cg.entite_type WHEN 'CLIENT' THEN (SELECT nom FROM clients WHERE id = cg.entite_id)
                          ELSE (SELECT nom FROM distributeurs WHERE id = cg.entite_id) END AS entite_nom
    FROM commandes_gros cg LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE cg.distributeur_id = ? ORDER BY cg.created_at DESC`).all(did(req)));
});

// Vente en gros : ouvre un compte prépayé, FACTURE automatiquement la marchandise
// et DÉCLENCHE le suivi du stock (sortie immédiate). Les enlèvements ultérieurs ne
// font que livrer la marchandise déjà vendue (pas de nouvelle écriture).
r.post('/commandes-gros', (req, res) => {
  const { entite_type, entite_id, produit_id, quantite_totale, prix_unitaire, note } = req.body || {};
  if (!['CLIENT', 'DISTRIBUTEUR'].includes(entite_type)) return res.status(400).json({ error: 'Type d\'entité invalide' });
  const qte = num(quantite_totale);
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide' });

  const prod = produit_id
    ? db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(produit_id, did(req))
    : null;
  let client = null;
  if (entite_type === 'CLIENT')
    client = db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(num(entite_id), did(req));
  const pu = round2(num(prix_unitaire) || num(prod?.prix_vente_gros) || num(prod?.prix_vente));
  const tvaDef = profilDistributeur(did(req))?.tva_defaut ?? 18;
  const paiement = num(req.body?.montant_paye); // optionnel ; par défaut la vente est réglée (prépayée)

  try {
    const tx = db.transaction(() => {
      const info = db.prepare(`INSERT INTO commandes_gros
        (distributeur_id, entite_type, entite_id, produit_id, quantite_totale, quantite_restante, prix_unitaire, note)
        VALUES (?,?,?,?,?,?,?,?)`).run(did(req), entite_type, num(entite_id), produit_id || null,
          qte, qte, pu, note || '');
      const cgId = info.lastInsertRowid;

      // Suivi stock : sortie immédiate de la marchandise vendue (revenu = facture).
      if (prod) mouvementStock(did(req), prod, 'OUT', qte, pu,
        { motif: `Vente en gros ${prod.nom}`, reference: `GROS-${cgId}`, compta: false, username: req.user.username });

      // Facturation automatique de la commande en gros.
      let facture = null;
      if (client) {
        const montantTtc = round2(qte * pu * (1 + tvaDef / 100));
        const paye = req.body?.montant_paye != null ? round2(paiement) : montantTtc; // prépayée par défaut
        facture = creerFacture(did(req), {
          client_id: client.id,
          numero_bon: `GROS-${cgId}`,
          montant_paye: paye,
          mode_paiement: req.body?.mode_paiement || 'Prépayé (gros)',
          note: `Vente en gros — ${prod ? prod.nom : 'marchandise'} (${qte} ${prod?.unite || 't'})`,
          lignes: [{
            produit_id: prod?.id || null,
            designation: prod ? prod.nom : 'Marchandise (gros)',
            quantite: qte, unite: prod?.unite || 't',
            prix_unitaire: pu, remise: 0, tva: prod ? num(prod.tva, tvaDef) : tvaDef
          }]
        }, req.user.username, { deduireStock: false }); // stock déjà déduit ci-dessus
        db.prepare(`UPDATE commandes_gros SET facture_id = ?, facture_numero = ? WHERE id = ?`)
          .run(facture.id, facture.numero, cgId);
      }
      return { id: cgId, facture };
    });
    const r2 = tx();
    res.json({ ok: true, id: r2.id, facture: r2.facture });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

r.get('/enlevements', (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, p.nom AS produit_nom, p.unite,
      CASE cg.entite_type WHEN 'CLIENT' THEN (SELECT nom FROM clients WHERE id = cg.entite_id)
                          ELSE (SELECT nom FROM distributeurs WHERE id = cg.entite_id) END AS entite_nom,
      (SELECT immatriculation FROM clients WHERE id = cg.entite_id) AS immatriculation
    FROM enlevements e
    LEFT JOIN commandes_gros cg ON cg.id = e.commande_gros_id
    LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE e.distributeur_id = ? ORDER BY e.date DESC LIMIT 500`).all(did(req)));
});

// Enlèvement fractionné : livraison d'une marchandise DÉJÀ vendue et facturée à
// l'ouverture du compte gros. Le stock a déjà été déduit à la vente : on ne déduit
// donc que le solde de marchandise restant à enlever (pas de double déduction).
// Chaque enlèvement reçoit un BON D'ENLÈVEMENT numéroté, signé et imprimable.
r.post('/enlevements', (req, res) => {
  const cg = db.prepare(`SELECT * FROM commandes_gros WHERE id = ? AND distributeur_id = ?`)
    .get(req.body?.commande_gros_id, did(req));
  if (!cg) return res.status(404).json({ error: 'Commande en gros introuvable' });
  const qte = num(req.body?.quantite_enlevee);
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  if (qte > cg.quantite_restante)
    return res.status(400).json({ error: 'Quantité demandée indisponible pour cet enlèvement' });

  const prod = cg.produit_id
    ? db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(cg.produit_id, did(req))
    : null;
  const client = cg.entite_type === 'CLIENT'
    ? db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(cg.entite_id, did(req))
    : null;
  const chauffeur = (req.body?.chauffeur || '').toString();
  const immatriculation = (req.body?.immatriculation || client?.immatriculation || '').toString();
  const destination = (req.body?.destination || '').toString();

  try {
    const tx = db.transaction(() => {
      db.prepare(`UPDATE commandes_gros SET quantite_restante = quantite_restante - ? WHERE id = ?`).run(qte, cg.id);

      // Bon d'enlèvement numéroté (séquence par distributeur) + signature électronique.
      const last = db.prepare(`SELECT COALESCE(MAX(numero),0) m FROM bons_commande WHERE distributeur_id = ?`).get(did(req)).m;
      const numero = last + 1;
      const reference = `ENL-${did(req)}-${String(numero).padStart(4, '0')}`;
      const info = db.prepare(`INSERT INTO bons_commande
        (distributeur_id, reference, numero, client, produit, immatriculation, chauffeur, destination,
         quantite_prevue, note, statut, cree_par)
        VALUES (?,?,?,?,?,?,?,?,?,?,'termine',?)`).run(
          did(req), reference, numero, client?.nom || '', prod?.nom || '', immatriculation, chauffeur, destination,
          qte, `Enlèvement gros #${cg.id} — ${qte} ${prod?.unite || 't'}`, req.user.username);
      const bonId = info.lastInsertRowid;
      const bonRow = db.prepare(`SELECT * FROM bons_commande WHERE id = ?`).get(bonId);
      const sig = signerBon(bonRow, req.user.username);
      db.prepare(`UPDATE bons_commande SET signature=?, signature_par=?, signature_le=? WHERE id=?`)
        .run(sig.signature, sig.signataire, sig.le, bonId);
      db.prepare(`INSERT INTO bons_commande_evts (bon_id, statut, detail, par) VALUES (?,?,?,?)`)
        .run(bonId, 'termine', `Bon d'enlèvement émis (${qte} ${prod?.unite || 't'})`, req.user.username);

      db.prepare(`INSERT INTO enlevements (distributeur_id, commande_gros_id, quantite_enlevee, operateur, bon_id, bon_numero)
        VALUES (?,?,?,?,?,?)`).run(did(req), cg.id, qte, req.user.username, bonId, reference);

      return { bon: { id: bonId, numero, reference } };
    });
    const r2 = tx();
    res.json({ ok: true, restant: round2(cg.quantite_restante - qte), bon: r2.bon });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ══════════════════════════════════════════
// 7. PARAMÈTRES DE FACTURATION (identité légale du distributeur)
// ══════════════════════════════════════════
r.get('/parametres', (req, res) => {
  const d = profilDistributeur(did(req));
  if (!d) return res.status(404).json({ error: 'Espace introuvable' });
  res.json({
    id: d.id, nom: d.nom, raison_sociale: d.raison_sociale, adresse: d.adresse, ville: d.ville,
    telephone: d.telephone, email: d.email, ninea: d.ninea, rccm: d.rccm,
    devise: d.devise || 'FCFA', tva_defaut: d.tva_defaut ?? 18, pied_facture: d.pied_facture,
    logo: d.logo || null
  });
});

// Upload / mise à jour du logo (admin) : reçoit une image en data URL, l'enregistre
// dans public/uploads et stocke le chemin pour l'impression des factures & bons.
r.post('/parametres/logo', requireRole('admin'), (req, res) => {
  const dataUrl = (req.body?.dataUrl || '').toString();
  const m = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Image invalide (PNG, JPG, WEBP ou SVG attendu)' });
  const ext = m[1] === 'jpeg' ? 'jpg' : (m[1] === 'svg+xml' ? 'svg' : m[1]);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo trop volumineux (max 2 Mo)' });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const fichier = `logo-${did(req)}.${ext}`;
  // Nettoie les anciens logos de ce distributeur (autres extensions).
  for (const e of ['png', 'jpg', 'webp', 'svg'])
    { try { fs.unlinkSync(path.join(UPLOAD_DIR, `logo-${did(req)}.${e}`)); } catch {} }
  fs.writeFileSync(path.join(UPLOAD_DIR, fichier), buf);
  const url = `/uploads/${fichier}`;
  db.prepare(`UPDATE distributeurs SET logo = ? WHERE id = ?`).run(url, did(req));
  res.json({ ok: true, logo: url });
});

// Suppression du logo.
r.delete('/parametres/logo', requireRole('admin'), (req, res) => {
  const d = profilDistributeur(did(req));
  if (d?.logo) { try { fs.unlinkSync(path.join(__dirname, '..', '..', 'public', d.logo)); } catch {} }
  db.prepare(`UPDATE distributeurs SET logo = NULL WHERE id = ?`).run(did(req));
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 8. RECHERCHE GLOBALE (factures, bons, enlèvements, stock) + réimpression
// ══════════════════════════════════════════
r.get('/recherche', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ factures: [], bons: [], enlevements: [], produits: [] });
  const like = `%${q}%`;

  const factures = db.prepare(`SELECT fa.id, fa.numero, fa.numero_bon, fa.date, fa.montant_total,
      fa.montant_paye, fa.relicat, fa.statut, COALESCE(c.nom, fa.client_nom) AS client_nom
    FROM factures fa LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.distributeur_id = ?
      AND (fa.numero LIKE ? OR fa.numero_bon LIKE ? OR c.nom LIKE ? OR fa.client_nom LIKE ?)
    ORDER BY fa.date DESC LIMIT 50`).all(did(req), like, like, like, like);

  const bons = db.prepare(`SELECT id, reference, numero, client, produit, immatriculation, quantite_prevue,
      statut, created_at FROM bons_commande
    WHERE distributeur_id = ?
      AND (reference LIKE ? OR CAST(numero AS TEXT) LIKE ? OR client LIKE ? OR immatriculation LIKE ? OR produit LIKE ?)
    ORDER BY created_at DESC LIMIT 50`).all(did(req), like, like, like, like, like);

  const enlevements = db.prepare(`SELECT e.id, e.bon_id, e.bon_numero, e.quantite_enlevee, e.date,
      p.nom AS produit_nom, p.unite,
      CASE cg.entite_type WHEN 'CLIENT' THEN (SELECT nom FROM clients WHERE id = cg.entite_id)
                          ELSE (SELECT nom FROM distributeurs WHERE id = cg.entite_id) END AS entite_nom
    FROM enlevements e
    LEFT JOIN commandes_gros cg ON cg.id = e.commande_gros_id
    LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE e.distributeur_id = ?
      AND (e.bon_numero LIKE ? OR p.nom LIKE ?
        OR (SELECT nom FROM clients WHERE id = cg.entite_id) LIKE ?)
    ORDER BY e.date DESC LIMIT 50`).all(did(req), like, like, like);

  const produits = db.prepare(`SELECT id, nom, reference, unite, stock_actuel, prix_vente, prix_vente_gros, tva
    FROM produits WHERE distributeur_id = ? AND (nom LIKE ? OR reference LIKE ?)
    ORDER BY nom LIMIT 50`).all(did(req), like, like);

  res.json({ factures, bons, enlevements, produits });
});

// Seul l'administrateur de l'espace configure l'identité de facturation.
r.put('/parametres', requireRole('admin'), (req, res) => {
  const d = profilDistributeur(did(req));
  if (!d) return res.status(404).json({ error: 'Espace introuvable' });
  const b = req.body || {};
  db.prepare(`UPDATE distributeurs SET raison_sociale=?, adresse=?, ville=?, telephone=?,
      email=?, ninea=?, rccm=?, devise=?, tva_defaut=?, pied_facture=? WHERE id=?`)
    .run(b.raison_sociale ?? d.raison_sociale, b.adresse ?? d.adresse, b.ville ?? d.ville,
      b.telephone ?? d.telephone, b.email ?? d.email, b.ninea ?? d.ninea, b.rccm ?? d.rccm,
      b.devise || d.devise || 'FCFA', b.tva_defaut != null ? num(b.tva_defaut) : (d.tva_defaut ?? 18),
      b.pied_facture ?? d.pied_facture, d.id);
  res.json({ ok: true });
});

export default r;
