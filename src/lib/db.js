import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { signerBon } from './signature.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const key = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 24);
export const newKey = () => key();

const db = new Database(path.join(DATA_DIR, 'mglobal_cloud.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom         TEXT NOT NULL,
  site_key    TEXT NOT NULL UNIQUE,
  actif       INTEGER NOT NULL DEFAULT 1,
  last_seen   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS distributeurs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  nom         TEXT NOT NULL,
  actif       INTEGER NOT NULL DEFAULT 1, -- 0 = désactivé par le super-admin
  gele        INTEGER NOT NULL DEFAULT 0, -- 1 = blocage total (gelé) par le super-admin
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER REFERENCES distributeurs(id) ON DELETE CASCADE,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'operateur', -- superadmin|admin|superviseur|operateur
  actif           INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sorties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL,
  numero_ticket   TEXT,
  immatriculation TEXT,
  chauffeur       TEXT,
  client          TEXT,
  produit         TEXT,
  poids_entree    REAL DEFAULT 0,
  poids_sortie    REAL DEFAULT 0,
  poids_net       REAL DEFAULT 0,
  prix_unitaire   REAL DEFAULT 0,
  montant_total   REAL DEFAULT 0,
  date_sortie     TEXT,
  operateur       TEXT,
  destination     TEXT,
  numero_bon      TEXT,
  type_transaction TEXT,
  imprime         INTEGER DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(distributeur_id, source_id)
);

CREATE TABLE IF NOT EXISTS entrees (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL,
  numero_ticket   TEXT,
  immatriculation TEXT,
  chauffeur       TEXT,
  client          TEXT,
  produit         TEXT,
  poids_entree    REAL DEFAULT 0,
  date_entree     TEXT,
  operateur       TEXT,
  origine         TEXT,
  distributeur    TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(distributeur_id, source_id)
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL,
  numero_ticket   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|done|failed
  requested_by    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  done_at         TEXT
);

CREATE TABLE IF NOT EXISTS live (
  site_id   INTEGER PRIMARY KEY,
  site_nom  TEXT,
  connected INTEGER DEFAULT 0,
  stable    INTEGER DEFAULT 0,
  kg        REAL DEFAULT 0,
  valeur    REAL DEFAULT 0,
  unite     TEXT DEFAULT 't',
  ts        TEXT
);

-- Bons de commande / ordres de pesage créés sur la plateforme par un distributeur
-- puis envoyés au pont bascule pour validation et pesage. Suivi d'avancement par statut.
CREATE TABLE IF NOT EXISTS bons_commande (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id  INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  reference        TEXT,
  client           TEXT,
  produit          TEXT,
  immatriculation  TEXT,
  chauffeur        TEXT,
  destination      TEXT,
  quantite_prevue  REAL DEFAULT 0,
  note             TEXT,
  numero           INTEGER,            -- numéro séquentiel du bon, par distributeur
  signature        TEXT,               -- signature électronique (empreinte vérifiable)
  signature_par    TEXT,               -- signataire
  signature_le     TEXT,               -- horodatage de signature
  -- en_attente|recu|en_cours|pese|termine|rejete|annule
  statut           TEXT NOT NULL DEFAULT 'en_attente',
  cree_par         TEXT,
  recu_le          TEXT,
  traite_le        TEXT,
  poids_net        REAL,
  numero_ticket    TEXT,
  operateur        TEXT,
  motif_rejet      TEXT,
  source_sortie_id INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bc_statut ON bons_commande(statut);
CREATE INDEX IF NOT EXISTS idx_bc_dist   ON bons_commande(distributeur_id);

-- Historique d'avancement (timeline) pour le suivi détaillé d'un bon
CREATE TABLE IF NOT EXISTS bons_commande_evts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bon_id      INTEGER NOT NULL REFERENCES bons_commande(id) ON DELETE CASCADE,
  statut      TEXT NOT NULL,
  detail      TEXT,
  par         TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════════════════
--  MODULES MÉTIER (isolés par distributeur) :
--  fournisseurs, produits/stock, clients, facturation, comptabilité,
--  gestion du relicat, ventes en gros & enlèvements fractionnés.
-- ════════════════════════════════════════════════════════════════════════

-- Fournisseurs d'un distributeur. Chaque fournisseur possède un « code » qui lui
-- ouvre son espace privé (portail fournisseur) en consultation.
CREATE TABLE IF NOT EXISTS fournisseurs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  code            TEXT NOT NULL UNIQUE,        -- code d'accès au portail fournisseur
  nom             TEXT NOT NULL,
  telephone       TEXT,
  adresse         TEXT,
  solde_dette     REAL NOT NULL DEFAULT 0,     -- montant que le distributeur doit au fournisseur
  actif           INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_four_dist ON fournisseurs(distributeur_id);

-- Catalogue produits & stock d'un distributeur.
CREATE TABLE IF NOT EXISTS produits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  nom             TEXT NOT NULL,
  description     TEXT,
  unite           TEXT NOT NULL DEFAULT 't',
  stock_actuel    REAL NOT NULL DEFAULT 0,
  stock_alerte    REAL NOT NULL DEFAULT 10,
  prix_achat      REAL NOT NULL DEFAULT 0,
  prix_vente_gros REAL NOT NULL DEFAULT 0,
  fournisseur_id  INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prod_dist ON produits(distributeur_id);

-- Carnet clients d'un distributeur (avec immatriculation = code portail client,
-- solde de relicat disponible et solde de dette).
CREATE TABLE IF NOT EXISTS clients (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  immatriculation TEXT NOT NULL UNIQUE,        -- code d'accès au portail client
  nom             TEXT NOT NULL,
  telephone       TEXT,
  adresse         TEXT,
  solde_relicat   REAL NOT NULL DEFAULT 0,     -- acompte / trop-perçu disponible
  solde_dette     REAL NOT NULL DEFAULT 0,     -- reste à payer cumulé
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cli_dist ON clients(distributeur_id);

-- Factures émises par un distributeur. « relicat » = montant_total - montant_paye
-- (>0 : reste à payer / dette ; <0 : trop-perçu reversé en relicat client).
CREATE TABLE IF NOT EXISTS factures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  numero          TEXT,
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  date            TEXT NOT NULL DEFAULT (datetime('now')),
  montant_total   REAL NOT NULL DEFAULT 0,
  montant_paye    REAL NOT NULL DEFAULT 0,
  relicat         REAL NOT NULL DEFAULT 0,
  note            TEXT,
  cree_par        TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_dist ON factures(distributeur_id);

-- Lignes de facture (articles facturés). Permet une facturation conforme :
-- détail par article avec quantité, prix unitaire HT, taux de TVA et totaux.
CREATE TABLE IF NOT EXISTS facture_lignes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  facture_id    INTEGER NOT NULL REFERENCES factures(id) ON DELETE CASCADE,
  produit_id    INTEGER REFERENCES produits(id) ON DELETE SET NULL,
  designation   TEXT NOT NULL,
  quantite      REAL NOT NULL DEFAULT 0,
  unite         TEXT,
  prix_unitaire REAL NOT NULL DEFAULT 0,   -- prix unitaire HT
  remise        REAL NOT NULL DEFAULT 0,   -- remise en % sur la ligne
  tva           REAL NOT NULL DEFAULT 0,   -- taux de TVA en %
  montant_ht    REAL NOT NULL DEFAULT 0,
  montant_tva   REAL NOT NULL DEFAULT 0,
  montant_ttc   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fl_fact ON facture_lignes(facture_id);

-- Journal de comptabilité (entrées/sorties de caisse) d'un distributeur.
CREATE TABLE IF NOT EXISTS comptabilite (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK(type IN ('ENTREE','SORTIE')),
  categorie       TEXT,
  montant         REAL NOT NULL DEFAULT 0,
  date            TEXT NOT NULL DEFAULT (datetime('now')),
  description     TEXT,
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  fournisseur_id  INTEGER REFERENCES fournisseurs(id) ON DELETE SET NULL,
  facture_id      INTEGER REFERENCES factures(id) ON DELETE SET NULL,
  cree_par        TEXT
);
CREATE INDEX IF NOT EXISTS idx_compta_dist ON comptabilite(distributeur_id);

-- Ventes en gros (compte de marchandise prépayée) suivies par enlèvements fractionnés.
CREATE TABLE IF NOT EXISTS commandes_gros (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id   INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  entite_type       TEXT NOT NULL CHECK(entite_type IN ('CLIENT','DISTRIBUTEUR')),
  entite_id         INTEGER NOT NULL,
  produit_id        INTEGER REFERENCES produits(id) ON DELETE SET NULL,
  quantite_totale   REAL NOT NULL DEFAULT 0,
  quantite_restante REAL NOT NULL DEFAULT 0,
  prix_unitaire     REAL NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cg_dist ON commandes_gros(distributeur_id);

-- Chaque enlèvement (relicat de marchandise) déduit la quantité restante du gros.
CREATE TABLE IF NOT EXISTS enlevements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id  INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  commande_gros_id INTEGER NOT NULL REFERENCES commandes_gros(id) ON DELETE CASCADE,
  quantite_enlevee REAL NOT NULL DEFAULT 0,
  date             TEXT NOT NULL DEFAULT (datetime('now')),
  operateur        TEXT
);
CREATE INDEX IF NOT EXISTS idx_enl_dist ON enlevements(distributeur_id);

-- Journal des mouvements de stock : chaque entrée (achat) ou sortie (vente) est
-- tracée et reliée à une écriture comptable (entrée=dépense, sortie=revenu).
CREATE TABLE IF NOT EXISTS mouvements_stock (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributeur_id INTEGER NOT NULL REFERENCES distributeurs(id) ON DELETE CASCADE,
  produit_id      INTEGER REFERENCES produits(id) ON DELETE SET NULL,
  sens            TEXT NOT NULL CHECK(sens IN ('IN','OUT')),
  quantite        REAL NOT NULL DEFAULT 0,
  prix_unitaire   REAL NOT NULL DEFAULT 0,
  montant         REAL NOT NULL DEFAULT 0,
  motif           TEXT,
  reference       TEXT,
  date            TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mvt_dist ON mouvements_stock(distributeur_id);
CREATE INDEX IF NOT EXISTS idx_mvt_prod ON mouvements_stock(produit_id);

-- Licences anti-clonage : chaque site peut recevoir une licence liée à un
-- identifiant matériel unique (hardware_id) empêchant la copie du logiciel.
CREATE TABLE IF NOT EXISTS licences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  license_key     TEXT NOT NULL UNIQUE,
  hardware_id     TEXT,                          -- empreinte matérielle du poste
  status          TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|EXPIRED|REVOKED
  expires_at      TEXT,                          -- date d'expiration (NULL = illimitée)
  activated_at    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lic_site ON licences(site_id);

-- Mises à jour OTA (over-the-air) pour les postes pont bascule.
CREATE TABLE IF NOT EXISTS ota_updates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version         TEXT NOT NULL,
  filename        TEXT,
  url             TEXT,
  changelog       TEXT,
  mandatory       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Compatibilité : l'ancienne live single-row est remplacée par multi-pont.
-- Les données live sont créées/mises à jour dynamiquement par l'ingestion.
`);

// ── Migrations légères : ajoute les colonnes manquantes aux bases existantes ──
function addColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migration] ${table}.${col} ajouté`);
  }
}
// Migration : convertir l'ancienne table live (single-row id=1) vers multi-pont (site_id).
try {
  const liveCols = db.prepare(`PRAGMA table_info(live)`).all();
  if (liveCols.some(c => c.name === 'id') && !liveCols.some(c => c.name === 'site_id')) {
    db.exec(`DROP TABLE IF EXISTS live`);
    db.exec(`CREATE TABLE live (
      site_id INTEGER PRIMARY KEY, site_nom TEXT,
      connected INTEGER DEFAULT 0, stable INTEGER DEFAULT 0,
      kg REAL DEFAULT 0, valeur REAL DEFAULT 0, unite TEXT DEFAULT 't', ts TEXT
    )`);
    console.log('[migration] Table live migrée vers multi-pont');
  }
} catch {}

