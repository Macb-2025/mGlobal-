# Guide complet d'hébergement — mGlobal Business

Ce guide explique comment mettre la plateforme **en ligne, accessible partout dans le monde**.
Choisissez **une** des 3 options. La **A** est la plus professionnelle (domaine + HTTPS).

---

## Comparatif rapide

| Option | Pour qui | Coût | URL publique | HTTPS | Difficulté |
|--------|----------|------|--------------|-------|------------|
| **A — VPS + domaine** | Production sérieuse | ~5 €/mois | `https://pesage.tondomaine.com` | Auto (Let's Encrypt) | ★★☆ |
| **B — Railway/Render** | Sans gérer de serveur | gratuit→~5 €/mois | `https://xxx.up.railway.app` | Auto | ★☆☆ |
| **C — Tunnel Cloudflare** | Test immédiat | gratuit | `https://xxx.trycloudflare.com` | Auto | ★☆☆ |

> Recommandation : **A** pour le vrai usage des 2 distributeurs ; **C** pour tester tout de suite.

---

## Pré-requis communs

- Le dossier `cloud/` (fourni dans le zip).
- 3 valeurs à définir **avant la prod** (variables d'environnement) :
  - `JWT_SECRET` : longue chaîne aléatoire (sécurise les sessions). Génère-la :
    ```bash
    openssl rand -hex 48
    ```
  - `SUPERADMIN_USER` / `SUPERADMIN_PASSWORD` : ton compte super-admin mGlobal.

---

## OPTION A — VPS + nom de domaine + HTTPS (recommandé)

### A.1 — Louer un VPS
Chez Hetzner, OVH, DigitalOcean, Contabo… Prends le plus petit (1 vCPU / 2 Go RAM suffit).
Système : **Ubuntu 22.04 ou 24.04**. Note l'**adresse IP publique** du serveur.

### A.2 — Acheter / configurer un nom de domaine
Achète un domaine (OVH, Namecheap, Gandi…) ou utilise un sous-domaine existant.
Dans la zone DNS, crée un enregistrement **A** :

```
Type: A     Nom: pesage     Valeur: <IP_DE_TON_VPS>     TTL: 300
```

→ `pesage.tondomaine.com` pointe maintenant vers ton serveur.

### A.3 — Installer Docker sur le VPS
Connecte-toi en SSH (`ssh root@<IP>`) puis :

```bash
curl -fsSL https://get.docker.com | sh
```

### A.4 — Copier la plateforme et la lancer
Copie le dossier `cloud/` sur le VPS (via `scp` depuis ton PC, ou `git clone`) :

```bash
# depuis ton PC, exemple :
scp -r cloud root@<IP>:/opt/mglobal-cloud
```

Sur le VPS :

```bash
cd /opt/mglobal-cloud
cp .env.example .env
nano .env        # mets JWT_SECRET et SUPERADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f     # note la "CLÉ DE LIAISON" affichée (Ctrl+C pour quitter les logs)
```

La plateforme tourne en interne sur le port 3060. Reste à mettre le HTTPS devant.

### A.5 — Reverse proxy HTTPS automatique (Caddy)
Caddy obtient et renouvelle le certificat Let's Encrypt tout seul.

```bash
sudo apt update && sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Mets exactement ceci (remplace le domaine) :

```
pesage.tondomaine.com {
    reverse_proxy localhost:3060
}
```

```bash
sudo systemctl restart caddy
```

✅ La plateforme est maintenant accessible dans le monde entier sur
**https://pesage.tondomaine.com** (cadenas HTTPS automatique).

### A.6 — Ouvrir le pare-feu (si activé)
```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 22
```

---

## OPTION B — Railway ou Render (sans gérer de serveur)

1. Mets le dossier `cloud/` dans un dépôt Git (GitHub).
2. Sur **Railway** (railway.app) ou **Render** (render.com) : « New Project » → « Deploy from GitHub » → choisis le repo.
3. Le service se construit à partir du **Dockerfile** automatiquement.
4. Ajoute un **volume persistant** monté sur `/data` (sinon la base est perdue à chaque redéploiement).
5. Dans les **Variables d'environnement**, ajoute :
   - `JWT_SECRET` = (ta chaîne aléatoire)
   - `SUPERADMIN_PASSWORD` = (ton mot de passe)
   - `PORT` = `3060`
   - `DATA_DIR` = `/data`
6. Le fournisseur te donne une **URL HTTPS publique** (ex. `https://mglobal-cloud.up.railway.app`).
   La clé de liaison est visible dans les **logs** du service (ou dans la plateforme → Administration).

---

## OPTION C — Tunnel sécurisé Cloudflare (test immédiat, sans serveur)

Sur le PC où tourne la plateforme :

```bash
cd cloud
npm install
npm start            # plateforme locale sur http://localhost:3060
```

Dans un autre terminal :

```bash
# installer cloudflared une seule fois
# (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
cloudflared tunnel --url http://localhost:3060
```

Cloudflare affiche une URL du type `https://xxxx-yyyy.trycloudflare.com` — utilisable
**partout dans le monde** tant que la commande tourne. Idéal pour démontrer ; pour un usage
permanent, passe à l'option A.

---

## APRÈS LA MISE EN LIGNE (les 3 options)

### 1. Première connexion
Ouvre l'URL publique → connecte-toi en super-admin (`SUPERADMIN_USER` / `SUPERADMIN_PASSWORD`).

### 2. Récupérer la clé de liaison
Menu **Administration → Liaison du poste** : copie l'**URL** et la **clé de liaison**.

### 3. Lier le poste mGlobal Pont Bascule
Dans mGlobal → **Paramètres → 🌐 Accès distant → Liaison à la plateforme cloud** :
- URL de la plateforme = ton URL publique (ex. `https://pesage.tondomaine.com`)
- Clé de liaison = celle copiée à l'étape 2
- Clique **🔌 Tester la liaison** → **Enregistrer**.
→ Synchro automatique (pesées, temps réel, impression distante).

### 4. Créer les 2 distributeurs
- Les espaces se créent **automatiquement** dès l'arrivée des premières pesées (selon le champ
  « Distributeur » de chaque entrée). Tu peux aussi les créer dans **Administration → Distributeurs**.
- Dans **Utilisateurs & rôles** : choisis l'espace, crée le compte Admin du distributeur
  (et ses opérateurs/superviseurs). Donne ses identifiants au distributeur.

### 5. Sécurité (à faire en prod)
- [ ] `JWT_SECRET` long et aléatoire
- [ ] mot de passe super-admin fort
- [ ] HTTPS actif (options A/B/C le font automatiquement)
- [ ] sauvegarde régulière de la base (voir ci-dessous)

### 6. Sauvegarde de la base
La donnée est dans le volume Docker `mglobal_data` (`/data/mglobal_cloud.db`).

```bash
docker compose exec mglobal-cloud sh -c "cp /data/mglobal_cloud.db /data/backup-$(date +%F).db"
# puis récupère le fichier hors du serveur :
docker compose cp mglobal-cloud:/data/backup-$(date +%F).db ./
```

### 7. Mise à jour de la plateforme
```bash
cd /opt/mglobal-cloud
git pull            # ou re-copie le dossier cloud/
docker compose up -d --build
```

---

## Dépannage rapide

| Problème | Cause probable | Solution |
|----------|----------------|----------|
| « Connexion impossible » au test de liaison | URL erronée ou plateforme arrêtée | Vérifie l'URL (avec `https://`) et `docker compose ps` |
| Le navigateur affiche « non sécurisé » | HTTPS pas encore actif | Attends la propagation DNS / vérifie le Caddyfile |
| Aucune pesée ne remonte | Mauvaise clé de liaison | Régénère la clé (Administration → Liaison) et recolle-la dans mGlobal |
| Données perdues après redéploiement | Pas de volume persistant | Monte bien un volume sur `/data` |
| Certificat HTTPS non émis | DNS pas propagé / port 80 fermé | Ouvre le port 80, vérifie l'enregistrement A |
