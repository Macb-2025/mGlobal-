import fs from 'fs';
import path from 'path';
import db, { DATA_DIR } from './db.js';

// Pièces jointes de la messagerie (fichiers et messages vocaux).
export const PIECES_DIR = path.resolve(DATA_DIR, 'messagerie');
fs.mkdirSync(PIECES_DIR, { recursive: true });

// Supprime les conversations sans membre (dernier membre parti ou compte supprimé) et leurs fichiers.
export function supprimerConversationsVides() {
  const vides = db.prepare(`SELECT id FROM conversations c
    WHERE NOT EXISTS (SELECT 1 FROM conversation_membres m WHERE m.conversation_id = c.id)`).all();
  for (const { id } of vides) {
    for (const { f } of db.prepare(`SELECT piece_fichier f FROM messages WHERE conversation_id = ? AND piece_fichier IS NOT NULL`).all(id))
      fs.rm(path.join(PIECES_DIR, f), { force: true }, () => {});
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }
}

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
