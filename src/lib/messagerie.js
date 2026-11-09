import db from './db.js';

// Règles de contact de la messagerie :
//   - le super-admin peut écrire à tout le monde, et tout le monde peut lui écrire (support) ;
//   - les utilisateurs d'un même distributeur (y compris ses fournisseurs) s'écrivent entre eux ;
//   - deux fournisseurs ne peuvent pas s'écrire (confidentialité commerciale).
// Les objets attendus ont la forme { id, role, distributeur_id }.
export function peutContacter(moi, autre) {
  if (!moi || !autre || moi.id === autre.id) return false;
  if (moi.role === 'superadmin' || autre.role === 'superadmin') return true;
  if (!moi.distributeur_id || moi.distributeur_id !== autre.distributeur_id) return false;
  if (moi.role === 'fournisseur' && autre.role === 'fournisseur') return false;
  return true;
}

export const utilisateurActif = (id) => db.prepare(`SELECT id, username, full_name, role, distributeur_id
  FROM users WHERE id = ? AND actif = 1`).get(id);

// Identifiants des membres d'une conversation.
export const membresConversation = (conversationId) =>
  db.prepare(`SELECT user_id FROM conversation_membres WHERE conversation_id = ?`)
    .all(conversationId).map(r => r.user_id);

export const estMembre = (conversationId, userId) =>
  !!db.prepare(`SELECT 1 FROM conversation_membres WHERE conversation_id = ? AND user_id = ?`)
    .get(conversationId, userId);
