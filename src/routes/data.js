import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, scopeDistributeur, denySuperadmin, denyFournisseur } from '../lib/auth.js';

const r = Router();
r.use(requireAuth);
// Le super-admin n'a aucun accès aux données métier des distributeurs.
// (denySuperadmin est appliqué par route : ce routeur est monté sur le préfixe
//  « /api » partagé, un r.use global bloquerait aussi /api/admin et /api/auth.)

function dateRange(req) {
  const from = (req.query.from || '1970-01-01') + ' 00:00:00';
  const to   = (req.query.to   || '2999-12-31') + ' 23:59:59';
  return { from, to };
}

// Liste des bons / pesées (sorties) de l'espace
r.get('/sorties', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const { from, to } = dateRange(req);
  const where = did ? 'AND s.distributeur_id = @did' : '';
  const rows = db.prepare(`
    SELECT s.*, d.nom AS distributeur_nom FROM sorties s
    JOIN distributeurs d ON d.id = s.distributeur_id
    WHERE s.date_sortie BETWEEN @from AND @to ${where}
    ORDER BY s.date_sortie DESC LIMIT 1000`).all({ from, to, did });
  res.json(rows.map(mapSortie));
});

// Liste des entrées de l'espace
r.get('/entrees', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const { from, to } = dateRange(req);
  const where = did ? 'AND e.distributeur_id = @did' : '';
  const rows = db.prepare(`
    SELECT e.* FROM entrees e
    WHERE e.date_entree BETWEEN @from AND @to ${where}
    ORDER BY e.date_entree DESC LIMIT 1000`).all({ from, to, did });
  res.json(rows.map(mapEntree));
});

// Suivi clients (agrégé depuis les pesées) de l'espace
r.get('/clients-suivi', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const where = did ? 'WHERE distributeur_id = @did' : '';
  const rows = db.prepare(`
    SELECT client AS nom, COUNT(*) AS nbBons,
           ROUND(SUM(poids_net), 3) AS totalTonnes,
           ROUND(SUM(montant_total), 2) AS totalMontant,
           MAX(date_sortie) AS dernierPassage
    FROM sorties ${where}
    GROUP BY client ORDER BY totalTonnes DESC`).all({ did });
  res.json(rows.filter(x => x.nom));
});

// Statistiques (rapport) de l'espace pour une journée
r.get('/stats', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const from = date + ' 00:00:00', to = date + ' 23:59:59';
  const where = did ? 'AND distributeur_id = @did' : '';
  const agg = db.prepare(`
    SELECT COUNT(*) nbCamions, COALESCE(SUM(poids_net),0) totalTonnes,
           COALESCE(AVG(poids_net),0) moyenneTonnes, COALESCE(SUM(montant_total),0) chiffreAffaires
    FROM sorties WHERE date_sortie BETWEEN @from AND @to ${where}`).get({ from, to, did });
  const parProduit = db.prepare(`
    SELECT produit, ROUND(SUM(poids_net),3) total FROM sorties
    WHERE date_sortie BETWEEN @from AND @to ${where}
    GROUP BY produit ORDER BY total DESC`).all({ from, to, did });
  const parClient = db.prepare(`
    SELECT client, ROUND(SUM(poids_net),3) total FROM sorties
    WHERE date_sortie BETWEEN @from AND @to ${where}
    GROUP BY client ORDER BY total DESC`).all({ from, to, did });
  res.json({
    date,
    nbCamions: agg.nbCamions,
    totalTonnes: round(agg.totalTonnes, 3),
    moyenneTonnes: round(agg.moyenneTonnes, 3),
    chiffreAffaires: round(agg.chiffreAffaires, 2),
    parProduit: Object.fromEntries(parProduit.filter(x => x.produit).map(x => [x.produit, x.total])),
    parClient: Object.fromEntries(parClient.filter(x => x.client).map(x => [x.client, x.total]))
  });
});

// Bon de pesage imprimable (HTML) — vérifie l'appartenance à l'espace
r.get('/bon', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const id = Number(req.query.id || 0);
  const where = did ? 'AND distributeur_id = @did' : '';
  const s = db.prepare(`SELECT * FROM sorties WHERE id = @id ${where}`).get({ id, did });
  if (!s) return res.status(404).send('Bon introuvable');
  res.set('Content-Type', 'text/html; charset=utf-8').send(bonHtml(s));
});