addColumn('distributeurs', 'gele', 'gele INTEGER NOT NULL DEFAULT 0');

// Multi-pont bascule : lier chaque site à un distributeur.
addColumn('sites', 'distributeur_id', 'distributeur_id INTEGER REFERENCES distributeurs(id) ON DELETE SET NULL');

// Traçabilité pont : quel pont a traité chaque pesée.
addColumn('sorties', 'site_id', 'site_id INTEGER');
addColumn('sorties', 'site_nom', 'site_nom TEXT');
addColumn('entrees', 'site_id', 'site_id INTEGER');
addColumn('entrees', 'site_nom', 'site_nom TEXT');
addColumn('bons_commande', 'site_id', 'site_id INTEGER');
addColumn('bons_commande', 'site_nom', 'site_nom TEXT');
// Compte fournisseur (rôle 'fournisseur') rattaché à une entité fournisseur.
addColumn('users', 'fournisseur_id', 'fournisseur_id INTEGER REFERENCES fournisseurs(id) ON DELETE CASCADE');
addColumn('bons_commande', 'numero', 'numero INTEGER');
addColumn('bons_commande', 'signature', 'signature TEXT');
addColumn('bons_commande', 'signature_par', 'signature_par TEXT');
addColumn('bons_commande', 'signature_le', 'signature_le TEXT');

