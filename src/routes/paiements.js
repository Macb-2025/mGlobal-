import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, requireRole, requireEspaceActif } from '../lib/auth.js';
import { abonnementResume } from '../lib/abonnement.js';
import { creerPaiementEnAttente, confirmerPaiementAuto, marquerEchec, montantMensuel } from '../lib/paiement.js';
import { getFournisseur, fournisseursDisponibles } from '../lib/gateway.js';

const r = Router();

// URL de base publique (pour construire les liens de retour de la passerelle).
function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ── Webhook fournisseur (PUBLIC, hors authentification) ──
// La passerelle confirme (ou échoue) un paiement → réabonnement + déblocage auto.
r.post('/webhook/:provider', (req, res) => {
  try {
    const fournisseur = getFournisseur(req.params.provider);
    const { token, providerRef, statut } = fournisseur.lireWebhook(req);
    if (statut === 'echoue') { marquerEchec(token); return res.json({ ok: true, statut: 'echoue' }); }
    const r2 = confirmerPaiementAuto(token, providerRef);
    res.json({ ok: true, statut: 'valide', echeance: r2.echeance, dejaValide: r2.dejaValide });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// État d'un paiement par jeton (PUBLIC : la page de paiement interroge sa progression).
r.get('/etat/:token', (req, res) => {
  const pay = db.prepare(`SELECT id, montant, mois, statut, provider, periode_fin FROM paiements WHERE token = ?`).get(req.params.token);
  if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
  res.json(pay);
});

// ── Espace propriétaire (authentifié, NON soumis au blocage d'abonnement : il faut
//    pouvoir payer même quand l'espace est bloqué/lecture seule). ──
r.use(requireAuth, requireRole('proprietaire'), requireEspaceActif);

// Résumé d'abonnement + montant mensuel de référence + moyens de paiement proposés.
r.get('/abonnement', (req, res) => {
  const p = db.prepare(`SELECT * FROM proprietaires WHERE id = ?`).get(req.user.pid);
  if (!p) return res.status(404).json({ error: 'Propriétaire introuvable' });
  res.json({ abonnement: abonnementResume(p), montantMensuel: montantMensuel(p), fournisseurs: fournisseursDisponibles() });
});

// Moyens de paiement disponibles (Wave, Orange Money, Yas…) + état de configuration.
r.get('/fournisseurs', (_req, res) => res.json(fournisseursDisponibles()));

// Historique des paiements du propriétaire.
r.get('/', (req, res) => {
  res.json(db.prepare(`SELECT id, montant, methode, mois, periode_fin, type, statut, provider, provider_ref, reference, created_at
    FROM paiements WHERE proprietaire_id = ? ORDER BY created_at DESC`).all(req.user.pid));
});

// Initie un paiement automatique en ligne : crée la ligne « en attente » puis renvoie
// l'URL de paiement du fournisseur (le réabonnement se fait au retour via webhook).
r.post('/initier', async (req, res) => {
  try {
    const { mois, montant, methode, provider } = req.body || {};
    const fournisseur = getFournisseur(provider);
    const paiement = creerPaiementEnAttente({ proprietaireId: req.user.pid, montant, methode, mois, provider: fournisseur.id });
    const base = baseUrl(req);
    const urls = {
      success: `${base}/pay.html?token=${encodeURIComponent(paiement.token)}`,
      error: `${base}/pay.html?token=${encodeURIComponent(paiement.token)}&echec=1`,
      notif: `${base}/api/paiements/webhook/${fournisseur.id}`
    };
    const { paymentUrl, providerRef } = await fournisseur.initier({ paiement, proprietaire: { id: req.user.pid }, baseUrl: base, urls });
    if (providerRef) db.prepare(`UPDATE paiements SET provider_ref = ? WHERE id = ?`).run(providerRef, paiement.id);
    res.json({ ok: true, paiementId: paiement.id, token: paiement.token, montant: paiement.montant, mois: paiement.mois, provider: fournisseur.id, paymentUrl });
  } catch (e) {
    res.status(e.code === 'provider_non_configure' ? 501 : 400).json({ error: e.message });
  }
});

export default r;
