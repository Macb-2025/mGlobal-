// Passerelle de paiement pluggable (Module 8).
// Un fournisseur expose deux opérations :
//   - initier({ paiement, proprietaire, baseUrl }) → { paymentUrl }
//   - lireWebhook(req) → { token, providerRef, statut: 'valide'|'echoue' }
// Le fournisseur actif est choisi par la variable d'env PAIEMENT_PROVIDER
// (par défaut « simulation » : passerelle de démonstration intégrée, sans clé).

export const PROVIDER = process.env.PAIEMENT_PROVIDER || 'simulation';

// Fournisseur de démonstration : redirige vers une page de paiement locale
// (public/pay.html) qui appelle le webhook. Aucune clé requise → utilisable en test.
const simulation = {
  nom: 'simulation',
  initier({ paiement, baseUrl }) {
    return { paymentUrl: `${baseUrl}/pay.html?token=${encodeURIComponent(paiement.token)}` };
  },
  lireWebhook(req) {
    const { token, decision } = req.body || {};
    if (!token) throw new Error('Jeton manquant');
    return { token, providerRef: 'SIMU-' + token.slice(0, 8), statut: decision === 'echec' ? 'echoue' : 'valide' };
  }
};

// Gabarit pour un vrai fournisseur (Wave / PayDunya / CinetPay / Paystack…).
// À compléter avec l'appel API d'initiation et la vérification de signature du webhook
// une fois les identifiants fournis. Tant que les clés ne sont pas configurées, le
// fournisseur refuse proprement l'initiation (501) au lieu d'échouer silencieusement.
function fournisseurExterne(nom, envKeys) {
  return {
    nom,
    initier() {
      const manquantes = envKeys.filter(k => !process.env[k]);
      const e = new Error(`Fournisseur « ${nom} » non configuré : variables manquantes ${manquantes.join(', ')}`);
      e.code = 'provider_non_configure';
      throw e;
    },
    lireWebhook(req) {
      // À implémenter selon la doc du fournisseur (vérification de signature obligatoire).
      const { token, reference, statut } = req.body || {};
      if (!token) throw new Error('Jeton manquant');
      return { token, providerRef: reference || null, statut: statut === 'echoue' ? 'echoue' : 'valide' };
    }
  };
}

const FOURNISSEURS = {
  simulation,
  wave: fournisseurExterne('wave', ['WAVE_API_KEY']),
  paydunya: fournisseurExterne('paydunya', ['PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN']),
  cinetpay: fournisseurExterne('cinetpay', ['CINETPAY_API_KEY', 'CINETPAY_SITE_ID']),
  paystack: fournisseurExterne('paystack', ['PAYSTACK_SECRET_KEY'])
};

export function getFournisseur(nom) {
  return FOURNISSEURS[nom || PROVIDER] || simulation;
}