// Identité légale du distributeur (en-tête de facture & mentions obligatoires).
addColumn('distributeurs', 'raison_sociale', 'raison_sociale TEXT');
addColumn('distributeurs', 'adresse',  'adresse TEXT');
addColumn('distributeurs', 'ville',    'ville TEXT');
addColumn('distributeurs', 'telephone','telephone TEXT');
addColumn('distributeurs', 'email',    'email TEXT');
addColumn('distributeurs', 'ninea',    'ninea TEXT');
addColumn('distributeurs', 'rccm',     'rccm TEXT');
addColumn('distributeurs', 'devise',   "devise TEXT NOT NULL DEFAULT 'FCFA'");
addColumn('distributeurs', 'tva_defaut','tva_defaut REAL NOT NULL DEFAULT 18');
addColumn('distributeurs', 'pied_facture', 'pied_facture TEXT');
addColumn('distributeurs', 'logo', 'logo TEXT'); // chemin du logo (impression factures/bons)

// Mot de passe journalier pour accès offline (secret par distributeur).
addColumn('distributeurs', 'daily_password_secret', "daily_password_secret TEXT");

// Vente en gros : facture générée automatiquement à l'achat (lien + état facturé).
addColumn('commandes_gros', 'facture_id', 'facture_id INTEGER');
addColumn('commandes_gros', 'facture_numero', 'facture_numero TEXT');

