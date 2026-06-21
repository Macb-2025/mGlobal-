import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, scopeDistributeur, denySuperadmin, requireEspaceActif } from '../lib/auth.js';
import { signerBon, verifierBon } from '../lib/signature.js';
import { emitToSites, emitToDistributeur } from '../lib/realtime.js';

const r = Router();
r.use(requireAuth);
// Les bons appartiennent aux distributeurs : aucun accès super-admin, et tout
// est bloqué si l'espace est désactivé ou gelé par le super-admin.
r.use(denySuperadmin);
r.use(requireEspaceActif);

// Libellés et progression (%) de chaque statut, pour le suivi d'avancement.
export const STATUTS = ['en_attente', 'recu', 'en_cours', 'pese', 'termine', 'rejete', 'annule'];
const PROGRESSION = { en_attente: 10, recu: 35, en_cours: 60, pese: 85, termine: 100, rejete: 100, annule: 100 };

// Seul l'administrateur du distributeur gère les bons (modifier/annuler/supprimer).
const estAdmin = (req) => req.user.role === 'admin';
// La création est ouverte à l'admin, l'assistante, le comptable (et l'opérateur,
// rôle hérité), mais pas au superviseur (consultation uniquement).
const peutCreer = (req) => ['admin', 'assistante', 'comptable', 'operateur'].includes(req.user.role);

function mapBon(b) {
  return {
    id: b.id, reference: b.reference, numero: b.numero, distributeurId: b.distributeur_id,
    distributeur: b.distributeur_nom, client: b.client, produit: b.produit,
    immatriculation: b.immatriculation, chauffeur: b.chauffeur, destination: b.destination,
    quantitePrevue: b.quantite_prevue, note: b.note, statut: b.statut,
    progression: PROGRESSION[b.statut] ?? 0, creePar: b.cree_par,
    recuLe: b.recu_le, traiteLe: b.traite_le, poidsNet: b.poids_net,
    numeroTicket: b.numero_ticket, operateur: b.operateur, motifRejet: b.motif_rejet,
    sourceSortieId: b.source_sortie_id, createdAt: b.created_at, updatedAt: b.updated_at,
    signature: b.signature, signaturePar: b.signature_par, signatureLe: b.signature_le,
    signatureValide: b.signature ? verifierBon(b) : null
  };
}

function fetchBonRow(id) {
  return db.prepare(`SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
                     JOIN distributeurs d ON d.id = bc.distributeur_id WHERE bc.id = ?`).get(id);
}

function logEvt(bonId, statut, detail, par) {
  db.prepare(`INSERT INTO bons_commande_evts (bon_id, statut, detail, par) VALUES (?,?,?,?)`)
    .run(bonId, statut, detail, par);
}

// Création d'un bon de commande par le distributeur (statut initial : en_attente).
// Le bon est numéroté (séquence par distributeur) et signé électroniquement.
r.post('/', (req, res) => {
  if (!peutCreer(req)) return res.status(403).json({ error: 'Rôle insuffisant pour créer un bon' });
  const did = req.user.did;
  if (!did) return res.status(400).json({ error: 'Espace distributeur introuvable' });

  const b = req.body || {};
  if (!b.client && !b.immatriculation)
    return res.status(400).json({ error: 'Renseignez au moins le client ou l\'immatriculation' });

  // Numérotation séquentielle, propre à chaque distributeur.
  const last = db.prepare(`SELECT COALESCE(MAX(numero),0) m FROM bons_commande WHERE distributeur_id = ?`).get(did).m;
  const numero = last + 1;
  const reference = b.reference || `BC-${did}-${String(numero).padStart(4, '0')}`;

  const info = db.prepare(`
    INSERT INTO bons_commande (distributeur_id, reference, numero, client, produit, immatriculation,
      chauffeur, destination, quantite_prevue, note, statut, cree_par)
    VALUES (@did, @reference, @numero, @client, @produit, @immatriculation, @chauffeur, @destination,
      @quantite, @note, 'en_attente', @par)`).run({
    did, reference, numero,
    client: b.client || '', produit: b.produit || '', immatriculation: b.immatriculation || '',
    chauffeur: b.chauffeur || '', destination: b.destination || '',
    quantite: Number(b.quantitePrevue || 0), note: b.note || '', par: req.user.username
  });
  const id = info.lastInsertRowid;

  // Signature électronique du bon (empreinte vérifiable + signataire + horodatage).
  const row = fetchBonRow(id);
  const sig = signerBon(row, req.user.username);
  db.prepare(`UPDATE bons_commande SET signature=@s, signature_par=@p, signature_le=@l WHERE id=@id`)
    .run({ s: sig.signature, p: sig.signataire, l: sig.le, id });

  logEvt(id, 'en_attente', 'Bon créé, signé et envoyé au pont bascule', req.user.username);

  const bon = mapBon(fetchBonRow(id));
  emitToSites('bon:nouveau', { bon });
  emitToDistributeur(did, 'bon:maj', { bon });
  res.json({ ok: true, bon });
});

