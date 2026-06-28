import { Router } from 'express';
import db from '../lib/db.js';
import { requireSite } from '../lib/auth.js';
import { emitToSites, emitToDistributeur, emitToAll } from '../lib/realtime.js';

const r = Router();

// Normalise une date ISO (« 2026-06-14T12:47:06 ») en « 2026-06-14 12:47:06 »
// pour que les filtres de plage SQL (BETWEEN) fonctionnent correctement.
function normDate(s) {
  return String(s || '').replace('T', ' ').replace(/\.\d+/, '').trim();
}

// Normalise un nom de distributeur en slug stable
function slugify(nom) {
  return String(nom || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sans-distributeur';
}

// Récupère (ou crée automatiquement) le distributeur correspondant.
// L'auto-création réalise l'« auto-liaison » : un nouveau distributeur dans
// mGlobal apparaît immédiatement comme espace sur la plateforme.
function ensureDistributeur(nom) {
  const slug = slugify(nom);
  let d = db.prepare(`SELECT * FROM distributeurs WHERE slug = ?`).get(slug);
  if (!d) {
    const info = db.prepare(`INSERT INTO distributeurs (slug, nom) VALUES (?, ?)`)
      .run(slug, (nom && String(nom).trim()) || 'Sans distributeur');
    d = db.prepare(`SELECT * FROM distributeurs WHERE id = ?`).get(info.lastInsertRowid);
  }
  return d;
}

const upsertSortie = db.prepare(`
INSERT INTO sorties (distributeur_id, source_id, numero_ticket, immatriculation, chauffeur,
  client, produit, poids_entree, poids_sortie, poids_net, prix_unitaire, montant_total,
  date_sortie, operateur, destination, numero_bon, type_transaction, imprime, site_id, site_nom, updated_at)
VALUES (@distributeur_id, @source_id, @numero_ticket, @immatriculation, @chauffeur,
  @client, @produit, @poids_entree, @poids_sortie, @poids_net, @prix_unitaire, @montant_total,
  @date_sortie, @operateur, @destination, @numero_bon, @type_transaction, @imprime, @site_id, @site_nom, datetime('now'))
ON CONFLICT(distributeur_id, source_id) DO UPDATE SET
  numero_ticket=excluded.numero_ticket, immatriculation=excluded.immatriculation,
  chauffeur=excluded.chauffeur, client=excluded.client, produit=excluded.produit,
  poids_entree=excluded.poids_entree, poids_sortie=excluded.poids_sortie, poids_net=excluded.poids_net,
  prix_unitaire=excluded.prix_unitaire, montant_total=excluded.montant_total,
  date_sortie=excluded.date_sortie, operateur=excluded.operateur, destination=excluded.destination,
  numero_bon=excluded.numero_bon, type_transaction=excluded.type_transaction,
  imprime=excluded.imprime, site_id=excluded.site_id, site_nom=excluded.site_nom, updated_at=datetime('now')
`);

const upsertEntree = db.prepare(`
INSERT INTO entrees (distributeur_id, source_id, numero_ticket, immatriculation, chauffeur,
  client, produit, poids_entree, date_entree, operateur, origine, distributeur, site_id, site_nom, updated_at)
VALUES (@distributeur_id, @source_id, @numero_ticket, @immatriculation, @chauffeur,
  @client, @produit, @poids_entree, @date_entree, @operateur, @origine, @distributeur, @site_id, @site_nom, datetime('now'))
ON CONFLICT(distributeur_id, source_id) DO UPDATE SET
  numero_ticket=excluded.numero_ticket, immatriculation=excluded.immatriculation,
  chauffeur=excluded.chauffeur, client=excluded.client, produit=excluded.produit,
  poids_entree=excluded.poids_entree, date_entree=excluded.date_entree,
  operateur=excluded.operateur, origine=excluded.origine, distributeur=excluded.distributeur,
  site_id=excluded.site_id, site_nom=excluded.site_nom, updated_at=datetime('now')
`);

// Synchro des pesées de sortie (lot)
r.post('/sorties', requireSite, (req, res) => {
  const items = Array.isArray(req.body?.sorties) ? req.body.sorties : [];
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const s of rows) {
      const d = ensureDistributeur(s.distributeur || s.distributeurNom);
      upsertSortie.run({
        distributeur_id: d.id,
        source_id: Number(s.id ?? s.sourceId ?? 0),
        numero_ticket: s.numeroTicket || '',
        immatriculation: s.immatriculation || '',
        chauffeur: s.chauffeur || '',
        client: s.client || '',
        produit: s.produit || '',
        poids_entree: Number(s.poidsEntree || 0),
        poids_sortie: Number(s.poidsSortie || 0),
        poids_net: Number(s.poidsNet || 0),
        prix_unitaire: Number(s.prixUnitaire || 0),
        montant_total: Number(s.montantTotal || 0),
        date_sortie: normDate(s.dateSortie),
        operateur: s.operateur || '',
        destination: s.destination || '',
        numero_bon: s.numeroBon || '',
        type_transaction: s.typeTransaction || '',
        imprime: s.imprime ? 1 : 0,
        site_id: req.site.id,
        site_nom: req.site.nom
      });
      n++;
    }
    return n;
  });
  const n = tx(items);
  res.json({ ok: true, recus: n });
});

