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
