import { Router } from 'express';
import db from '../lib/db.js';
import { customAlphabet } from 'nanoid';
import { requireAuth, denySuperadmin, requireEspaceActif } from '../lib/auth.js';

const r = Router();
// Tous les modules métier appartiennent à un distributeur : authentification
// obligatoire, aucun accès super-admin, et blocage si l'espace est gelé/désactivé.
r.use(requireAuth, denySuperadmin, requireEspaceActif);

const codeImmat = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const round2 = (v) => Math.round(v * 100) / 100;

// Distributeur courant (jamais null ici : le super-admin est bloqué en amont).
const did = (req) => req.user.did;

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
  const { nom, description, unite, stock_actuel, stock_alerte, prix_achat, prix_vente_gros, fournisseur_id } = req.body || {};
  if (!nom) return res.status(400).json({ error: 'Le nom du produit est requis' });
  const info = db.prepare(`INSERT INTO produits
    (distributeur_id, nom, description, unite, stock_actuel, stock_alerte, prix_achat, prix_vente_gros, fournisseur_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(did(req), nom, description || '', unite || 't',
      num(stock_actuel), num(stock_alerte, 10), num(prix_achat), num(prix_vente_gros),
      fournisseur_id || null);
  res.json(db.prepare(`SELECT * FROM produits WHERE id = ?`).get(info.lastInsertRowid));
});

r.put('/produits/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM produits WHERE id = ? AND distributeur_id = ?`).get(req.params.id, did(req));
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  const b = req.body || {};
  db.prepare(`UPDATE produits SET nom=?, description=?, unite=?, stock_alerte=?, prix_achat=?, prix_vente_gros=?, fournisseur_id=? WHERE id=?`)
    .run(b.nom ?? p.nom, b.description ?? p.description, b.unite ?? p.unite,
      b.stock_alerte != null ? num(b.stock_alerte) : p.stock_alerte,
      b.prix_achat != null ? num(b.prix_achat) : p.prix_achat,
      b.prix_vente_gros != null ? num(b.prix_vente_gros) : p.prix_vente_gros,
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
  });
  tx();
  res.json({ ok: true, produit: db.prepare(`SELECT * FROM produits WHERE id = ?`).get(p.id) });
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
    SELECT fa.*, c.nom AS client_nom, c.immatriculation FROM factures fa
    LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.distributeur_id = ? ORDER BY fa.date DESC, fa.id DESC LIMIT 500`).all(did(req)));
});

r.post('/factures', (req, res) => {
  const { client_id, montant_total, montant_paye, note } = req.body || {};
  const total = round2(num(montant_total));
  const paye = round2(num(montant_paye));
  if (total <= 0) return res.status(400).json({ error: 'Montant total invalide' });
  let client = null;
  if (client_id) {
    client = db.prepare(`SELECT * FROM clients WHERE id = ? AND distributeur_id = ?`).get(client_id, did(req));
    if (!client) return res.status(404).json({ error: 'Client introuvable dans votre espace' });
  }
  const relicat = round2(total - paye); // >0 : dette ; <0 : trop-perçu
  const seq = db.prepare(`SELECT COUNT(*) n FROM factures WHERE distributeur_id = ?`).get(did(req)).n + 1;
  const numero = `FAC-${did(req)}-${String(seq).padStart(4, '0')}`;

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO factures
      (distributeur_id, numero, client_id, montant_total, montant_paye, relicat, note, cree_par)
      VALUES (?,?,?,?,?,?,?,?)`).run(did(req), numero, client_id || null, total, paye, relicat,
        note || '', req.user.username);
    if (client) {
      if (relicat > 0) db.prepare(`UPDATE clients SET solde_dette = solde_dette + ? WHERE id = ?`).run(relicat, client.id);
      else if (relicat < 0) db.prepare(`UPDATE clients SET solde_relicat = solde_relicat + ? WHERE id = ?`).run(Math.abs(relicat), client.id);
    }
    if (paye > 0)
      ecritureCompta(did(req), { type: 'ENTREE', categorie: 'VENTE', montant: paye,
        description: `Encaissement facture ${numero}`, clientId: client_id || null,
        factureId: info.lastInsertRowid, par: req.user.username });
    return info.lastInsertRowid;
  });
  const id = tx();
  res.json({ ok: true, id, numero, relicat });
});