// Synchro des entrées (lot)
r.post('/entrees', requireSite, (req, res) => {
  const items = Array.isArray(req.body?.entrees) ? req.body.entrees : [];
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const e of rows) {
      const d = ensureDistributeur(e.distributeur || e.distributeurNom);
      upsertEntree.run({
        distributeur_id: d.id,
        source_id: Number(e.id ?? e.sourceId ?? 0),
        numero_ticket: e.numeroTicket || '',
        immatriculation: e.immatriculation || '',
        chauffeur: e.chauffeur || '',
        client: e.client || '',
        produit: e.produit || '',
        poids_entree: Number(e.poidsEntree || 0),
        date_entree: normDate(e.dateEntree),
        operateur: e.operateur || '',
        origine: e.origine || '',
        distributeur: e.distributeur || '',
        site_id: req.site.id,
        site_nom: req.site.nom
      });
      n++;
    }
    return n;
  });
  const n = tx(items);
  res.json({ ok: true, recus: n });
});

// Poids en temps réel (état de la balance) — multi-pont : chaque site a sa propre ligne.
r.post('/live', requireSite, (req, res) => {
  const l = req.body || {};
  const siteId = req.site.id;
  const siteNom = req.site.nom;
  db.prepare(`INSERT INTO live (site_id, site_nom, connected, stable, kg, valeur, unite, ts)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(site_id) DO UPDATE SET
      site_nom=excluded.site_nom, connected=excluded.connected, stable=excluded.stable,
      kg=excluded.kg, valeur=excluded.valeur, unite=excluded.unite, ts=excluded.ts`)
    .run(siteId, siteNom, l.connected ? 1 : 0, l.stable ? 1 : 0,
         Number(l.kg || 0), Number(l.valeur || 0), l.unite || 't',
         l.ts || new Date().toISOString());
  // Diffusion temps réel avec identification du pont
  emitToAll('live', { live: {
    siteId, siteNom,
    connected: !!l.connected, stable: !!l.stable, kg: Number(l.kg || 0),
    valeur: Number(l.valeur || 0), unite: l.unite || 't', ts: l.ts || new Date().toISOString()
  }});
  res.json({ ok: true });
});

// File d'impression : le poste récupère les bons à imprimer (relais cloud → LQ-350)
r.get('/printjobs', requireSite, (req, res) => {
  const jobs = db.prepare(`
    SELECT pj.id, pj.source_id AS sortieId, pj.numero_ticket AS numeroTicket, d.nom AS distributeur
    FROM print_jobs pj JOIN distributeurs d ON d.id = pj.distributeur_id
    WHERE pj.status = 'pending' ORDER BY pj.created_at LIMIT 50`).all();
  res.json(jobs);
});

// Accusé d'impression
r.post('/printjobs/:id/ack', requireSite, (req, res) => {
  const ok = req.body?.ok !== false;
  db.prepare(`UPDATE print_jobs SET status = ?, done_at = datetime('now') WHERE id = ?`)
    .run(ok ? 'done' : 'failed', Number(req.params.id));
  res.json({ ok: true });
});

/* ─────────── Bons de commande : réception et suivi côté pont bascule ─────────── */

const PROGRESSION = { en_attente: 10, recu: 35, en_cours: 60, pese: 85, termine: 100, rejete: 100 };
const STATUTS = ['en_attente', 'recu', 'en_cours', 'pese', 'termine', 'rejete'];

function mapBon(b) {
  return {
    id: b.id, reference: b.reference, numero: b.numero, distributeurId: b.distributeur_id,
    distributeur: b.distributeur_nom, client: b.client, produit: b.produit,
    immatriculation: b.immatriculation, chauffeur: b.chauffeur, destination: b.destination,
    quantitePrevue: b.quantite_prevue, note: b.note, statut: b.statut,
    progression: PROGRESSION[b.statut] ?? 0, creePar: b.cree_par, recuLe: b.recu_le,
    traiteLe: b.traite_le, poidsNet: b.poids_net, numeroTicket: b.numero_ticket,
    operateur: b.operateur, motifRejet: b.motif_rejet, createdAt: b.created_at, updatedAt: b.updated_at,
    signature: b.signature, signaturePar: b.signature_par, signatureLe: b.signature_le,
    siteId: b.site_id, siteNom: b.site_nom
  };
}
function fetchBon(id) {
  return db.prepare(`SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
                     JOIN distributeurs d ON d.id = bc.distributeur_id WHERE bc.id = ?`).get(id);
}

