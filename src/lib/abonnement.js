// Logique d'abonnement (Module 2). La cascade de verrouillage automatique
// (alertes 30→6 j, lecture seule, désactivation) sera ajoutée au Module 6 ;
// ici on calcule l'état effectif de l'abonnement à partir de l'échéance.

// Nombre de jours restants avant l'échéance (négatif = dépassé), null si pas d'échéance.
export function joursRestants(echeance) {
  if (!echeance) return null;
  const fin = new Date(String(echeance) + 'T23:59:59');
  if (isNaN(fin)) return null;
  return Math.ceil((fin - new Date()) / 86400000);
}

// Ajoute n mois à une date (AAAA-MM-JJ) en gérant les fins de mois.
export function ajouterMois(dateStr, n) {
  const base = dateStr ? new Date(String(dateStr) + 'T00:00:00') : new Date();
  const d = isNaN(base) ? new Date() : base;
  const jour = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < jour) d.setDate(0); // déborde → dernier jour du mois précédent
  return d.toISOString().slice(0, 10);
}

// Jours de grâce en lecture seule après l'échéance avant blocage total.
export const JOURS_GRACE = 7;
// Seuil d'alerte avant échéance (calendrier 30 → 6 jours).
export const ALERTE_JOURS = 30;
export const ALERTE_URGENTE_JOURS = 6;

// Politique de verrouillage en cascade (Module 6) déduite de l'abonnement :
//   mode = 'actif' | 'alerte' | 'lecture_seule' | 'bloque'
// - 30→0 j avant l'échéance : alerte (accès complet, bandeau de rappel).
// - échéance dépassée (≤ JOURS_GRACE) : lecture seule (écritures bloquées).
// - au-delà de la grâce ou statut 'suspendu' : blocage total (écran de blocage).
export function politiqueAbonnement(p) {
  const a = abonnementResume(p);
  const jr = a.joursRestants;
  let mode = 'actif';
  if (a.statut === 'suspendu') mode = 'bloque';
  else if (a.statut === 'essai' || jr === null) mode = 'actif';
  else if (jr < -JOURS_GRACE) mode = 'bloque';
  else if (jr < 0) mode = 'lecture_seule';
  else if (jr <= ALERTE_JOURS) mode = 'alerte';
  return {
    ...a, mode, joursGrace: JOURS_GRACE,
    alerteUrgente: mode === 'alerte' && jr <= ALERTE_URGENTE_JOURS,
    ecriture: mode === 'actif' || mode === 'alerte' // false = lecture seule / bloqué
  };
}

// Résumé d'abonnement pour un propriétaire (ligne SQL `proprietaires`).
// statut effectif : suspendu > essai (pas d'échéance) > expire (échéance dépassée) > actif.
export function abonnementResume(p) {
  const jr = joursRestants(p.abonnement_echeance);
  let statut;
  if (p.abonnement_statut === 'suspendu') statut = 'suspendu';
  else if (jr === null) statut = 'essai';
  else if (jr < 0) statut = 'expire';
  else statut = 'actif';
  return {
    montant: p.abonnement_montant || 0,
    echeance: p.abonnement_echeance || null,
    joursRestants: jr,
    statut
  };
}
