import { Router } from 'express';
import db from '../lib/db.js';
import { requireAuth, denySuperadmin, denyFournisseur } from '../lib/auth.js';

const r = Router();

// Poids en temps réel — multi-pont : retourne l'état de tous les ponts.
r.get('/live', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT l.*, s.distributeur_id FROM live l
    LEFT JOIN sites s ON s.id = l.site_id ORDER BY l.site_id`).all();
  const ponts = rows.map(l => ({
    siteId: l.site_id, siteNom: l.site_nom, distributeurId: l.distributeur_id,
    connected: !!l.connected, stable: !!l.stable,
    kg: l.kg, valeur: l.valeur, unite: l.unite, ts: l.ts
  }));
  res.json({ ponts });
});

// Dashboard mGlobal COMMUN (mêmes chiffres globaux pour les distributeurs).
// Interdit au super-admin (pas d'accès aux données des distributeurs).
r.get('/global', requireAuth, denySuperadmin, denyFournisseur, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);

  const jour = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(poids_net),0) t
    FROM sorties WHERE substr(date_sortie,1,10)=?`).get(today);
  const mois = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(poids_net),0) t
    FROM sorties WHERE substr(date_sortie,1,7)=?`).get(month);
  const annee = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(poids_net),0) t
    FROM sorties WHERE substr(date_sortie,1,4)=?`).get(year);

  const parDistributeur = db.prepare(`
    SELECT d.nom AS distributeur, COUNT(*) AS nbBons, ROUND(SUM(s.poids_net),3) AS totalTonnes
    FROM sorties s JOIN distributeurs d ON d.id = s.distributeur_id
    GROUP BY d.id ORDER BY totalTonnes DESC`).all();

  const parMois = db.prepare(`
    SELECT substr(date_sortie,1,7) AS mois, ROUND(SUM(poids_net),3) AS total
    FROM sorties WHERE substr(date_sortie,1,4)=?
    GROUP BY mois ORDER BY mois`).all(year);

  const parPont = db.prepare(`
    SELECT s.site_nom AS pont, COUNT(*) AS nbBons, ROUND(SUM(s.poids_net),3) AS totalTonnes
    FROM sorties s WHERE s.site_nom IS NOT NULL
    GROUP BY s.site_nom ORDER BY totalTonnes DESC`).all();

  res.json({
    jour: { nbCamions: jour.nb, totalTonnes: round(jour.t) },
    mois: { nbCamions: mois.nb, totalTonnes: round(mois.t) },
    annee: { nbCamions: annee.nb, totalTonnes: round(annee.t) },
    parDistributeur, parMois, parPont
  });
});

const round = (v) => Math.round(v * 1000) / 1000;
export default r;