// Envoyer un bon à l'impression distante (relais vers le LQ-350 du site)
r.post('/bons', denySuperadmin, denyFournisseur, (req, res) => {
  const did = scopeDistributeur(req);
  const id = Number(req.body?.sortieId || 0);
  const where = did ? 'AND distributeur_id = @did' : '';
  const s = db.prepare(`SELECT * FROM sorties WHERE id = @id ${where}`).get({ id, did });
  if (!s) return res.status(404).json({ error: 'Bon introuvable dans votre espace' });
  db.prepare(`INSERT INTO print_jobs (distributeur_id, source_id, numero_ticket, requested_by)
              VALUES (?, ?, ?, ?)`).run(s.distributeur_id, s.source_id, s.numero_ticket, req.user.username);
  res.json({ ok: true, message: 'Bon envoyé à l\'imprimante du pont bascule (file d\'attente).' });
});

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

function mapSortie(s) {
  return {
    id: s.id, sourceId: s.source_id, numeroTicket: s.numero_ticket,
    immatriculation: s.immatriculation, chauffeur: s.chauffeur, client: s.client,
    produit: s.produit, poidsEntree: s.poids_entree, poidsSortie: s.poids_sortie,
    poidsNet: s.poids_net, prixUnitaire: s.prix_unitaire, montantTotal: s.montant_total,
    dateSortie: s.date_sortie, operateur: s.operateur, destination: s.destination,
    numeroBon: s.numero_bon, typeTransaction: s.type_transaction, imprime: !!s.imprime,
    distributeur: s.distributeur_nom
  };
}
function mapEntree(e) {
  return {
    id: e.id, sourceId: e.source_id, numeroTicket: e.numero_ticket,
    immatriculation: e.immatriculation, chauffeur: e.chauffeur, client: e.client,
    produit: e.produit, poidsEntree: e.poids_entree, dateEntree: e.date_entree,
    operateur: e.operateur, origine: e.origine, distributeur: e.distributeur
  };
}

function esc(x) { return String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function bonHtml(s) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Bon ${esc(s.numero_ticket)}</title>
<style>
body{font-family:Arial,sans-serif;color:#111;margin:0;padding:28px;}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;}
.title{font-size:26px;font-weight:800;letter-spacing:1px;}
table{width:100%;border-collapse:collapse;margin-top:14px;}
td{padding:7px 4px;border-bottom:1px solid #ddd;font-size:13px;}
.lbl{color:#666;}.val{font-weight:700;text-align:right;}
.poids{display:flex;gap:10px;margin-top:18px;text-align:center;}
.poids>div{flex:1;border:1px solid #aaa;border-radius:6px;padding:14px;}
.poids .big{font-size:24px;font-weight:800;}
.net{border:2px solid #111 !important;}
.sign{display:flex;justify-content:space-between;margin-top:48px;color:#666;font-size:12px;}
.sign>div{width:42%;border-top:1px solid #aaa;text-align:center;padding-top:6px;}
.foot{text-align:center;color:#999;font-size:11px;margin-top:26px;}
@media print{button{display:none;}}
</style></head><body>
<div class="head"><div class="title">⚖ mGlobal Pont Bascule</div>
<div style="text-align:right"><div style="font-size:18px;font-weight:800">BON DE PESAGE</div>
<div>N° ${esc(s.numero_ticket)}</div><div style="color:#666">${esc(s.date_sortie)}</div></div></div>
<table>
<tr><td class="lbl">Immatriculation</td><td class="val">${esc(s.immatriculation)}</td>
    <td class="lbl">Chauffeur</td><td class="val">${esc(s.chauffeur)}</td></tr>
<tr><td class="lbl">Client</td><td class="val">${esc(s.client)}</td>
    <td class="lbl">Produit</td><td class="val">${esc(s.produit)}</td></tr>
<tr><td class="lbl">Destination</td><td class="val">${esc(s.destination)}</td>
    <td class="lbl">N° Bon Ext.</td><td class="val">${esc(s.numero_bon)}</td></tr>
<tr><td class="lbl">Opérateur</td><td class="val">${esc(s.operateur)}</td>
    <td class="lbl">Type</td><td class="val">${esc(s.type_transaction)}</td></tr>
</table>
<div class="poids">
<div><div class="lbl">POIDS ENTRÉE</div><div class="big">${Number(s.poids_entree ?? 0).toFixed(3)} t</div></div>
<div class="net"><div class="lbl">POIDS NET CHARGÉ</div><div class="big">${Number(s.poids_net ?? 0).toFixed(3)} t</div>
  <div style="color:#666">= ${Number(s.montant_total ?? 0).toFixed(2)}</div></div>
<div><div class="lbl">POIDS SORTIE</div><div class="big">${Number(s.poids_sortie ?? 0).toFixed(3)} t</div></div>
</div>
<div class="sign"><div>Signature &amp; Cachet Client</div><div>Signature Chauffeur</div></div>
<div class="foot">Document généré par la plateforme mGlobal — ${new Date().toLocaleString('fr-FR')}</div>
<div style="text-align:center;margin-top:18px"><button onclick="window.print()">🖨 Imprimer</button></div>
</body></html>`;
}

export default r;
