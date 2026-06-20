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
