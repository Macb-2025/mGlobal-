# mGlobal Business — Plateforme multi-boutiques de gestion commerciale

Plateforme web **multi-tenant** pour mGlobal Pont Bascule, accessible **partout dans le monde**.
Chaque distributeur dispose de son **espace privé isolé** (ses bons, ses clients, ses rapports,
ses utilisateurs et rôles). Un **dashboard mGlobal commun** agrège les chiffres de tous les
distributeurs. Le poste pont bascule se **lie automatiquement** à la plateforme par une
connexion **sortante** (aucun port à ouvrir sur la box du site).

---

## 1. Principe de fonctionnement

```
   [ Poste mGlobal Pont Bascule ]                 [ Plateforme cloud (ce projet) ]
   - pèse les camions                              - reçoit et stocke les pesées
   - pousse les pesées + poids live   ───POST───►  - range chaque pesée dans l'espace
     (connexion SORTANTE, clé de liaison)            du bon distributeur (auto)
   - récupère les demandes d'impression ◄──GET───  - file d'impression par espace
                                                   - dashboard commun + espaces isolés
                                                          ▲
                  Distributeur A ───navigateur───────────┤  (ne voit QUE l'espace A)
                  Distributeur B ───navigateur───────────┘  (ne voit QUE l'espace B)
```

- **Aucune redirection de port** : c'est le poste qui appelle la plateforme, pas l'inverse.
- **Isolation totale** : chaque requête est filtrée par `distributeur_id` (issu du jeton JWT).
- **Auto-liaison** : un nouveau distributeur saisi dans mGlobal crée automatiquement son
  espace sur la plateforme.

---

## 2. Démarrage rapide (local, pour tester)

Pré-requis : Node.js ≥ 18.

```bash
cd cloud
npm install
npm start
```

Au premier démarrage, la console affiche :

```
[seed] Super-admin créé : mGlobal / mGlobal2026
[seed] Site créé. CLÉ DE LIAISON (à coller dans mGlobal) : XXXXXXXXXXXX
```

Ouvrez ensuite **http://localhost:3060** et connectez-vous avec `mGlobal / mGlobal2026`.

---

## 3. Démarrage avec Docker (recommandé pour la production)

```bash
cd cloud
cp .env.example .env        # puis personnalisez JWT_SECRET et SUPERADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f      # pour voir la clé de liaison générée
```

La base de données est persistée dans le volume Docker `mglobal_data` (survit aux redémarrages).

---

## 4. Rendre la plateforme accessible dans le monde entier

Choisissez **une** des options ci-dessous.

### Option A — VPS + nom de domaine + HTTPS (le plus professionnel)

1. Louez un petit VPS (Hetzner, OVH, DigitalOcean… ~5 €/mois) sous Ubuntu.
2. Pointez un nom de domaine (ex. `pesage.mondomaine.com`) vers l'IP du VPS (enregistrement DNS `A`).
3. Installez Docker, copiez ce dossier `cloud/`, lancez `docker compose up -d --build`.
4. Mettez un **reverse proxy HTTPS** devant. Le plus simple est **Caddy** (certificat Let's Encrypt
   automatique). Exemple de `Caddyfile` :

   ```
   pesage.mondomaine.com {
       reverse_proxy localhost:3060
   }
   ```

   ```bash
   sudo apt install -y caddy
   sudo nano /etc/caddy/Caddyfile   # collez le bloc ci-dessus
   sudo systemctl restart caddy
   ```

   → La plateforme est accessible sur **https://pesage.mondomaine.com** (HTTPS automatique).

### Option B — Plateforme « clic-bouton » (Railway / Render)

- Poussez ce dossier sur un dépôt Git, créez un service à partir du `Dockerfile`.
- Ajoutez un **volume persistant** monté sur `/data`.
- Renseignez les variables d'environnement (`JWT_SECRET`, `SUPERADMIN_PASSWORD`).
- Le fournisseur vous donne une URL HTTPS publique.

### Option C — Tunnel sécurisé (test immédiat, sans serveur)

```bash
npm start                                  # plateforme locale sur :3060
cloudflared tunnel --url http://localhost:3060
```

Cloudflare renvoie une URL publique `https://xxxx.trycloudflare.com` utilisable partout
dans le monde. Idéal pour tester ; pour la production, préférez l'option A.

---

## 5. Lier le poste pont bascule (auto-configuration)

Dans **mGlobal Pont Bascule** → **Paramètres → 🌐 Accès distant → Liaison à la plateforme cloud** :

1. **URL de la plateforme** : l'adresse publique (ex. `https://pesage.mondomaine.com`).
2. **Clé de liaison** : copiée depuis la plateforme (menu **Administration → Liaison du poste**).
3. Cliquez **🔌 Tester la liaison** → message de succès, puis **Enregistrer**.

À partir de là, mGlobal **synchronise automatiquement** les pesées, le poids en temps réel,
et exécute les demandes d'impression reçues. Rien d'autre à configurer.

---

## 6. Mettre en place les 2 distributeurs

1. Connectez-vous en **super-admin** (`mGlobal` / `mGlobal2026`).
2. Les espaces distributeurs apparaissent **automatiquement** dès que des pesées arrivent
   (selon le champ « Distributeur » de chaque entrée dans mGlobal). Vous pouvez aussi les
   créer à la main dans **Administration → Distributeurs**.
3. Dans **Utilisateurs & rôles**, choisissez l'espace puis créez les comptes :
   - **Administrateur** : gère son espace + ses utilisateurs/rôles.
   - **Superviseur** : consultation + rapports.
   - **Opérateur** : consultation des bons.