// Enlèvement gros : bon d'enlèvement imprimable attribué à chaque retrait.
addColumn('enlevements', 'bon_id', 'bon_id INTEGER');
addColumn('enlevements', 'bon_numero', 'bon_numero TEXT');

// Catalogue : prix de vente HT + taux de TVA + référence article.
addColumn('produits', 'reference',  'reference TEXT');
addColumn('produits', 'prix_vente', 'prix_vente REAL NOT NULL DEFAULT 0');
addColumn('produits', 'tva',        'tva REAL NOT NULL DEFAULT 18');

// Facturation conforme : montants HT/TVA/TTC, échéance, statut, lien au bon.
addColumn('factures', 'numero_bon',  'numero_bon TEXT');
addColumn('factures', 'client_nom',  'client_nom TEXT');
addColumn('factures', 'montant_ht',  'montant_ht REAL NOT NULL DEFAULT 0');
addColumn('factures', 'montant_tva', 'montant_tva REAL NOT NULL DEFAULT 0');
addColumn('factures', 'remise_globale', 'remise_globale REAL NOT NULL DEFAULT 0');
addColumn('factures', 'echeance',    'echeance TEXT');
addColumn('factures', 'statut',      "statut TEXT NOT NULL DEFAULT 'emise'");
addColumn('factures', 'mode_paiement','mode_paiement TEXT');