// Liste / suivi des bons de l'espace
r.get('/', (req, res) => {
  const did = scopeDistributeur(req);
  const statut = req.query.statut;
  const cond = [];
  const params = {};
  if (did) { cond.push('bc.distributeur_id = @did'); params.did = did; }
  if (statut && STATUTS.includes(statut)) { cond.push('bc.statut = @statut'); params.statut = statut; }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
                           JOIN distributeurs d ON d.id = bc.distributeur_id
                           ${where} ORDER BY bc.created_at DESC LIMIT 500`).all(params);
  res.json(rows.map(mapBon));
});

// Vérification automatique du client à la saisie d'un bon : recherche le client par
// immatriculation (clé unique) ou par nom (plusieurs clients peuvent partager un nom)
// et indique s'il dispose d'un compte gros avec solde à enlever → mode « enlèvement ».
r.get('/verif-client', (req, res) => {
  const did = scopeDistributeur(req);
  const imm = String(req.query.immatriculation || '').trim().toUpperCase();
  const nom = String(req.query.nom || '').trim();
  if (!imm && !nom) return res.json({ clients: [], aGros: false });

  let clients = [];
  if (imm)
    clients = db.prepare(`SELECT id, nom, immatriculation, telephone FROM clients
      WHERE distributeur_id = ? AND UPPER(immatriculation) = ?`).all(did, imm);
  if (!clients.length && nom)
    clients = db.prepare(`SELECT id, nom, immatriculation, telephone FROM clients
      WHERE distributeur_id = ? AND LOWER(nom) = LOWER(?) ORDER BY id LIMIT 10`).all(did, nom);

  const gros = db.prepare(`SELECT cg.id, cg.quantite_restante, cg.prix_unitaire, p.nom AS produit_nom, p.unite
    FROM commandes_gros cg LEFT JOIN produits p ON p.id = cg.produit_id
    WHERE cg.distributeur_id = ? AND cg.entite_type = 'CLIENT' AND cg.entite_id = ? AND cg.quantite_restante > 0
    ORDER BY cg.created_at DESC`);
  const out = clients.map(c => ({ ...c, gros: gros.all(did, c.id) }));
  const aGros = out.some(c => c.gros.length > 0);
  res.json({ clients: out, aGros, mode: aGros ? 'enlevement' : 'nouveau_bon' });
});

// Bon de commande imprimable (HTML) — généré à l'envoi au pont bascule.
r.get('/:id/imprimer', (req, res) => {
  const did = scopeDistributeur(req);
  const id = Number(req.params.id);
  const where = did ? 'AND bc.distributeur_id = @did' : '';
  const row = db.prepare(`SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
                          JOIN distributeurs d ON d.id = bc.distributeur_id
                          WHERE bc.id = @id ${where}`).get({ id, did });
  if (!row) return res.status(404).send('Bon introuvable dans votre espace');
  const dist = db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(row.distributeur_id);
  res.set('Content-Type', 'text/html; charset=utf-8').send(bonCommandeHtml(row, dist));
});

// Détail + timeline d'avancement d'un bon (suivi)
r.get('/:id', (req, res) => {
  const did = scopeDistributeur(req);
  const id = Number(req.params.id);
  const where = did ? 'AND bc.distributeur_id = @did' : '';
  const row = db.prepare(`SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
                          JOIN distributeurs d ON d.id = bc.distributeur_id
                          WHERE bc.id = @id ${where}`).get({ id, did });
  if (!row) return res.status(404).json({ error: 'Bon introuvable dans votre espace' });
  const evts = db.prepare(`SELECT statut, detail, par, ts FROM bons_commande_evts
                           WHERE bon_id = ? ORDER BY ts ASC, id ASC`).all(id);
  res.json({ ...mapBon(row), timeline: evts });
});

// Récupère un bon de l'espace de l'utilisateur (vérifie l'appartenance).
function bonDeLEspace(req) {
  const id = Number(req.params.id);
  return db.prepare(`SELECT * FROM bons_commande WHERE id = ? AND distributeur_id = ?`)
    .get(id, req.user.did);
}

// Modification d'un bon (administrateur du distributeur uniquement).
// Possible tant que le bon n'a pas été pris en charge par le pont bascule.
r.patch('/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Seul l\'administrateur peut modifier un bon' });
  const row = bonDeLEspace(req);
  if (!row) return res.status(404).json({ error: 'Bon introuvable' });
  if (!['en_attente', 'recu'].includes(row.statut))
    return res.status(409).json({ error: 'Ce bon est déjà en traitement et ne peut plus être modifié' });

  const b = req.body || {};
  const champs = {
    client: b.client ?? row.client, produit: b.produit ?? row.produit,
    immatriculation: b.immatriculation ?? row.immatriculation, chauffeur: b.chauffeur ?? row.chauffeur,
    destination: b.destination ?? row.destination,
    quantite: b.quantitePrevue != null ? Number(b.quantitePrevue) : row.quantite_prevue,
    note: b.note ?? row.note, id: row.id
  };
  db.prepare(`UPDATE bons_commande SET client=@client, produit=@produit, immatriculation=@immatriculation,
    chauffeur=@chauffeur, destination=@destination, quantite_prevue=@quantite, note=@note,
    updated_at=datetime('now') WHERE id=@id`).run(champs);

  // Re-signature après modification (intégrité conservée, nouveau signataire/horodatage).
  const maj = fetchBonRow(row.id);
  const sig = signerBon(maj, req.user.username);
  db.prepare(`UPDATE bons_commande SET signature=@s, signature_par=@p, signature_le=@l WHERE id=@id`)
    .run({ s: sig.signature, p: sig.signataire, l: sig.le, id: row.id });

  logEvt(row.id, row.statut, 'Bon modifié et re-signé par l\'administrateur', req.user.username);
  const bon = mapBon(fetchBonRow(row.id));
  emitToSites('bon:maj', { bon });
  emitToDistributeur(row.distributeur_id, 'bon:maj', { bon });
  res.json({ ok: true, bon });
});

// Annulation d'un bon (administrateur uniquement) : conserve l'historique.
r.post('/:id/annuler', (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Seul l\'administrateur peut annuler un bon' });
  const row = bonDeLEspace(req);
  if (!row) return res.status(404).json({ error: 'Bon introuvable' });
  if (['termine', 'annule'].includes(row.statut))
    return res.status(409).json({ error: 'Ce bon ne peut plus être annulé' });
  const motif = (req.body?.motif || '').toString();
  db.prepare(`UPDATE bons_commande SET statut='annule', motif_rejet=@m, updated_at=datetime('now') WHERE id=@id`)
    .run({ m: motif, id: row.id });
  logEvt(row.id, 'annule', motif ? `Bon annulé : ${motif}` : 'Bon annulé par l\'administrateur', req.user.username);
  const bon = mapBon(fetchBonRow(row.id));
  emitToSites('bon:annule', { id: row.id });
  emitToDistributeur(row.distributeur_id, 'bon:maj', { bon });
  res.json({ ok: true, bon });
});

const escH = (x) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Modèle imprimable d'un bon de commande envoyé au pont bascule.
function bonCommandeHtml(b, d) {
  const titre = d?.raison_sociale || d?.nom || 'mGlobal Pont Bascule';
  const logo = d?.logo
    ? `<img src="${escH(d.logo)}" alt="logo" style="max-height:64px;max-width:180px;object-fit:contain">`
    : `<div style="font-size:26px;font-weight:800;color:#0f3d6e">⚖ ${escH(titre)}</div>`;
  const ligneIdent = [d?.adresse, d?.ville].filter(Boolean).join(', ');
  const contact = [d?.telephone && 'Tél : ' + d.telephone, d?.email].filter(Boolean).join('  ·  ');
  const row = (l, v) => `<tr><td class="lbl">${l}</td><td class="val">${escH(v || '—')}</td></tr>`;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Bon ${escH(b.reference)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;background:#eef2f7;}
  .sheet{max-width:780px;margin:22px auto;background:#fff;padding:38px 42px;border-top:6px solid #0f3d6e;box-shadow:0 8px 30px rgba(0,0,0,.1);}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #e5e7eb;padding-bottom:16px;}
  .top .ident{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.5;}
  .doc{text-align:right;}
  .doc .t{font-size:22px;font-weight:800;color:#0f3d6e;letter-spacing:1px;}
  .doc .n{font-size:14px;font-weight:700;margin-top:4px;}
  .doc .d{color:#6b7280;font-size:12px;}
  table{width:100%;border-collapse:collapse;margin-top:20px;}
  td{padding:9px 6px;border-bottom:1px solid #eef2f7;font-size:13px;}
  .lbl{color:#6b7280;width:38%;}.val{font-weight:700;}
  .note{margin-top:18px;padding:12px 14px;background:#f8fafc;border-left:3px solid #0f3d6e;font-size:13px;color:#374151;}
  .sign{display:flex;justify-content:space-between;margin-top:48px;color:#6b7280;font-size:12px;}
  .sign>div{width:42%;border-top:1px solid #cbd5e1;text-align:center;padding-top:8px;}
  .sig-num{margin-top:14px;font-size:11px;color:#9ca3af;word-break:break-all;}
  .foot{text-align:center;color:#9ca3af;font-size:11px;margin-top:24px;}
  @media print{body{background:#fff;}.sheet{box-shadow:none;margin:0;}button{display:none;}}
</style></head><body>
<div class="sheet">
  <div class="top">
    <div>${logo}<div class="ident">${escH(ligneIdent)}<br>${escH(contact)}${d?.ninea ? '<br>NINEA : ' + escH(d.ninea) : ''}${d?.rccm ? '  ·  RCCM : ' + escH(d.rccm) : ''}</div></div>
    <div class="doc"><div class="t">BON DE COMMANDE</div>
      <div class="n">N° ${escH(b.reference)}${b.numero != null ? ' (#' + b.numero + ')' : ''}</div>
      <div class="d">${escH((b.created_at || '').slice(0, 16))}</div>
      <div class="d">Statut : ${escH(b.statut)}</div></div>
  </div>
  <table>
    ${row('Client', b.client)}
    ${row('Produit', b.produit)}
    ${row('Immatriculation', b.immatriculation)}
    ${row('Chauffeur', b.chauffeur)}
    ${row('Destination', b.destination)}
    ${row('Quantité prévue', (b.quantite_prevue || 0) + ' t')}
  </table>
  ${b.note ? `<div class="note"><b>Note :</b> ${escH(b.note)}</div>` : ''}
  <div class="sign"><div>Signature &amp; Cachet</div><div>Signature Chauffeur</div></div>
  ${b.signature ? `<div class="sig-num">🔏 Signature électronique : ${escH(b.signature)} — ${escH(b.signature_par || '')} ${escH(b.signature_le || '')}</div>` : ''}
  <div class="foot">Document généré par la plateforme mGlobal — ${new Date().toLocaleString('fr-FR')}
    <br>© mGlobalTec — Aladji SALL · 771184001 · aladjisall@gmail.com / macb.global@gmail.com · Dakar, Sénégal</div>
  <div style="text-align:center;margin-top:18px"><button onclick="window.print()">🖨 Imprimer</button></div>
</div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 350));</script>
</body></html>`;
}

// Suppression définitive d'un bon (administrateur uniquement).
r.delete('/:id', (req, res) => {
  if (!estAdmin(req)) return res.status(403).json({ error: 'Seul l\'administrateur peut supprimer un bon' });
  const row = bonDeLEspace(req);
  if (!row) return res.status(404).json({ error: 'Bon introuvable' });
  db.prepare(`DELETE FROM bons_commande WHERE id = ?`).run(row.id);
  emitToSites('bon:annule', { id: row.id });
  emitToDistributeur(row.distributeur_id, 'bon:annule', { id: row.id });
  res.json({ ok: true });
});

export default r;