4. Donnez à chaque distributeur son identifiant. Il se connecte → il ne voit **que son espace**,
   plus le **dashboard mGlobal commun**.

---

## 7. Rôles & permissions

| Rôle          | Portée            | Peut faire                                                      |
|---------------|-------------------|----------------------------------------------------------------|
| `superadmin`  | Global mGlobal    | Dashboard global, gérer distributeurs, sites, tous les comptes  |
| `admin`       | Son distributeur  | Gérer ses utilisateurs/rôles, voir/imprimer ses bons & rapports |
| `superviseur` | Son distributeur  | Voir bons, clients, rapports                                    |
| `operateur`   | Son distributeur  | Voir les bons                                                   |

Tout le monde voit le **dashboard mGlobal commun** (chiffres globaux + poids temps réel).

---

## 8. Référence API (résumé)

Authentification utilisateur : en-tête `Authorization: Bearer <jwt>`.
Authentification du poste : en-tête `X-Site-Key: <clé de liaison>`.

| Méthode | Endpoint                              | Auth     | Description                          |
|---------|---------------------------------------|----------|--------------------------------------|
| POST    | `/api/auth/login`                     | —        | Connexion → jeton JWT                |
| GET     | `/api/auth/me`                        | JWT      | Profil courant                       |
| GET     | `/api/dashboard/global`               | JWT      | Dashboard mGlobal commun             |
| GET     | `/api/dashboard/live`                 | JWT      | Poids temps réel                     |
| GET     | `/api/sorties` `?from&to`             | JWT      | Bons de l'espace (isolé)             |
| GET     | `/api/clients-suivi`                  | JWT      | Suivi clients agrégé (pesées)        |
| GET     | `/api/stats` `?date`                  | JWT      | Rapport du jour de l'espace          |
| GET     | `/api/bon` `?id`                      | JWT      | Bon imprimable (HTML)                |
| POST    | `/api/bons`                           | JWT      | Envoyer un bon à l'impression distante |
| GET/POST/PATCH/DELETE | `/api/admin/users`      | JWT      | Gestion des utilisateurs/rôles       |
| GET/POST| `/api/admin/distributeurs`            | superadmin | Espaces distributeurs              |
| GET     | `/api/admin/sites`                    | superadmin | Sites + clés de liaison            |
| POST    | `/api/ingest/sorties`                 | Site key | Synchro des pesées (poste → cloud)   |
| POST    | `/api/ingest/entrees`                 | Site key | Synchro des entrées                  |
| POST    | `/api/ingest/live`                    | Site key | Poids temps réel                     |
| GET     | `/api/ingest/printjobs`               | Site key | File d'impression à exécuter         |
| POST    | `/api/ingest/printjobs/:id/ack`       | Site key | Accusé d'impression                  |

### Modules de gestion (isolés par distributeur, auth JWT)

| Méthode | Endpoint                                   | Description                                   |
|---------|--------------------------------------------|-----------------------------------------------|
| GET/POST/PUT/DELETE | `/api/clients`                 | Carnet clients (code portail auto-généré)     |
| GET/POST/PUT/DELETE | `/api/fournisseurs`            | Fournisseurs (code espace auto-généré)        |
| POST    | `/api/fournisseurs/:id/reglement`          | Règlement d'une dette fournisseur             |
| GET/POST/PUT/DELETE | `/api/produits`                | Catalogue & stock                             |
| POST    | `/api/produits/:id/approvisionner`         | Entrée de stock + dette fournisseur + compta  |
| GET     | `/api/stocks/alertes`                      | Produits sous le seuil d'alerte               |
| GET/POST| `/api/factures`                            | Facturation (dette/relicat automatiques)      |
| GET     | `/api/factures/:id/imprimer`               | Facture imprimable (HTML)                     |
| GET     | `/api/relicat`                             | Clients avec dette ou relicat                 |
| POST    | `/api/relicat/reglement`                   | Encaisser un règlement (solde dette + relicat)|
| GET/POST| `/api/comptabilite`                        | Journal de caisse + écriture manuelle         |
| GET     | `/api/comptabilite/resume` `?from&to`      | Bilan entrées/sorties/solde                    |
| GET/POST| `/api/commandes-gros`                      | Comptes de vente en gros (prépayé)            |
| GET/POST| `/api/enlevements`                         | Enlèvements fractionnés (déduit du stock)     |
| POST    | `/api/portail-public/connexion`            | Espace client public (code immatriculation)   |
| POST    | `/api/portail-fournisseur/connexion`       | Espace fournisseur public (code fournisseur)  |

Interfaces publiques : `/portail.html` (client) et `/portail-fournisseur.html` (fournisseur).

---

## 9. Sécurité (production)

- **Changez** `JWT_SECRET` et `SUPERADMIN_PASSWORD` (variables d'environnement).
- Servez **toujours en HTTPS** (option A/B le font automatiquement).
- Les mots de passe sont hachés (bcrypt). Les clés de liaison sont régénérables
  (Administration → Liaison du poste → Régénérer).
- Les requêtes inter-espaces sont **impossibles** : chaque utilisateur est cloisonné à son
  `distributeur_id`.

---

## 10. Sauvegarde

Toute la donnée est dans le fichier SQLite `data/mglobal_cloud.db` (ou le volume Docker
`mglobal_data`). Sauvegardez ce fichier régulièrement :

```bash
docker compose exec mglobal-cloud sh -c "cp /data/mglobal_cloud.db /data/backup-$(date +%F).db"
```