// Reprise des bons existants : numérotation séquentielle (par distributeur) +
// signature électronique, pour que les anciens bons soient eux aussi conformes.
backfillBons();
function backfillBons() {
  const aTraiter = db.prepare(`SELECT * FROM bons_commande WHERE numero IS NULL OR signature IS NULL`).all();
  if (!aTraiter.length) return;
  const compteurs = {};
  const maxNum = db.prepare(`SELECT distributeur_id did, COALESCE(MAX(numero),0) m
                             FROM bons_commande WHERE numero IS NOT NULL GROUP BY distributeur_id`).all();
  for (const r of maxNum) compteurs[r.did] = r.m;
  const setNum = db.prepare(`UPDATE bons_commande SET numero=@numero WHERE id=@id`);
  const setSig = db.prepare(`UPDATE bons_commande SET signature=@s, signature_par=@p, signature_le=@l WHERE id=@id`);
  const ordered = db.prepare(`SELECT * FROM bons_commande
                              WHERE numero IS NULL OR signature IS NULL
                              ORDER BY distributeur_id, id`).all();
  const tx = db.transaction(() => {
    for (const b of ordered) {
      if (b.numero == null) {
        compteurs[b.distributeur_id] = (compteurs[b.distributeur_id] || 0) + 1;
        b.numero = compteurs[b.distributeur_id];
        setNum.run({ numero: b.numero, id: b.id });
      }
      if (!b.signature) {
        const sig = signerBon(b, b.cree_par || 'systeme');
        setSig.run({ s: sig.signature, p: sig.signataire, l: sig.le, id: b.id });
      }
    }
  });
  tx();
  console.log(`[migration] ${ordered.length} bon(s) repris (numéro + signature)`);
}

// ── Amorçage : super-admin mGlobal + site par défaut ──
function seed() {
  // Garantit que le super-admin existe TOUJOURS. À la création, on applique le mot
  // de passe par défaut. Sur une base existante on ne touche PLUS au mot de passe
  // (le super-admin peut le modifier dans l'app), SAUF si SUPERADMIN_PASSWORD est
  // explicitement défini en variable d'environnement (réinitialisation volontaire).
  const user = process.env.SUPERADMIN_USER || 'mGlobal';
  const pass = process.env.SUPERADMIN_PASSWORD || 'mGlobal2026';
  const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(user);
  if (!existing) {
    db.prepare(`INSERT INTO users (distributeur_id, username, password_hash, full_name, role)
                VALUES (NULL, ?, ?, ?, 'superadmin')`)
      .run(user, bcrypt.hashSync(pass, 10), 'Administrateur mGlobal');
    console.log(`[seed] Super-admin créé : ${user} / ${pass}`);
  } else if (process.env.SUPERADMIN_PASSWORD) {
    db.prepare(`UPDATE users SET role='superadmin', distributeur_id=NULL, actif=1,
                password_hash=? WHERE id=?`).run(bcrypt.hashSync(pass, 10), existing.id);
    console.log(`[seed] Super-admin ${user} : mot de passe réinitialisé via SUPERADMIN_PASSWORD`);
  } else {
    db.prepare(`UPDATE users SET role='superadmin', distributeur_id=NULL, actif=1 WHERE id=?`).run(existing.id);
    console.log(`[seed] Super-admin ${user} vérifié`);
  }
  const siteExists = db.prepare(`SELECT COUNT(*) n FROM sites`).get().n;
  if (!siteExists) {
    const sk = process.env.SITE_KEY || newKey();
    db.prepare(`INSERT INTO sites (nom, site_key) VALUES (?, ?)`).run('Pont Bascule Principal', sk);
    console.log(`[seed] Site créé. CLÉ DE LIAISON (à coller dans mGlobal) : ${sk}`);
  }
  // Licence par défaut pour chaque site qui n'en a pas encore.
  const sitesWithoutLicense = db.prepare(`SELECT s.id FROM sites s
    LEFT JOIN licences l ON l.site_id = s.id WHERE l.id IS NULL`).all();
  for (const s of sitesWithoutLicense) {
    const lk = 'LIC-' + newKey();
    db.prepare(`INSERT INTO licences (site_id, license_key, status) VALUES (?, ?, 'ACTIVE')`)
      .run(s.id, lk);
    console.log(`[seed] Licence créée pour site #${s.id} : ${lk}`);
  }
}
seed();

export default db;