// Le poste pont bascule récupère la file des bons à traiter (par ordre de réception).
// Par défaut : tous les bons non terminés/refusés (en_attente, recu, en_cours).
r.get('/bons-commande', requireSite, (req, res) => {
  const rows = db.prepare(`
    SELECT bc.*, d.nom AS distributeur_nom FROM bons_commande bc
    JOIN distributeurs d ON d.id = bc.distributeur_id
    WHERE bc.statut IN ('en_attente','recu','en_cours','pese')
    ORDER BY bc.created_at ASC, bc.id ASC LIMIT 200`).all();
  res.json(rows.map(mapBon));
});

// Le poste met à jour le statut d'un bon (reçu / en cours / pesé / terminé / rejeté).
r.post('/bons-commande/:id/statut', requireSite, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const statut = String(b.statut || '');
  if (!STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const row = fetchBon(id);
  if (!row) return res.status(404).json({ error: 'Bon introuvable' });

  const sets = ['statut = @statut', "updated_at = datetime('now')",
    'site_id = @site_id', 'site_nom = @site_nom'];
  const params = { id, statut, site_id: req.site.id, site_nom: req.site.nom };
  if (statut === 'recu' && !row.recu_le) sets.push("recu_le = datetime('now')");
  if (['pese', 'termine'].includes(statut)) sets.push("traite_le = datetime('now')");
  if (b.poidsNet != null)     { sets.push('poids_net = @poids');   params.poids = Number(b.poidsNet); }
  if (b.numeroTicket != null) { sets.push('numero_ticket = @nt');  params.nt = String(b.numeroTicket); }
  if (b.operateur != null)    { sets.push('operateur = @op');      params.op = String(b.operateur); }
  if (b.sourceSortieId != null){ sets.push('source_sortie_id = @ss'); params.ss = Number(b.sourceSortieId); }
  if (statut === 'rejete')    { sets.push('motif_rejet = @mr');    params.mr = String(b.motif || ''); }
  db.prepare(`UPDATE bons_commande SET ${sets.join(', ')} WHERE id = @id`).run(params);

  const detail = b.detail || {
    recu: 'Bon reçu par le pont bascule',
    en_cours: 'Pesage en cours',
    pese: `Pesage effectué${b.poidsNet != null ? ' : ' + Number(b.poidsNet).toFixed(3) + ' t' : ''}`,
    termine: 'Bon validé et terminé',
    rejete: 'Bon rejeté' + (b.motif ? ' : ' + b.motif : '')
  }[statut] || statut;
  db.prepare(`INSERT INTO bons_commande_evts (bon_id, statut, detail, par) VALUES (?, ?, ?, ?)`)
    .run(id, statut, detail, b.operateur || 'pont bascule');

  const bon = mapBon(fetchBon(id));
  emitToDistributeur(row.distributeur_id, 'bon:maj', { bon });   // suivi distributeur
  emitToSites('bon:maj', { bon });                               // autres postes
  res.json({ ok: true, bon });
});

// Auto-configuration (« WPA ») : le poste récupère toute sa configuration de liaison
// en un seul appel (URL cloud, WebSocket, intervalles, endpoints) → zéro réglage manuel.
r.get('/autoconfig', requireSite, (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const base = `${proto}://${host}`;
  const wsBase = base.replace(/^http/, 'ws');
  if (req.query.download) res.set('Content-Disposition', 'attachment; filename="mglobal_cloud.json"');
  res.json({
    app: 'mGlobal Pont Bascule',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    site: { id: req.site.id, nom: req.site.nom },
    cloudUrl: base,
    wsUrl: `${wsBase}/ws?siteKey=${encodeURIComponent(req.site.site_key)}`,
    siteKey: req.site.site_key,
    intervals: { liveMs: 2000, dataMs: 15000, bonsMs: 8000, printJobsMs: 10000 },
    endpoints: {
      health: '/api/health',
      live: '/api/ingest/live',
      sorties: '/api/ingest/sorties',
      entrees: '/api/ingest/entrees',
      bonsCommande: '/api/ingest/bons-commande',
      bonStatut: '/api/ingest/bons-commande/:id/statut',
      printJobs: '/api/ingest/printjobs',
      printAck: '/api/ingest/printjobs/:id/ack'
    }
  });
});

export default r;
