import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { dashboardFournisseur, livraisonFournisseur } from '../lib/fournisseur.js';

// Espace fournisseur authentifié : le compte (identifiant + mot de passe) est créé
// par le super-admin. Le fournisseur se connecte sur la page de connexion normale.
const r = Router();
r.use(requireAuth, requireRole('fournisseur'));

function monFournisseur(req) {
  return db.prepare(`SELECT * FROM fournisseurs WHERE id = ?`).get(req.user.fid);
}

r.get('/', (req, res) => {
  const f = monFournisseur(req);
  if (!f) return res.status(404).json({ error: 'Compte fournisseur introuvable' });
  res.json(dashboardFournisseur(f));
});

r.post('/livraison', (req, res) => {
  const f = monFournisseur(req);
  if (!f) return res.status(404).json({ error: 'Compte fournisseur introuvable' });
  try { res.json(livraisonFournisseur(f, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

export default r;