// Facture imprimable (HTML).
r.get('/factures/:id/imprimer', (req, res) => {
  const fa = db.prepare(`SELECT fa.*, c.nom AS client_nom, c.immatriculation, c.telephone, c.adresse
    FROM factures fa LEFT JOIN clients c ON c.id = fa.client_id
    WHERE fa.id = ? AND fa.distributeur_id = ?`).get(req.params.id, did(req));
  if (!fa) return res.status(404).send('Facture introuvable');
  res.set('Content-Type', 'text/html; charset=utf-8').send(factureHtml(fa));
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

r.post('/commandes-gros', (req, res) => {
  const { entite_type, entite_id, produit_id, quantite_totale, prix_unitaire, note } = req.body || {};
  if (!['CLIENT', 'DISTRIBUTEUR'].includes(entite_type)) return res.status(400).json({ error: 'Type d\'entité invalide' });
  const qte = num(quantite_totale);
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  const info = db.prepare(`INSERT INTO commandes_gros
    (distributeur_id, entite_type, entite_id, produit_id, quantite_totale, quantite_restante, prix_unitaire, note)
    VALUES (?,?,?,?,?,?,?,?)`).run(did(req), entite_type, num(entite_id), produit_id || null,
      qte, qte, num(prix_unitaire), note || '');
  res.json({ ok: true, id: info.lastInsertRowid });
});

r.get('/enlevements', (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, p.nom AS produit_nom FROM enlevements e
    LEFT JOIN commandes_gros cg ON cg.id = e.commande_gros_id
    LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE e.distributeur_id = ? ORDER BY e.date DESC LIMIT 500`).all(did(req)));
});

// Enlèvement fractionné : déduit du gros et du stock physique.
r.post('/enlevements', (req, res) => {
  const cg = db.prepare(`SELECT * FROM commandes_gros WHERE id = ? AND distributeur_id = ?`)
    .get(req.body?.commande_gros_id, did(req));
  if (!cg) return res.status(404).json({ error: 'Commande en gros introuvable' });
  const qte = num(req.body?.quantite_enlevee);
  if (qte <= 0) return res.status(400).json({ error: 'Quantité invalide' });
  if (qte > cg.quantite_restante)
    return res.status(400).json({ error: 'Quantité demandée indisponible pour cet enlèvement' });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE commandes_gros SET quantite_restante = quantite_restante - ? WHERE id = ?`).run(qte, cg.id);
    db.prepare(`INSERT INTO enlevements (distributeur_id, commande_gros_id, quantite_enlevee, operateur)
      VALUES (?,?,?,?)`).run(did(req), cg.id, qte, req.user.username);
    if (cg.produit_id)
      db.prepare(`UPDATE produits SET stock_actuel = stock_actuel - ? WHERE id = ? AND distributeur_id = ?`)
        .run(qte, cg.produit_id, did(req));
  });
  tx();
  res.json({ ok: true, restant: round2(cg.quantite_restante - qte) });
});

// ── Rendu HTML d'une facture imprimable ──
function esc(x) { return String(x ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function fmtMoney(v) { return Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function factureHtml(fa) {
  const reste = Number(fa.relicat || 0);
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${esc(fa.numero)}</title>
<style>body{font-family:Arial,sans-serif;color:#111;padding:32px;max-width:720px;margin:auto;}
.head{display:flex;justify-content:space-between;border-bottom:3px solid #111;padding-bottom:10px;}
.title{font-size:24px;font-weight:800;}table{width:100%;border-collapse:collapse;margin-top:18px;}
td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left;}th{background:#f5f5f5;}
.tot{text-align:right;font-size:15px;margin-top:18px;}.tot b{display:inline-block;min-width:160px;}
@media print{button{display:none;}}</style></head><body>
<div class="head"><div class="title">⚖ mGlobal — Facture</div>
<div style="text-align:right"><div style="font-weight:800">${esc(fa.numero)}</div>
<div style="color:#666">${esc((fa.date || '').slice(0, 16))}</div></div></div>
<table><tr><th>Client</th><td>${esc(fa.client_nom || '—')}</td>
<th>Immatriculation</th><td>${esc(fa.immatriculation || '—')}</td></tr>
<tr><th>Téléphone</th><td>${esc(fa.telephone || '—')}</td>
<th>Adresse</th><td>${esc(fa.adresse || '—')}</td></tr></table>
<div class="tot">
<div><b>Montant total :</b> ${fmtMoney(fa.montant_total)} FCFA</div>
<div><b>Montant réglé :</b> ${fmtMoney(fa.montant_paye)} FCFA</div>
<div style="font-weight:800;color:${reste > 0 ? '#c53030' : '#2f855a'}">
<b>${reste >= 0 ? 'Reste à payer' : 'Trop-perçu (relicat)'} :</b> ${fmtMoney(Math.abs(reste))} FCFA</div></div>
${fa.note ? `<p style="color:#666;margin-top:14px">${esc(fa.note)}</p>` : ''}
<div style="text-align:center;margin-top:28px"><button onclick="window.print()">🖨 Imprimer</button></div>
</body></html>`;
}

export default r;
