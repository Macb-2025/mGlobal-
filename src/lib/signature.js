import crypto from 'crypto';

// Secret de signature : dérivé du JWT_SECRET (ou variable dédiée), persistant.
const SIGN_SECRET = process.env.SIGN_SECRET || process.env.JWT_SECRET || 'mglobal-sign-secret-change-me';

// Signature électronique d'un bon : empreinte HMAC-SHA256 sur les champs clés.
// Vérifiable a posteriori (recalcul) → garantit l'intégrité et l'auteur du bon.
export function signerBon(bon, signataire) {
  const le = new Date().toISOString();
  const payload = [
    bon.id, bon.numero, bon.distributeur_id, bon.reference,
    bon.client || '', bon.produit || '', bon.immatriculation || '',
    bon.chauffeur || '', bon.destination || '', Number(bon.quantite_prevue || 0),
    bon.cree_par || '', signataire || '', le
  ].join('|');
  const signature = crypto.createHmac('sha256', SIGN_SECRET).update(payload).digest('hex').toUpperCase();
  return { signature, signataire: signataire || '', le };
}

// Recalcule la signature pour vérification d'intégrité.
export function verifierBon(bon) {
  if (!bon.signature || !bon.signature_le) return false;
  const payload = [
    bon.id, bon.numero, bon.distributeur_id, bon.reference,
    bon.client || '', bon.produit || '', bon.immatriculation || '',
    bon.chauffeur || '', bon.destination || '', Number(bon.quantite_prevue || 0),
    bon.cree_par || '', bon.signature_par || '', bon.signature_le
  ].join('|');
  const calc = crypto.createHmac('sha256', SIGN_SECRET).update(payload).digest('hex').toUpperCase();
  return calc === bon.signature;
}
