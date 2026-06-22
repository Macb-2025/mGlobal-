'use strict';

const S = { token: localStorage.getItem('mg_token') || '', user: null, page: 'dashboard', liveTimer: null };
const $ = (id) => document.getElementById(id);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (n, d = 3) => Number(n || 0).toFixed(d);
const money = (n) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => new Date().toISOString().slice(0, 8) + '01';

function toast(msg, isErr = false) {
  const t = el(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// Fenêtre modale générique (titre + contenu HTML), réutilise le style existant.
function showModal(titre, html) {
  $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="modal"><div class="modal-head"><h3>${esc(titre)}</h3>
      <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body">${html}</div></div></div>`;
}

/* ───────────── Mode hybride offline (PWA) ─────────────
   File d'attente (Outbox) en IndexedDB : les écritures faites hors-ligne sont
   mises en file puis rejouées dès le retour du réseau (Background Sync ou
   événement « online »). Les lectures s'appuient sur le cache du service worker. */
const OFFLINE_DB = 'mglobal-offline', OUTBOX = 'outbox';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(OFFLINE_DB, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(OUTBOX)) rq.result.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true }); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function idbReq(store, mode, fn) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  }));
}
const outboxAdd = (item) => idbReq(OUTBOX, 'readwrite', s => s.add({ ...item, ts: Date.now() }));
const outboxAll = () => idbReq(OUTBOX, 'readonly', s => s.getAll());
const outboxDel = (id) => idbReq(OUTBOX, 'readwrite', s => s.delete(id));
async function outboxCount() { try { return (await outboxAll() || []).length; } catch { return 0; } }

function isOnline() { return navigator.onLine !== false; }
async function updateNetBadge() {
  const b = $('netBadge'); if (!b) return;
  const n = await outboxCount();
  if (!isOnline()) { b.className = 'net-badge net-off'; b.textContent = n ? `● Hors-ligne · ${n} en attente` : '● Hors-ligne'; }
  else if (n) { b.className = 'net-badge net-sync'; b.textContent = `↻ Synchronisation · ${n}`; }
  else { b.className = 'net-badge net-on'; b.textContent = '● En ligne'; }
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !isOnline() || !S.token) return;
  flushing = true;
  try {
    const items = (await outboxAll()) || [];
    for (const it of items) {
      let res;
      try {
        res = await fetch('/api' + it.path, { method: it.method,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token }, body: it.body });
      } catch { break; } // toujours hors-ligne : on réessaiera
      if (res.ok || (res.status >= 400 && res.status < 500)) await outboxDel(it.id); // succès ou rejet définitif
      else break; // erreur serveur transitoire : on s'arrête
    }
  } finally {
    flushing = false;
    await updateNetBadge();
  }
  if (S.token && (await outboxCount()) === 0 && S.page) { try { go(S.page); } catch {} }
}

function initOffline() {
  window.addEventListener('online', () => { updateNetBadge(); flushOutbox(); });
  window.addEventListener('offline', updateNetBadge);
  navigator.serviceWorker?.addEventListener?.('message', (e) => { if (e.data === 'flush-outbox') flushOutbox(); });
  updateNetBadge();
  flushOutbox();
  setInterval(() => { if (isOnline()) flushOutbox(); }, 30000);
}

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  let res;
  try {
    res = await fetch('/api' + path, { ...opts, headers });
  } catch (netErr) {
    // Échec réseau : on met les écritures en file d'attente (Outbox) pour rejeu.
    if (method !== 'GET') {
      await outboxAdd({ path, method, body: opts.body || null });
      try { (await navigator.serviceWorker?.ready)?.sync?.register?.('flush-outbox'); } catch {}
      await updateNetBadge();
      toast('Hors-ligne : enregistré, synchronisation au retour du réseau');
      return { ok: true, queued: true };
    }
    throw new Error('Hors-ligne : données indisponibles');
  }
  if (res.status === 401) { logout(); throw new Error('Session expirée'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (data && data.abonnement && typeof applyAbonnement === 'function') applyAbonnement(data.abonnement);
    throw new Error((data && data.error) || 'Erreur serveur');
  }
  if (method !== 'GET') updateNetBadge();
  return data;
}

/* ───────────── Authentification ───────────── */
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lErr').textContent = '';
  try {
    const d = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('lUser').value, password: $('lPass').value })
    });
    S.token = d.token; localStorage.setItem('mg_token', d.token);
    S.user = d.user;
    enterApp();
  } catch (err) { $('lErr').textContent = err.message; }
});

$('btnLogout').addEventListener('click', logout);
function logout() {
  S.token = ''; S.user = null; localStorage.removeItem('mg_token');
  if (S.liveTimer) clearInterval(S.liveTimer);
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  $('app').classList.add('hidden'); $('login').classList.remove('hidden');
  const bl = $('aboBlock'); if (bl) bl.classList.add('hidden');
  const bar = $('aboBar'); if (bar) bar.classList.add('hidden');
}

const ROLE_LABEL = { superadmin: 'Super-admin mGlobal', proprietaire: 'Propriétaire',
  admin: 'Administrateur', superviseur: 'Superviseur', comptable: 'Comptable',
  assistante: 'Assistante', vendeur: 'Vendeur', stockiste: 'Stockiste', operateur: 'Opérateur',
  fournisseur: 'Fournisseur' };

const NATURE_LABEL = { habillement: 'Habillement', epicerie: 'Épicerie', depot: 'Dépôt', autre: 'Autre' };
const ABO_LABEL = { essai: 'Essai', actif: 'Actif', expire: 'Expiré', suspendu: 'Suspendu' };
const ABO_TAG = { essai: 'off', actif: 'on', expire: 'off', suspendu: 'off' };
function aboTexte(a) {
  if (!a) return '—';
  if (a.statut === 'essai') return 'Essai (pas d\'échéance)';
  const j = a.joursRestants;
  if (a.statut === 'expire') return `Expiré depuis ${Math.abs(j)} j (${a.echeance})`;
  return `${a.echeance} · ${j} j restants`;
}

function menuFor(role) {
  // Super-admin : administration (propriétaires, comptes, distributeurs), aucun accès
  // aux données métier des boutiques.
  if (role === 'superadmin') {
    return [
      { id: 'admin', label: '⚙ Administration' },
      { id: 'proprietaires', label: '🏢 Propriétaires' },
      { id: 'abonnements', label: '💳 Abonnements' },
      { id: 'users', label: '🔑 Création de comptes' },
      { id: 'fournisseursComptes', label: '🚚 Espaces fournisseurs' }
    ];
  }
  // Propriétaire : espace central (hub) — ses boutiques + RH centralisée.
  if (role === 'proprietaire') {
    return [
      { id: 'proprietaireDashboard', label: '📊 Tableau de bord' },
      { id: 'proprietaireBoutiques', label: '🏬 Mes boutiques' },
      { id: 'proprietaireTransferts', label: '🔄 Transferts de stock' },
      { id: 'proprietaireCollabs', label: '👥 Collaborateurs (RH)' }
    ];
  }
  // Fournisseur : son espace dédié (solde, livraisons au distributeur, historique).
  if (role === 'fournisseur') {
    return [{ id: 'espaceFournisseur', label: '🚚 Mon espace fournisseur' }];
  }
  // Superviseur : consultation (dashboard, suivi, rapports, comptabilité).
  if (role === 'superviseur') {
    return [
      { id: 'dashboard', label: '📊 Dashboard mGlobal' },
      { id: 'suivi', label: '🧾 Suivi des bons' },
      { id: 'compta', label: '💰 Comptabilité' },
      { id: 'rapports', label: '📈 Rapports' }
    ];
  }
  const M = {
    dashboard:    { id: 'dashboard', label: '📊 Dashboard mGlobal' },
    suivi:        { id: 'suivi', label: '🧾 Suivi des bons' },
    bons:         { id: 'bons', label: '📤 Bons / Pesées' },
    clients:      { id: 'clients', label: '👥 Clients' },
    fournisseurs: { id: 'fournisseurs', label: '🚚 Fournisseurs' },
    stock:        { id: 'stock', label: '📦 Produits & Tarifs' },
    gros:         { id: 'gros', label: '🧱 Ventes en gros' },
    facturation:  { id: 'facturation', label: '🧾 Facturation' },
    relicat:      { id: 'relicat', label: '💳 Relicat / Créances' },
    recherche:    { id: 'recherche', label: '🔎 Recherche' },
    compta:       { id: 'compta', label: '💰 Comptabilité' },
    caisse:       { id: 'caisse', label: '🧮 Caisse du jour' },
    rapports:     { id: 'rapports', label: '📈 Rapports' }
  };
  // Comptable : tout le cycle commercial & comptable (pas d'admin utilisateurs).
  if (role === 'comptable') {
    return [M.dashboard, M.suivi, M.clients, M.fournisseurs, M.stock, M.gros,
      M.facturation, M.relicat, M.recherche, M.compta, M.caisse, M.rapports];
  }
  // Vendeur : vente de terrain — pas d'accès à la comptabilité globale.
  if (role === 'vendeur') {
    return [M.dashboard, M.suivi, M.bons, M.clients, M.facturation, M.relicat, M.caisse, M.recherche];
  }
  // Stockiste : gestion des marchandises (stock, ventes en gros, fournisseurs).
  if (role === 'stockiste') {
    return [M.dashboard, M.suivi, M.stock, M.gros, M.fournisseurs, M.recherche];
  }
  // Assistante : saisie opérationnelle (bons, clients, fournisseurs, stock, facturation).
  if (role === 'assistante') {
    return [M.dashboard, M.suivi, M.bons, M.clients, M.fournisseurs, M.stock, M.gros,
      M.facturation, M.relicat, M.caisse, M.recherche];
  }
  // Admin (et opérateur hérité) : accès complet.
  const base = [M.dashboard, M.suivi, M.bons, M.clients, M.fournisseurs, M.stock, M.gros,
    M.facturation, M.relicat, M.recherche, M.compta, M.caisse, M.rapports];
  if (role === 'admin') base.push(
    { id: 'parametres', label: '🏢 Paramètres facturation' },
    { id: 'users', label: '🔑 Utilisateurs & rôles' });
  return base;
}

function enterApp() {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  const u = S.user;
  $('spaceName').textContent = u.distributeur ? u.distributeur.nom
    : u.proprietaire ? u.proprietaire.nom + ' (réseau)'
    : 'Vue globale mGlobal';
  $('who').innerHTML = `<b>${esc(u.fullName || u.username)}</b><br>${ROLE_LABEL[u.role] || u.role}`;
  const nav = $('nav'); nav.innerHTML = '';
  for (const m of menuFor(u.role)) {
    const b = el(`<button data-page="${m.id}">${m.label}</button>`);
    b.onclick = () => go(m.id);
    nav.appendChild(b);
  }
  S.history = [];
  const back = $('btnBack'); if (back) back.onclick = goBack;
  const accueil = u.role === 'superadmin' ? 'admin'
    : u.role === 'proprietaire' ? 'proprietaireDashboard'
    : u.role === 'fournisseur' ? 'espaceFournisseur' : 'dashboard';
  go(accueil);
  applyAbonnement();
  connectWS();
}

// Verrouillage en cascade (Module 6) : bandeau d'alerte / lecture seule, ou écran
// de blocage total selon la politique d'abonnement renvoyée par le serveur.
function applyAbonnement(a) {
  if (a) S.user.abonnement = a; else a = S.user && S.user.abonnement;
  const bar = $('aboBar'), block = $('aboBlock');
  if (!bar || !block) return;
  bar.classList.add('hidden'); block.classList.add('hidden');
  if (!a || a.mode === 'actif') return;
  const ech = a.echeance ? ` (échéance ${a.echeance})` : '';
  if (a.mode === 'bloque') {
    block.classList.remove('hidden');
    const proprio = S.user.role === 'proprietaire';
    block.innerHTML = `<div class="card">
      <div class="lock">🔒</div>
      <h2>Espace bloqué — abonnement échu</h2>
      <p>L'abonnement mGlobal Business de ce réseau est arrivé à expiration${ech}.</p>
      <p>${proprio ? 'Veuillez régulariser votre abonnement auprès du super-administrateur pour rétablir l\'accès.' : 'Contactez le propriétaire du réseau ou le super-administrateur pour rétablir l\'accès.'}</p>
      <button class="btn" onclick="logout()">Se déconnecter</button>
    </div>`;
    return;
  }
  bar.classList.remove('hidden');
  if (a.mode === 'lecture_seule') {
    bar.className = 'abo-bar lvl-ro';
    bar.textContent = `🔒 Abonnement échu${ech} : espace en LECTURE SEULE. Réglez l'abonnement pour réactiver les saisies.`;
  } else { // alerte
    bar.className = 'abo-bar ' + (a.alerteUrgente ? 'lvl-urgent' : 'lvl-alerte');
    bar.textContent = `⚠ Abonnement à renouveler : expire dans ${a.joursRestants} jour(s)${ech}.`;
  }
}

// Historique de navigation (pour le bouton « Retour »).
S.history = [];
function go(page, fromBack = false) {
  if (!fromBack && S.page && S.page !== page) S.history.push(S.page);
  S.page = page;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = null; }
  updateBackBtn();
  ({ dashboard: pageDashboard, suivi: pageSuivi, bons: pageBons, clients: pageClients,
     fournisseurs: pageFournisseurs, stock: pageStock, gros: pageGros,
     facturation: pageFacturation, relicat: pageRelicat, recherche: pageRecherche,
     compta: pageCompta, caisse: pageCaisse, rapports: pageRapports, users: pageUsers, admin: pageAdmin,
     parametres: pageParametres, fournisseursComptes: pageFournisseursComptes,
     espaceFournisseur: pageEspaceFournisseur, proprietaires: pageProprietaires,
     abonnements: pageAbonnements,
     proprietaireDashboard: pageProprietaireDashboard, proprietaireTransferts: pageProprietaireTransferts,
     proprietaireBoutiques: pageProprietaireBoutiques, proprietaireCollabs: pageProprietaireCollabs
   }[page] || pageDashboard)();
}
function goBack() {
  const prev = S.history.pop();
  if (prev) go(prev, true);
}
function updateBackBtn() {
  const b = $('btnBack'); if (!b) return;
  b.style.display = S.history.length ? 'inline-flex' : 'none';
}

/* ───────────── Dashboard commun + live ───────────── */
async function pageDashboard() {
  $('pageTitle').textContent = 'Dashboard mGlobal (commun)';
  const c = $('content');
  c.innerHTML = `
    <div class="live"><div><span class="w" id="liveW">0.000</span> <span class="u" id="liveU">t</span></div>
      <div class="s" id="liveS">Connexion…</div></div>
    <div class="kpis" id="kpis"></div>
    <div class="panel"><h3>Répartition par distributeur</h3><div id="byDist"></div></div>`;
  refreshLive();
  S.liveTimer = setInterval(refreshLive, 1500);
  try {
    const g = await api('/dashboard/global');
    $('kpis').innerHTML = [
      ['Camions (jour)', g.jour.nbCamions], ['Tonnes (jour)', fmt(g.jour.totalTonnes)],
      ['Tonnes (mois)', fmt(g.mois.totalTonnes)], ['Tonnes (année)', fmt(g.annee.totalTonnes)]
    ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    $('byDist').innerHTML = g.parDistributeur.length ? `<table>
      <tr><th>Distributeur</th><th>Bons</th><th>Total tonnes</th></tr>
      ${g.parDistributeur.map(d => `<tr><td>${esc(d.distributeur)}</td><td>${d.nbBons}</td><td>${fmt(d.totalTonnes)}</td></tr>`).join('')}
      </table>` : '<div class="hint">Aucune donnée pour le moment.</div>';
  } catch (e) { toast(e.message, true); }
}
async function refreshLive() {
  try {
    const l = await api('/dashboard/live');
    if (S.page !== 'dashboard') return;
    applyLive(l);
  } catch {}
}
function applyLive(l) {
  if (!$('liveW')) return;
  $('liveW').textContent = fmt(l.valeur);
  $('liveU').textContent = l.unite;
  $('liveS').textContent = !l.connected ? '● Balance déconnectée' : (l.stable ? '✔ Poids stable' : '… en pesée');
  $('liveS').style.color = l.stable ? 'var(--green)' : 'var(--accent)';
}

/* ───────────── Bons / Pesées ───────────── */
async function pageBons() {
  $('pageTitle').textContent = 'Bons / Pesées';
  const c = $('content');
  c.innerHTML = `<div class="panel">
    <div class="filters">
      <label>Du</label><input type="date" id="bFrom" value="${today()}">
      <label>au</label><input type="date" id="bTo" value="${today()}">
      <button class="btn sec" id="bGo">Actualiser</button>
    </div>
    <div id="bTable"><div class="hint">Chargement…</div></div></div>`;
  $('bGo').onclick = loadBons;
  loadBons();
}
async function loadBons() {
  try {
    const rows = await api(`/sorties?from=${$('bFrom').value}&to=${$('bTo').value}`);
    $('bTable').innerHTML = rows.length ? `<table>
      <tr><th>Ticket</th><th>Immat.</th><th>Client</th><th>Produit</th><th>Net (t)</th><th>Heure</th><th></th></tr>
      ${rows.map(s => `<tr>
        <td>${esc(s.numeroTicket)}</td><td>${esc(s.immatriculation)}</td><td>${esc(s.client)}</td>
        <td>${esc(s.produit)}</td><td>${fmt(s.poidsNet)}</td><td>${esc((s.dateSortie || '').slice(11, 16))}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="voirBon(${s.id})">Voir</button>
          <button class="btn sec" onclick="imprimerSortie(${s.id})">Imprimer</button>
        </td></tr>`).join('')}</table>` : '<div class="hint">Aucun bon sur cette période.</div>';
  } catch (e) { toast(e.message, true); }
}
window.voirBon = (id) => window.open(`/api/bon?id=${id}&token=${encodeURIComponent(S.token)}`, '_blank');
window.imprimerSortie = async (id) => {
  try { const r = await api('/bons', { method: 'POST', body: JSON.stringify({ sortieId: id, action: 'print' }) });
    toast(r.message || 'Bon envoyé à l\'imprimante.'); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Suivi des bons (création + avancement) ───────────── */
const BON_STATUTS = [
  { id: 'en_attente', label: 'En attente', cls: 'st-attente' },
  { id: 'recu',       label: 'Reçu',        cls: 'st-recu' },
  { id: 'en_cours',   label: 'En pesage',   cls: 'st-encours' },
  { id: 'pese',       label: 'Pesé',        cls: 'st-pese' },
  { id: 'termine',    label: 'Terminé',     cls: 'st-termine' },
  { id: 'rejete',     label: 'Rejeté',      cls: 'st-rejete' },
  { id: 'annule',     label: 'Annulé',      cls: 'st-annule' }
];
const statutInfo = (id) => BON_STATUTS.find(s => s.id === id) || { label: id, cls: '' };

async function pageSuivi() {
  $('pageTitle').textContent = 'Suivi des bons';
  const c = $('content');
  const canCreate = ['admin', 'assistante', 'comptable', 'operateur'].includes(S.user.role);
  c.innerHTML = `
    ${canCreate ? `<div class="panel"><h3>Créer un bon et l'envoyer au pont bascule</h3>
      <div class="formgrid">
        <span><label>Client</label><input id="cbClient" placeholder="Nom du client"></span>
        <span><label>Produit</label><input id="cbProduit" placeholder="Ciment, sable…"></span>
        <span><label>Immatriculation</label><input id="cbImmat" placeholder="DK-0000-AA"></span>
        <span><label>Chauffeur</label><input id="cbChauffeur" placeholder="Nom du chauffeur"></span>
        <span><label>Destination</label><input id="cbDest" placeholder="Ville / chantier"></span>
        <span><label>Quantité prévue (t)</label><input id="cbQte" type="number" step="0.001" placeholder="0"></span>
        <span style="flex:1"><label>Note</label><input id="cbNote" placeholder="Remarque (optionnel)"></span>
      </div>
      <div id="cbVerif" class="verif-bon" style="display:none"></div>
      <div style="margin-top:10px"><button class="btn" id="cbAdd">📨 Envoyer au pont bascule</button></div>
    </div>` : ''}
    <div class="panel">
      <div class="filters">
        <h3 style="margin:0;flex:1">Mes bons</h3>
        <label>Statut</label>
        <select id="cbFilter">
          <option value="">Tous</option>
          ${BON_STATUTS.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
        <button class="btn sec" id="cbReload">Actualiser</button>
        <span class="wsdot" id="wsDot" title="Temps réel">● temps réel</span>
      </div>
      <div id="cbTable"><div class="hint">Chargement…</div></div>
    </div>`;
  if (canCreate) {
    $('cbAdd').onclick = creerBon;
    let vt;
    const trig = () => { clearTimeout(vt); vt = setTimeout(verifClientBon, 350); };
    $('cbClient').addEventListener('input', trig);
    $('cbImmat').addEventListener('input', trig);
  }
  $('cbReload').onclick = loadSuivi;
  $('cbFilter').onchange = loadSuivi;
  loadSuivi();
  connectWS();
}

// Vérification automatique : le client (nom ou immatriculation) a-t-il un compte gros
// avec solde à enlever ? → mode « enlèvement », sinon « nouveau bon ».
let _verifGros = null;
async function verifClientBon() {
  const box = $('cbVerif'); if (!box) return;
  _verifGros = null;
  const nom = ($('cbClient')?.value || '').trim();
  const imm = ($('cbImmat')?.value || '').trim();
  if (!nom && !imm) { box.style.display = 'none'; box.innerHTML = ''; return; }
  try {
    const d = await api('/bons-commande/verif-client?immatriculation='
      + encodeURIComponent(imm) + '&nom=' + encodeURIComponent(nom));
    if (d.aGros) {
      const c = d.clients.find(x => x.gros && x.gros.length) || d.clients[0];
      _verifGros = { client: c, gros: c.gros };
      box.className = 'verif-bon ok';
      box.innerHTML = `✅ <b>${esc(c.nom)}</b> (${esc(c.immatriculation)}) a un <b>compte gros</b> — `
        + c.gros.map(g => `${esc(g.produit_nom || 'marchandise')} : <b>${fmt(g.quantite_restante)} ${esc(g.unite || '')}</b> à enlever`).join(' · ')
        + ` → <b>mode enlèvement</b>. `
        + c.gros.map(g => `<button class="btn sec" onclick="formEnlevement(${g.id})">📦 Enlèvement (${esc(g.produit_nom || '')})</button>`).join(' ');
      box.style.display = 'block';
    } else if (d.clients && d.clients.length) {
      box.className = 'verif-bon';
      box.innerHTML = `ℹ ${d.clients.length > 1 ? d.clients.length + ' clients trouvés avec ce nom — ' : ''}`
        + `pas de compte gros actif → <b>nouveau bon</b> (suivi + facturation automatiques).`;
      box.style.display = 'block';
    } else {
      box.className = 'verif-bon';
      box.innerHTML = `ℹ Nouveau client / pas de compte gros → <b>nouveau bon</b> (suivi + facturation automatiques).`;
      box.style.display = 'block';
    }
  } catch { box.style.display = 'none'; }
}
// Formulaire d'enlèvement : pré-rempli avec les infos du client et du produit du
// compte gros (quantité restante). À la validation, un n° de bon est attribué et
// le bon d'enlèvement s'imprime automatiquement.
window.formEnlevement = (grosId) => {
  if (!_verifGros) return;
  const c = _verifGros.client;
  const g = (_verifGros.gros || []).find(x => x.id === grosId);
  if (!g) return;
  enlevementModal(g, c, () => { verifClientBon(); loadSuivi(); });
};

// Modal d'enlèvement partagé (suivi des bons & page ventes en gros). Pré-rempli avec
// les infos client/produit ; à la validation un n° de bon est attribué puis imprimé.
function enlevementModal(g, c, onDone) {
  const ident = c ? `Client : <b>${esc(c.nom)}</b>${c.immatriculation ? ' (' + esc(c.immatriculation) + ')' : ''}${c.telephone ? ' · ' + esc(c.telephone) : ''}<br>` : '';
  $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="modal"><div class="modal-head"><h3>Bon d'enlèvement</h3>
      <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body">
        <div class="verif-bon ok" style="display:block;margin-bottom:12px">
          ${ident}Produit : <b>${esc(g.produit_nom || 'marchandise')}</b> · Reste à enlever :
          <b>${fmt(g.quantite_restante)} ${esc(g.unite || 't')}</b></div>
        <div class="formgrid">
          <span><label>Quantité à enlever (${esc(g.unite || 't')})</label>
            <input id="enlQte" type="number" step="0.001" max="${g.quantite_restante}" value="${g.quantite_restante}"></span>
          <span><label>Immatriculation camion</label><input id="enlImmat" placeholder="DK-0000-AA"></span>
          <span><label>Chauffeur</label><input id="enlChauf" placeholder="Nom du chauffeur"></span>
          <span><label>Destination</label><input id="enlDest" placeholder="Ville / chantier"></span>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn sec" onclick="document.querySelector('.modal-bg').remove()">← Retour</button>
          <button class="btn" id="enlGo">📦 Valider, attribuer le n° de bon & imprimer</button></div>
      </div></div></div>`;
  $('enlGo').onclick = async () => {
    const q = Number($('enlQte').value || 0);
    if (q <= 0) return toast('Quantité invalide', true);
    try {
      const r = await api('/enlevements', { method: 'POST', body: JSON.stringify({
        commande_gros_id: g.id, quantite_enlevee: q,
        immatriculation: $('enlImmat').value, chauffeur: $('enlChauf').value, destination: $('enlDest').value }) });
      document.querySelector('.modal-bg')?.remove();
      toast(`Enlèvement enregistré — bon ${r.bon?.reference || ''} attribué`);
      if (r.bon?.id) imprimerBon(r.bon.id);
      if (onDone) onDone();
    } catch (e) { toast(e.message, true); }
  };
}

async function creerBon() {
  const body = {
    client: $('cbClient').value, produit: $('cbProduit').value,
    immatriculation: $('cbImmat').value, chauffeur: $('cbChauffeur').value,
    destination: $('cbDest').value, quantitePrevue: Number($('cbQte').value || 0),
    note: $('cbNote').value
  };
  try {
    const r = await api('/bons-commande', { method: 'POST', body: JSON.stringify(body) });
    toast('Bon créé, numéroté et signé puis envoyé au pont bascule');
    ['cbClient','cbProduit','cbImmat','cbChauffeur','cbDest','cbQte','cbNote'].forEach(id => { if ($(id)) $(id).value = ''; });
    // Impression automatique du bon dès l'envoi au pont bascule.
    if (r?.bon?.id) imprimerBon(r.bon.id);
    loadSuivi();
  } catch (e) { toast(e.message, true); }
}

async function loadSuivi() {
  try {
    const st = $('cbFilter') ? $('cbFilter').value : '';
    const rows = await api('/bons-commande' + (st ? `?statut=${st}` : ''));
    renderSuivi(rows);
  } catch (e) { toast(e.message, true); }
}

function renderSuivi(rows) {
  const t = $('cbTable'); if (!t) return;
  if (!rows.length) { t.innerHTML = '<div class="hint">Aucun bon pour le moment.</div>'; return; }
  const isAdmin = S.user.role === 'admin';
  t.innerHTML = `<table>
    <tr><th>N°</th><th>Référence</th><th>Client</th><th>Produit</th><th>Immat.</th>
      <th>Qté prévue</th><th>Avancement</th><th>Net (t)</th><th>Signature</th><th></th></tr>
    ${rows.map(b => {
      const si = statutInfo(b.statut);
      const editable = ['en_attente', 'recu'].includes(b.statut);
      return `<tr>
        <td>${b.numero != null ? '#' + b.numero : '—'}</td>
        <td>${esc(b.reference)}</td>
        <td>${esc(b.client)}</td><td>${esc(b.produit)}</td><td>${esc(b.immatriculation)}</td>
        <td>${fmt(b.quantitePrevue)}</td>
        <td><span class="badge ${si.cls}">${si.label}</span>
          <div class="prog"><div class="prog-bar ${si.cls}" style="width:${b.progression}%"></div></div></td>
        <td>${b.poidsNet != null ? fmt(b.poidsNet) : '—'}</td>
        <td>${b.signature ? `<span class="sig-ok" title="${esc(b.signature)}">🔏 signé</span>` : '—'}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="suiviDetail(${b.id})">Suivi</button>
          <button class="btn sec" onclick="imprimerBon(${b.id})">🖨 Imprimer</button>
          ${isAdmin && editable ? `<button class="btn sec" onclick="modifierBon(${b.id})">Modifier</button>` : ''}
          ${isAdmin && !['termine','annule'].includes(b.statut) ? `<button class="btn sec" onclick="annulerBon(${b.id})">Annuler</button>` : ''}
          ${isAdmin ? `<button class="btn danger" onclick="supprimerBon(${b.id})">Suppr.</button>` : ''}
        </td></tr>`;
    }).join('')}</table>`;
}

window.annulerBon = async (id) => {
  const motif = prompt('Motif de l\'annulation (optionnel) :', '');
  if (motif === null) return;
  try { await api('/bons-commande/' + id + '/annuler', { method: 'POST', body: JSON.stringify({ motif }) });
    toast('Bon annulé'); loadSuivi(); }
  catch (e) { toast(e.message, true); }
};

window.supprimerBon = async (id) => {
  if (!confirm('Supprimer définitivement ce bon ? Cette action est irréversible.')) return;
  try { await api('/bons-commande/' + id, { method: 'DELETE' }); toast('Bon supprimé'); loadSuivi(); }
  catch (e) { toast(e.message, true); }
};

window.modifierBon = async (id) => {
  try {
    const b = await api('/bons-commande/' + id);
    const host = $('modalHost');
    host.innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
      <div class="modal">
        <div class="modal-head"><h3>Modifier le bon ${esc(b.reference)}</h3>
          <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
        <div class="modal-body">
          <div class="formgrid">
            <span><label>Client</label><input id="mbClient" value="${esc(b.client || '')}"></span>
            <span><label>Produit</label><input id="mbProduit" value="${esc(b.produit || '')}"></span>
            <span><label>Immatriculation</label><input id="mbImmat" value="${esc(b.immatriculation || '')}"></span>
            <span><label>Chauffeur</label><input id="mbChauffeur" value="${esc(b.chauffeur || '')}"></span>
            <span><label>Destination</label><input id="mbDest" value="${esc(b.destination || '')}"></span>
            <span><label>Quantité prévue (t)</label><input id="mbQte" type="number" step="0.001" value="${b.quantitePrevue || 0}"></span>
            <span style="flex:1"><label>Note</label><input id="mbNote" value="${esc(b.note || '')}"></span>
          </div>
          <div class="hint">La modification re-signe automatiquement le bon (intégrité conservée).</div>
          <div style="margin-top:10px"><button class="btn" id="mbSave">Enregistrer</button></div>
        </div>
      </div></div>`;
    $('mbSave').onclick = async () => {
      const body = {
        client: $('mbClient').value, produit: $('mbProduit').value,
        immatriculation: $('mbImmat').value, chauffeur: $('mbChauffeur').value,
        destination: $('mbDest').value, quantitePrevue: Number($('mbQte').value || 0),
        note: $('mbNote').value
      };
      try { await api('/bons-commande/' + id, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Bon modifié et re-signé'); document.querySelector('.modal-bg').remove(); loadSuivi(); }
      catch (e) { toast(e.message, true); }
    };
  } catch (e) { toast(e.message, true); }
};

window.suiviDetail = async (id) => {
  try {
    const b = await api('/bons-commande/' + id);
    const si = statutInfo(b.statut);
    const tl = (b.timeline || []).map(e => {
      const s = statutInfo(e.statut);
      return `<div class="tl-item"><div class="tl-dot ${s.cls}"></div>
        <div><b>${s.label}</b> <span class="tl-time">${esc((e.ts || '').slice(0, 16))}</span>
        <div class="tl-detail">${esc(e.detail || '')}${e.par ? ' — ' + esc(e.par) : ''}</div></div></div>`;
    }).join('');
    const host = $('modalHost');
    host.innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
      <div class="modal">
        <div class="modal-head"><h3>Suivi du bon ${esc(b.reference)}</h3>
          <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
        <div class="modal-body">
          <div class="bon-meta">
            <div><span>N° de bon</span><b>${b.numero != null ? '#' + b.numero : '—'}</b></div>
            <div><span>Référence</span><b>${esc(b.reference || '—')}</b></div>
            <div><span>Client</span><b>${esc(b.client || '—')}</b></div>
            <div><span>Produit</span><b>${esc(b.produit || '—')}</b></div>
            <div><span>Immatriculation</span><b>${esc(b.immatriculation || '—')}</b></div>
            <div><span>Chauffeur</span><b>${esc(b.chauffeur || '—')}</b></div>
            <div><span>Destination</span><b>${esc(b.destination || '—')}</b></div>
            <div><span>Qté prévue</span><b>${fmt(b.quantitePrevue)} t</b></div>
            <div><span>Statut</span><b><span class="badge ${si.cls}">${si.label}</span></b></div>
            <div><span>Poids net pesé</span><b>${b.poidsNet != null ? fmt(b.poidsNet) + ' t' : '—'}</b></div>
            <div><span>Ticket</span><b>${esc(b.numeroTicket || '—')}</b></div>
          </div>
          ${b.motifRejet ? `<div class="hint" style="color:var(--red)">Motif : ${esc(b.motifRejet)}</div>` : ''}
          ${b.signature ? `<h4>Signature électronique</h4>
            <div class="sig-box">
              <div><span>Signataire</span><b>${esc(b.signaturePar || '—')}</b>
                <span style="margin-left:14px">le</span> <b>${esc((b.signatureLe || '').slice(0, 19).replace('T', ' '))}</b>
                ${b.signatureValide === true ? '<span class="sig-ok" style="margin-left:14px">✔ intègre</span>'
                  : b.signatureValide === false ? '<span class="sig-bad" style="margin-left:14px">✖ altéré</span>' : ''}</div>
              <code class="sig-hash">${esc(b.signature)}</code>
            </div>` : ''}
          <h4>Avancement</h4>
          <div class="timeline">${tl || '<div class="hint">—</div>'}</div>
        </div>
      </div></div>`;
  } catch (e) { toast(e.message, true); }
};

/* ───────────── Temps réel (WebSocket) ───────────── */
function connectWS() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
    S.ws = ws;
    ws.onopen = () => { const d = $('wsDot'); if (d) d.classList.add('on'); };
    ws.onclose = () => { const d = $('wsDot'); if (d) d.classList.remove('on'); S.ws = null;
      if (S.token) setTimeout(connectWS, 4000); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if ((m.type === 'bon:maj' || m.type === 'bon:nouveau' || m.type === 'bon:annule') && S.page === 'suivi') loadSuivi();
      if (m.type === 'live' && S.page === 'dashboard' && m.live) applyLive(m.live);
    };
  } catch {}
}

/* ───────────── Clients (carnet) ───────────── */
async function pageClients() {
  $('pageTitle').textContent = 'Clients';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Nouveau client</h3>
    <div class="filters">
      <span><label>Nom</label><input id="clNom" placeholder="Nom / Raison sociale"></span>
      <span><label>Téléphone</label><input id="clTel" placeholder="77 000 00 00"></span>
      <span style="flex:1"><label>Adresse</label><input id="clAdr" placeholder="Adresse"></span>
      <button class="btn sec" id="clAdd">Ajouter</button>
    </div>
    <div class="hint">Plusieurs clients peuvent porter le même nom : un code d'accès unique
      (immatriculation) est généré automatiquement et sert de clé d'identification.</div></div>
    <div class="panel"><h3>Mes clients</h3><div id="clTable"><div class="hint">Chargement…</div></div></div>`;
  $('clAdd').onclick = async () => {
    if (!$('clNom').value.trim()) return toast('Le nom est requis', true);
    try {
      await api('/clients', { method: 'POST', body: JSON.stringify({
        nom: $('clNom').value, telephone: $('clTel').value, adresse: $('clAdr').value }) });
      toast('Client ajouté'); $('clNom').value = $('clTel').value = $('clAdr').value = ''; loadClients();
    } catch (e) { toast(e.message, true); }
  };
  loadClients();
}
async function loadClients() {
  try {
    const rows = await api('/clients');
    $('clTable').innerHTML = rows.length ? `<table>
      <tr><th>Nom</th><th>Code portail</th><th>Téléphone</th><th>Dette</th><th>Relicat</th><th></th></tr>
      ${rows.map(x => `<tr>
        <td>${esc(x.nom)}</td><td><span class="keybox">${esc(x.immatriculation)}</span></td>
        <td>${esc(x.telephone || '')}</td>
        <td class="${x.solde_dette > 0 ? 'neg' : ''}">${money(x.solde_dette)}</td>
        <td class="${x.solde_relicat > 0 ? 'pos' : ''}">${money(x.solde_relicat)}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="editClient(${x.id},'${esc(x.nom)}','${esc(x.telephone || '')}','${esc(x.adresse || '')}')">Modifier</button>
          <button class="btn danger" onclick="delClient(${x.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun client pour le moment.</div>';
  } catch (e) { toast(e.message, true); }
}
window.editClient = (id, nom, tel, adr) => {
  const n = prompt('Nom du client :', nom); if (n === null) return;
  const t = prompt('Téléphone :', tel); if (t === null) return;
  const a = prompt('Adresse :', adr); if (a === null) return;
  api('/clients/' + id, { method: 'PUT', body: JSON.stringify({ nom: n, telephone: t, adresse: a }) })
    .then(() => { toast('Client modifié'); loadClients(); }).catch(e => toast(e.message, true));
};
window.delClient = async (id) => {
  if (!confirm('Supprimer ce client ?')) return;
  try { await api('/clients/' + id, { method: 'DELETE' }); toast('Client supprimé'); loadClients(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Fournisseurs (+ espace fournisseur) ───────────── */
async function pageFournisseurs() {
  $('pageTitle').textContent = 'Fournisseurs';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Nouveau fournisseur</h3>
    <div class="filters">
      <span><label>Nom</label><input id="frNom" placeholder="Nom du fournisseur"></span>
      <span><label>Téléphone</label><input id="frTel" placeholder="77 000 00 00"></span>
      <span style="flex:1"><label>Adresse</label><input id="frAdr" placeholder="Adresse"></span>
      <button class="btn sec" id="frAdd">Ajouter</button>
    </div>
    <div class="hint">Un code d'accès à l'espace fournisseur (portail) est généré automatiquement.</div></div>
    <div class="panel"><h3>Mes fournisseurs</h3><div id="frTable"><div class="hint">Chargement…</div></div></div>`;
  $('frAdd').onclick = async () => {
    if (!$('frNom').value.trim()) return toast('Le nom est requis', true);
    try {
      await api('/fournisseurs', { method: 'POST', body: JSON.stringify({
        nom: $('frNom').value, telephone: $('frTel').value, adresse: $('frAdr').value }) });
      toast('Fournisseur ajouté'); $('frNom').value = $('frTel').value = $('frAdr').value = ''; loadFournisseurs();
    } catch (e) { toast(e.message, true); }
  };
  loadFournisseurs();
}
async function loadFournisseurs() {
  try {
    const rows = await api('/fournisseurs');
    $('frTable').innerHTML = rows.length ? `<table>
      <tr><th>Nom</th><th>Code espace</th><th>Téléphone</th><th>Dette due</th><th>État</th><th></th></tr>
      ${rows.map(f => `<tr>
        <td>${esc(f.nom)}</td><td><span class="keybox">${esc(f.code)}</span></td>
        <td>${esc(f.telephone || '')}</td>
        <td class="${f.solde_dette > 0 ? 'neg' : ''}">${money(f.solde_dette)}</td>
        <td><span class="tag ${f.actif ? 'on' : 'off'}">${f.actif ? 'Actif' : 'Inactif'}</span></td>
        <td class="row-actions">
          <button class="btn sec" onclick="reglerFournisseur(${f.id})">Régler</button>
          <button class="btn danger" onclick="delFournisseur(${f.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun fournisseur pour le moment.</div>';
  } catch (e) { toast(e.message, true); }
}
window.reglerFournisseur = async (id) => {
  const m = prompt('Montant à régler au fournisseur :', ''); if (m === null) return;
  try { await api('/fournisseurs/' + id + '/reglement', { method: 'POST', body: JSON.stringify({ montant: Number(m) }) });
    toast('Règlement enregistré'); loadFournisseurs(); } catch (e) { toast(e.message, true); }
};
window.delFournisseur = async (id) => {
  if (!confirm('Supprimer ce fournisseur ?')) return;
  try { await api('/fournisseurs/' + id, { method: 'DELETE' }); toast('Fournisseur supprimé'); loadFournisseurs(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Produits & Tarifs (catalogue : prix + TVA) ───────────── */
let _produits = [], _fournisseurs = [];
async function pageStock() {
  $('pageTitle').textContent = 'Produits & Tarifs';
  const c = $('content');
  try { _fournisseurs = await api('/fournisseurs'); } catch { _fournisseurs = []; }
  const frOpts = `<option value="">— Fournisseur —</option>` +
    _fournisseurs.map(f => `<option value="${f.id}">${esc(f.nom)}</option>`).join('');
  c.innerHTML = `<div class="panel"><h3>Nouveau produit / article</h3>
    <div class="hint">Définissez le prix de vente unitaire (HT) et le taux de TVA : ils seront
      chargés automatiquement dans les factures.</div>
    <div class="formgrid" style="margin-top:10px">
      <span><label>Désignation</label><input id="pNom" placeholder="Ciment, sable…"></span>
      <span><label>Référence</label><input id="pRef" placeholder="Code article (optionnel)"></span>
      <span><label>Unité</label><input id="pUnite" value="t" style="width:70px"></span>
      <span><label>Stock initial</label><input id="pStock" type="number" step="0.001" value="0"></span>
      <span><label>Seuil alerte</label><input id="pAlerte" type="number" step="0.001" value="10"></span>
      <span><label>Prix achat</label><input id="pAchat" type="number" step="0.01" value="0"></span>
      <span><label>Prix vente HT</label><input id="pVenteHT" type="number" step="0.01" value="0"></span>
      <span><label>Prix vente gros</label><input id="pVente" type="number" step="0.01" value="0"></span>
      <span><label>TVA (%)</label><input id="pTva" type="number" step="0.1" value="18"></span>
      <span><label>Fournisseur</label><select id="pFour">${frOpts}</select></span>
    </div>
    <div style="margin-top:10px"><button class="btn" id="pAdd">Ajouter au catalogue</button></div></div>
    <div class="panel"><h3>Catalogue, tarifs & stock</h3><div id="pTable"><div class="hint">Chargement…</div></div></div>
    <div class="panel"><h3>Journal des mouvements de stock (entrée = dépense · sortie = revenu)</h3>
      <div id="pMvt"><div class="hint">Chargement…</div></div></div>`;
  $('pAdd').onclick = async () => {
    if (!$('pNom').value.trim()) return toast('La désignation est requise', true);
    try {
      await api('/produits', { method: 'POST', body: JSON.stringify({
        nom: $('pNom').value, reference: $('pRef').value, unite: $('pUnite').value,
        stock_actuel: Number($('pStock').value || 0), stock_alerte: Number($('pAlerte').value || 0),
        prix_achat: Number($('pAchat').value || 0), prix_vente: Number($('pVenteHT').value || 0),
        prix_vente_gros: Number($('pVente').value || 0), tva: Number($('pTva').value || 0),
        fournisseur_id: $('pFour').value || null }) });
      toast('Produit ajouté'); $('pNom').value = $('pRef').value = ''; loadProduits();
    } catch (e) { toast(e.message, true); }
  };
  loadProduits();
}
async function loadProduits() {
  try {
    _produits = await api('/produits');
    $('pTable').innerHTML = _produits.length ? `<table>
      <tr><th>Produit</th><th>Réf.</th><th>Stock</th><th>Prix achat</th><th>Vente HT</th><th>TVA</th><th>Vente gros</th><th>Fournisseur</th><th></th></tr>
      ${_produits.map(p => `<tr>
        <td>${esc(p.nom)}</td><td>${esc(p.reference || '—')}</td>
        <td class="${p.stock_actuel <= p.stock_alerte ? 'neg' : ''}">${fmt(p.stock_actuel)} ${esc(p.unite)}
          ${p.stock_actuel <= p.stock_alerte ? ' ⚠' : ''}</td>
        <td>${money(p.prix_achat)}</td><td>${money(p.prix_vente)}</td><td>${fmt(p.tva, 1)} %</td>
        <td>${money(p.prix_vente_gros)}</td>
        <td>${esc(p.fournisseur_nom || '—')}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="editProduit(${p.id})">Modifier</button>
          <button class="btn sec" onclick="approvProduit(${p.id})">Approvisionner</button>
          <button class="btn sec" onclick="mouvementProduit(${p.id})">Mouvement</button>
          <button class="btn danger" onclick="delProduit(${p.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun produit pour le moment.</div>';
  } catch (e) { toast(e.message, true); }
  loadMouvements();
}
async function loadMouvements() {
  const box = $('pMvt'); if (!box) return;
  try {
    const rows = await api('/mouvements-stock');
    box.innerHTML = rows.length ? `<table>
      <tr><th>Date</th><th>Produit</th><th>Sens</th><th>Qté</th><th>P.U.</th><th>Montant</th><th>Impact compta</th><th>Motif</th></tr>
      ${rows.map(m => `<tr>
        <td>${esc((m.date || '').replace('T', ' ').slice(0, 16))}</td>
        <td>${esc(m.produit_nom || '—')}</td>
        <td><span class="badge ${m.sens === 'IN' ? 'st-recu' : 'st-termine'}">${m.sens === 'IN' ? 'Entrée' : 'Sortie'}</span></td>
        <td>${fmt(m.quantite)} ${esc(m.unite || '')}</td>
        <td>${money(m.prix_unitaire)}</td>
        <td>${money(m.montant)}</td>
        <td class="${m.sens === 'IN' ? 'neg' : 'pos'}">${m.sens === 'IN' ? 'Dépense' : 'Revenu'}</td>
        <td>${esc(m.motif || '—')}</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun mouvement de stock.</div>';
  } catch (e) { box.innerHTML = '<div class="hint">—</div>'; }
}
window.mouvementProduit = async (id) => {
  const p = _produits.find(x => x.id === id); if (!p) return;
  $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="modal"><div class="modal-head"><h3>Mouvement de stock — ${esc(p.nom)}</h3>
      <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body">
        <div class="hint">Stock actuel : <b>${fmt(p.stock_actuel)} ${esc(p.unite)}</b>. Une <b>entrée</b> est comptée
          comme dépense (prix d'achat), une <b>sortie</b> comme revenu (prix de vente).</div>
        <div class="formgrid" style="margin-top:10px">
        <span><label>Sens</label><select id="mvSens">
          <option value="IN">Entrée (achat → dépense)</option>
          <option value="OUT">Sortie (vente → revenu)</option></select></span>
        <span><label>Quantité</label><input id="mvQte" type="number" step="0.001" value="0"></span>
        <span><label>Prix unitaire</label><input id="mvPrix" type="number" step="0.01" value="${p.prix_vente || p.prix_achat || 0}"></span>
        <span style="flex:1"><label>Motif</label><input id="mvMotif" placeholder="Optionnel"></span>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn sec" onclick="document.querySelector('.modal-bg').remove()">← Retour</button>
        <button class="btn" id="mvSave">Enregistrer</button></div></div></div></div>`;
  $('mvSens').onchange = () => { $('mvPrix').value = $('mvSens').value === 'IN' ? (p.prix_achat || 0) : (p.prix_vente || p.prix_vente_gros || 0); };
  $('mvSave').onclick = async () => {
    try {
      await api('/produits/' + id + '/mouvement', { method: 'POST', body: JSON.stringify({
        sens: $('mvSens').value, quantite: Number($('mvQte').value || 0),
        prix_unitaire: Number($('mvPrix').value || 0), motif: $('mvMotif').value }) });
      toast('Mouvement enregistré (écriture comptable créée)');
      document.querySelector('.modal-bg').remove(); loadProduits();
    } catch (e) { toast(e.message, true); }
  };
};
window.editProduit = (id) => {
  const p = _produits.find(x => x.id === id); if (!p) return;
  const frOpts = `<option value="">— Fournisseur —</option>` +
    _fournisseurs.map(f => `<option value="${f.id}" ${f.id === p.fournisseur_id ? 'selected' : ''}>${esc(f.nom)}</option>`).join('');
  $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="modal"><div class="modal-head"><h3>Modifier ${esc(p.nom)}</h3>
      <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body"><div class="formgrid">
        <span><label>Désignation</label><input id="epNom" value="${esc(p.nom)}"></span>
        <span><label>Référence</label><input id="epRef" value="${esc(p.reference || '')}"></span>
        <span><label>Unité</label><input id="epUnite" value="${esc(p.unite)}" style="width:70px"></span>
        <span><label>Seuil alerte</label><input id="epAlerte" type="number" step="0.001" value="${p.stock_alerte}"></span>
        <span><label>Prix achat</label><input id="epAchat" type="number" step="0.01" value="${p.prix_achat}"></span>
        <span><label>Prix vente HT</label><input id="epVenteHT" type="number" step="0.01" value="${p.prix_vente}"></span>
        <span><label>Prix vente gros</label><input id="epVente" type="number" step="0.01" value="${p.prix_vente_gros}"></span>
        <span><label>TVA (%)</label><input id="epTva" type="number" step="0.1" value="${p.tva}"></span>
        <span><label>Fournisseur</label><select id="epFour">${frOpts}</select></span>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn sec" onclick="document.querySelector('.modal-bg').remove()">← Retour</button>
        <button class="btn" id="epSave">Enregistrer</button></div></div></div></div>`;
  $('epSave').onclick = async () => {
    try {
      await api('/produits/' + id, { method: 'PUT', body: JSON.stringify({
        nom: $('epNom').value, reference: $('epRef').value, unite: $('epUnite').value,
        stock_alerte: Number($('epAlerte').value || 0), prix_achat: Number($('epAchat').value || 0),
        prix_vente: Number($('epVenteHT').value || 0), prix_vente_gros: Number($('epVente').value || 0),
        tva: Number($('epTva').value || 0), fournisseur_id: $('epFour').value || null }) });
      toast('Produit modifié'); document.querySelector('.modal-bg').remove(); loadProduits();
    } catch (e) { toast(e.message, true); }
  };
};
window.approvProduit = async (id) => {
  const q = prompt('Quantité reçue :', ''); if (q === null) return;
  const pa = prompt('Prix d\'achat unitaire :', ''); if (pa === null) return;
  try { await api('/produits/' + id + '/approvisionner', { method: 'POST',
    body: JSON.stringify({ quantite: Number(q), prix_achat: Number(pa) }) });
    toast('Stock approvisionné (dette fournisseur + écriture comptable)'); loadProduits(); }
  catch (e) { toast(e.message, true); }
};
window.delProduit = async (id) => {
  if (!confirm('Supprimer ce produit ?')) return;
  try { await api('/produits/' + id, { method: 'DELETE' }); toast('Produit supprimé'); loadProduits(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Ventes en gros & enlèvements ───────────── */
async function pageGros() {
  $('pageTitle').textContent = 'Ventes en gros & enlèvements';
  const c = $('content');
  let clients = [], produits = [];
  try { [clients, produits] = await Promise.all([api('/clients'), api('/produits')]); } catch {}
  _grosProduits = produits;
  c.innerHTML = `<div class="panel"><h3>Vente en gros — créer & facturer</h3>
    <div class="formgrid">
      <span><label>Client</label><select id="gClient">
        ${clients.map(c => `<option value="${c.id}">${esc(c.nom)} — ${esc(c.immatriculation)}</option>`).join('')}</select></span>
      <span><label>Produit</label><select id="gProd">
        ${produits.map(p => `<option value="${p.id}" data-px="${p.prix_vente_gros || p.prix_vente || 0}" data-tva="${p.tva ?? 18}">${esc(p.nom)}</option>`).join('')}</select></span>
      <span><label>Quantité totale</label><input id="gQte" type="number" step="0.001" value="0"></span>
      <span><label>Prix unitaire</label><input id="gPrix" type="number" step="0.01" value="0"></span>
      <span><label>Règlement</label><select id="gReg">
        <option value="comptant">Payé comptant (prépayé)</option>
        <option value="partiel">Versement partiel (reste = crédit)</option>
        <option value="credit">Crédit total (à payer)</option></select></span>
      <span><label>Somme versée</label><input id="gPaye" type="number" step="0.01" value="0"></span>
      <span><label>Mode de règlement</label><input id="gMode" placeholder="Espèces, virement…"></span>
    </div>
    <div class="fa-totaux" id="gTotaux"></div>
    <div style="margin-top:10px"><button class="btn" id="gAdd">🧾 Créer, facturer & imprimer</button></div>
    <div class="hint">La marchandise est <b>facturée automatiquement</b> et <b>sortie du stock</b>.
      Selon la somme versée : un reste alimente la <b>dette (crédit)</b> du client, un trop-perçu son <b>relicat</b>.</div></div>
    <div class="panel"><h3>Comptes en gros & solde à enlever</h3><div id="gTable"><div class="hint">Chargement…</div></div></div>`;

  const recalcGros = () => {
    const opt = $('gProd').selectedOptions[0];
    const tva = opt ? Number(opt.dataset.tva || 18) : 18;
    const qte = Number($('gQte').value || 0), pu = Number($('gPrix').value || 0);
    const ht = qte * pu, ttc = ht * (1 + tva / 100);
    const reg = $('gReg').value;
    if (reg === 'comptant') $('gPaye').value = round2(ttc);
    else if (reg === 'credit') $('gPaye').value = 0;
    const paye = Number($('gPaye').value || 0);
    const reste = round2(ttc - paye);
    $('gTotaux').innerHTML = `
      <div class="row"><span>Montant HT</span><b>${money(ht)}</b></div>
      <div class="row"><span>TVA (${fmt(tva, 1)}%)</span><b>${money(ttc - ht)}</b></div>
      <div class="row ttc"><span>TOTAL TTC</span><b>${money(ttc)}</b></div>
      <div class="row ${reste > 0 ? 'neg' : 'pos'}"><span>${reste >= 0 ? 'Reste (crédit client)' : 'Trop-perçu (relicat)'}</span><b>${money(Math.abs(reste))}</b></div>`;
  };
  $('gProd').onchange = () => {
    const opt = $('gProd').selectedOptions[0];
    if (opt && opt.dataset.px && Number($('gPrix').value || 0) === 0) $('gPrix').value = opt.dataset.px;
    recalcGros();
  };
  ['gQte', 'gPrix', 'gPaye'].forEach(id => $(id).addEventListener('input', recalcGros));
  $('gReg').onchange = recalcGros;
  recalcGros();

  $('gAdd').onclick = async () => {
    const reg = $('gReg').value;
    const body = {
      entite_type: 'CLIENT', entite_id: Number($('gClient').value), produit_id: Number($('gProd').value),
      quantite_totale: Number($('gQte').value || 0), prix_unitaire: Number($('gPrix').value || 0),
      mode_paiement: $('gMode').value || (reg === 'comptant' ? 'Prépayé (gros)' : reg === 'credit' ? 'Crédit' : 'Versement partiel')
    };
    if (reg !== 'comptant') body.montant_paye = Number($('gPaye').value || 0);
    try { const r = await api('/commandes-gros', { method: 'POST', body: JSON.stringify(body) });
      toast(r.facture ? `Compte gros créé — facture ${r.facture.numero} générée, stock décrémenté` : 'Compte gros créé');
      if (r.facture?.id) imprimerFacture(r.facture.id);
      loadGros(); } catch (e) { toast(e.message, true); }
  };
  loadGros();
}
let _grosProduits = [];
let _grosRows = [];
async function loadGros() {
  try {
    const rows = await api('/commandes-gros');
    _grosRows = rows;
    $('gTable').innerHTML = rows.length ? `<table>
      <tr><th>Client</th><th>Produit</th><th>Total</th><th>Restant à enlever</th><th>Prix u.</th><th>Facture</th><th></th></tr>
      ${rows.map(g => `<tr>
        <td>${esc(g.entite_nom || '—')}</td><td>${esc(g.produit_nom || '—')}</td>
        <td>${fmt(g.quantite_totale)} ${esc(g.unite || '')}</td>
        <td class="${g.quantite_restante > 0 ? 'pos' : ''}">${fmt(g.quantite_restante)} ${esc(g.unite || '')}</td>
        <td>${money(g.prix_unitaire)}</td>
        <td>${g.facture_numero ? `<span class="sig-ok">🧾 ${esc(g.facture_numero)}</span>` : '—'}</td>
        <td class="row-actions">
          ${g.facture_id ? `<button class="btn sec" onclick="imprimerFacture(${g.facture_id})">🧾 Facture</button>` : ''}
          ${g.quantite_restante > 0
          ? `<button class="btn sec" onclick="enlever(${g.id})">📦 Enlèvement</button>` : '✔ soldé'}</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun compte en gros.</div>';
  } catch (e) { toast(e.message, true); }
}
window.enlever = (id) => {
  const g = _grosRows.find(x => x.id === id); if (!g) return;
  enlevementModal(
    { id: g.id, produit_nom: g.produit_nom, unite: g.unite, quantite_restante: g.quantite_restante },
    { nom: g.entite_nom }, loadGros);
};

/* ───────────── Facturation (n° de bon = clé maîtresse, lignes + TVA) ───────────── */
let _faClients = [], _faProduits = [], _faLignes = [];
async function pageFacturation() {
  $('pageTitle').textContent = 'Facturation';
  const c = $('content');
  try { [_faClients, _faProduits] = await Promise.all([api('/clients'), api('/produits')]); }
  catch { _faClients = []; _faProduits = []; }
  _faLignes = [];
  const clOpts = `<option value="">— Sans client —</option>` +
    _faClients.map(x => `<option value="${x.id}">${esc(x.nom)} — ${esc(x.immatriculation)}</option>`).join('');
  c.innerHTML = `
    <div class="panel"><h3>Charger un bon (clé maîtresse)</h3>
      <div class="hint">Saisissez le numéro du bon : le client, le produit, la quantité pesée,
        le prix unitaire et la TVA sont chargés automatiquement dans la facture.</div>
      <div class="filters" style="margin-top:10px">
        <span><label>N° de bon</label><input id="faBon" placeholder="Ex : 12 ou BC-1-0012"></span>
        <button class="btn" id="faLoadBon">📥 Charger le bon</button>
        <span id="faBonInfo" class="hint" style="align-self:center"></span>
      </div></div>

    <div class="panel"><h3>Nouvelle facture</h3>
      <div class="formgrid">
        <span><label>Client</label><select id="faClient">${clOpts}</select></span>
        <span><label>N° de bon (réf.)</label><input id="faBonRef" placeholder="Optionnel"></span>
        <span><label>Échéance</label><input id="faEch" type="date"></span>
        <span><label>Mode de règlement</label><input id="faMode" placeholder="Espèces, virement…"></span>
      </div>

      <h4 style="margin:16px 0 6px">Articles</h4>
      <div id="faLignesBox"></div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sec" id="faAddLigne">+ Ajouter une ligne</button>
        <button class="btn sec" id="faAddCat">+ Depuis le catalogue</button>
      </div>

      <div class="formgrid" style="margin-top:14px">
        <span><label>Remise globale (%)</label><input id="faRemise" type="number" step="0.1" value="0"></span>
        <span><label>Montant réglé</label><input id="faPaye" type="number" step="0.01" value="0"></span>
        <span style="flex:1"><label>Note / observation</label><input id="faNote" placeholder="Optionnel"></span>
      </div>

      <div class="fa-totaux" id="faTotaux"></div>
      <div style="margin-top:12px"><button class="btn" id="faAdd">🧾 Émettre la facture</button></div>
      <div class="hint">Le reste à payer alimente la dette du client ; un trop-perçu alimente son relicat.</div>
    </div>
    <div class="panel"><h3>Factures émises</h3><div id="faTable"><div class="hint">Chargement…</div></div></div>`;

  $('faLoadBon').onclick = chargerBonFacture;
  $('faBon').addEventListener('keydown', (e) => { if (e.key === 'Enter') chargerBonFacture(); });
  $('faAddLigne').onclick = () => { _faLignes.push({ designation: '', quantite: 1, unite: '', prix_unitaire: 0, remise: 0, tva: 18 }); renderLignes(); };
  $('faAddCat').onclick = ajouterDepuisCatalogue;
  ['faRemise', 'faPaye'].forEach(id => $(id).addEventListener('input', renderTotaux));
  $('faAdd').onclick = emettreFacture;
  renderLignes();
  loadFactures();
}

function renderLignes() {
  const box = $('faLignesBox'); if (!box) return;
  if (!_faLignes.length) { box.innerHTML = '<div class="hint">Aucune ligne. Chargez un bon ou ajoutez une ligne.</div>'; renderTotaux(); return; }
  box.innerHTML = `<table class="fa-lignes"><tr>
    <th>Désignation</th><th>Qté</th><th>Unité</th><th>P.U. HT</th><th>Remise %</th><th>TVA %</th><th>Total HT</th><th></th></tr>
    ${_faLignes.map((l, i) => {
      const ht = (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0) * (1 - (Number(l.remise) || 0) / 100);
      return `<tr>
        <td><input value="${esc(l.designation)}" oninput="majLigne(${i},'designation',this.value)" style="min-width:160px"></td>
        <td><input type="number" step="0.001" value="${l.quantite}" oninput="majLigne(${i},'quantite',this.value)" style="width:80px"></td>
        <td><input value="${esc(l.unite || '')}" oninput="majLigne(${i},'unite',this.value)" style="width:56px"></td>
        <td><input type="number" step="0.01" value="${l.prix_unitaire}" oninput="majLigne(${i},'prix_unitaire',this.value)" style="width:110px"></td>
        <td><input type="number" step="0.1" value="${l.remise || 0}" oninput="majLigne(${i},'remise',this.value)" style="width:72px"></td>
        <td><input type="number" step="0.1" value="${l.tva}" oninput="majLigne(${i},'tva',this.value)" style="width:72px"></td>
        <td class="r">${money(ht)}</td>
        <td><button class="btn danger" onclick="suppLigne(${i})">✕</button></td></tr>`;
    }).join('')}</table>`;
  renderTotaux();
}
window.majLigne = (i, champ, val) => { _faLignes[i][champ] = (champ === 'designation' || champ === 'unite') ? val : Number(val || 0); renderTotaux(); };
window.suppLigne = (i) => { _faLignes.splice(i, 1); renderLignes(); };

function calcTotaux() {
  let ht = 0, tva = 0;
  for (const l of _faLignes) {
    const base = (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0) * (1 - (Number(l.remise) || 0) / 100);
    ht += base; tva += base * (Number(l.tva) || 0) / 100;
  }
  const remG = Number($('faRemise')?.value || 0);
  const ratio = 1 - remG / 100;
  ht *= ratio; tva *= ratio;
  return { ht, tva, ttc: ht + tva };
}
function renderTotaux() {
  const box = $('faTotaux'); if (!box) return;
  const t = calcTotaux();
  const paye = Number($('faPaye')?.value || 0);
  const reste = t.ttc - paye;
  box.innerHTML = `
    <div class="row"><span>Total HT</span><b>${money(t.ht)}</b></div>
    <div class="row"><span>Total TVA</span><b>${money(t.tva)}</b></div>
    <div class="row ttc"><span>NET À PAYER (TTC)</span><b>${money(t.ttc)}</b></div>
    <div class="row ${reste > 0 ? 'neg' : 'pos'}"><span>${reste >= 0 ? 'Reste à payer' : 'Trop-perçu'}</span><b>${money(Math.abs(reste))}</b></div>`;
}

async function chargerBonFacture() {
  const num = $('faBon').value.trim();
  if (!num) return toast('Saisissez un numéro de bon', true);
  try {
    const d = await api('/factures/depuis-bon/' + encodeURIComponent(num));
    _faLignes = d.lignes.map(l => ({ ...l }));
    if (d.client) $('faClient').value = String(d.client.id);
    $('faBonRef').value = d.bon.reference || String(d.bon.numero || num);
    const info = $('faBonInfo');
    info.innerHTML = `Bon #${esc(String(d.bon.numero ?? ''))} — ${esc(d.bon.client || '—')} · ${esc(d.bon.produit || '—')} · ${fmt(d.bon.quantite)} ${esc(d.bon.unite || '')}`
      + (d.dejaFacture ? ` <span class="neg">⚠ déjà facturé (${esc(d.dejaFacture)})</span>` : '');
    renderLignes();
    toast('Bon chargé dans la facture');
  } catch (e) { toast(e.message, true); $('faBonInfo').textContent = ''; }
}

function ajouterDepuisCatalogue() {
  if (!_faProduits.length) return toast('Aucun produit au catalogue', true);
  const opts = _faProduits.map(p => `<option value="${p.id}">${esc(p.nom)} — ${money(p.prix_vente)} HT (TVA ${fmt(p.tva, 1)}%)</option>`).join('');
  $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
    <div class="modal"><div class="modal-head"><h3>Ajouter un article</h3>
      <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body"><div class="formgrid">
        <span><label>Produit</label><select id="catProd">${opts}</select></span>
        <span><label>Quantité</label><input id="catQte" type="number" step="0.001" value="1"></span>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn sec" onclick="document.querySelector('.modal-bg').remove()">← Retour</button>
        <button class="btn" id="catAdd">Ajouter</button></div></div></div></div>`;
  $('catAdd').onclick = () => {
    const p = _faProduits.find(x => x.id === Number($('catProd').value)); if (!p) return;
    _faLignes.push({ produit_id: p.id, designation: p.nom, quantite: Number($('catQte').value || 1),
      unite: p.unite, prix_unitaire: p.prix_vente || p.prix_vente_gros || 0, remise: 0, tva: p.tva });
    document.querySelector('.modal-bg').remove(); renderLignes();
  };
}

async function emettreFacture() {
  if (!_faLignes.length) return toast('Ajoutez au moins une ligne', true);
  try {
    const r = await api('/factures', { method: 'POST', body: JSON.stringify({
      client_id: $('faClient').value || null, numero_bon: $('faBonRef').value || null,
      echeance: $('faEch').value || null, mode_paiement: $('faMode').value || null,
      remise_globale: Number($('faRemise').value || 0), montant_paye: Number($('faPaye').value || 0),
      note: $('faNote').value, lignes: _faLignes }) });
    toast(`Facture ${r.numero} émise`);
    _faLignes = []; $('faBon').value = $('faBonRef').value = $('faNote').value = ''; $('faPaye').value = '0';
    $('faBonInfo').textContent = ''; renderLignes(); loadFactures();
    imprimerFacture(r.id);
  } catch (e) { toast(e.message, true); }
}

const FA_STATUT = { emise: ['Émise', 'st-recu'], partielle: ['Partielle', 'st-encours'], payee: ['Payée', 'st-termine'], annulee: ['Annulée', 'st-annule'] };
async function loadFactures() {
  try {
    const rows = await api('/factures');
    $('faTable').innerHTML = rows.length ? `<table>
      <tr><th>N°</th><th>Date</th><th>Bon</th><th>Client</th><th>HT</th><th>TVA</th><th>TTC</th><th>Réglé</th><th>Reste</th><th>Statut</th><th></th></tr>
      ${rows.map(f => {
        const s = FA_STATUT[f.statut] || ['—', ''];
        return `<tr>
        <td>${esc(f.numero)}</td><td>${esc((f.date || '').slice(0, 16))}</td><td>${esc(f.numero_bon || '—')}</td>
        <td>${esc(f.client_nom_ref || f.client_nom || '—')}</td>
        <td>${money(f.montant_ht)}</td><td>${money(f.montant_tva)}</td><td>${money(f.montant_total)}</td>
        <td>${money(f.montant_paye)}</td>
        <td class="${f.relicat > 0 ? 'neg' : 'pos'}">${money(f.relicat)}</td>
        <td><span class="badge ${s[1]}">${s[0]}</span></td>
        <td class="row-actions"><button class="btn sec" onclick="imprimerFacture(${f.id})">Imprimer</button></td>
      </tr>`; }).join('')}</table>` : '<div class="hint">Aucune facture émise.</div>';
  } catch (e) { toast(e.message, true); }
}
window.imprimerFacture = (id) => window.open(`/api/factures/${id}/imprimer?token=${encodeURIComponent(S.token)}`, '_blank');
window.imprimerBon = (id) => window.open(`/api/bons-commande/${id}/imprimer?token=${encodeURIComponent(S.token)}`, '_blank');

/* ───────────── Relicat / Créances ───────────── */
async function pageRelicat() {
  $('pageTitle').textContent = 'Relicat / Créances clients';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Situation harmonisée des clients</h3>
    <div class="hint">Solde net = dette − relicat. Cliquez « Détail » pour le relevé des factures
      (reste à payer) et l'historique des règlements. Un règlement solde la dette puis verse
      l'excédent en relicat (acompte).</div>
    <div class="filters" style="margin-top:8px"><input id="reSearch" placeholder="🔎 Rechercher un client (nom / code)…" style="flex:1"></div>
    <div id="reTable"><div class="hint">Chargement…</div></div></div>`;
  $('reSearch').addEventListener('input', renderRelicat);
  loadRelicat();
}
let _relicatRows = [];
async function loadRelicat() {
  try { _relicatRows = await api('/relicat'); renderRelicat(); }
  catch (e) { toast(e.message, true); }
}
function renderRelicat() {
  const q = ($('reSearch')?.value || '').trim().toLowerCase();
  const rows = _relicatRows.filter(x => !q
    || (x.nom || '').toLowerCase().includes(q) || (x.immatriculation || '').toLowerCase().includes(q));
  $('reTable').innerHTML = rows.length ? `<table>
    <tr><th>Client</th><th>Code</th><th>Téléphone</th><th>Dette</th><th>Relicat</th><th>Solde net</th><th></th></tr>
    ${rows.map(x => {
      const net = round2((x.solde_dette || 0) - (x.solde_relicat || 0));
      return `<tr>
        <td>${esc(x.nom)}</td><td><span class="keybox">${esc(x.immatriculation)}</span></td>
        <td>${esc(x.telephone || '')}</td>
        <td class="${x.solde_dette > 0 ? 'neg' : ''}">${money(x.solde_dette)}</td>
        <td class="${x.solde_relicat > 0 ? 'pos' : ''}">${money(x.solde_relicat)}</td>
        <td class="${net > 0 ? 'neg' : net < 0 ? 'pos' : ''}"><b>${money(Math.abs(net))}</b> ${net > 0 ? 'dû' : net < 0 ? 'avance' : ''}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="detailRelicat(${x.id})">Détail</button>
          <button class="btn sec" onclick="reglerClient(${x.id})">Encaisser</button></td>
      </tr>`; }).join('')}</table>` : '<div class="hint">Aucune dette ni relicat en cours.</div>';
}
window.detailRelicat = async (id) => {
  try {
    const d = await api(`/relicat/${id}/detail`);
    const FA = { emise: 'Émise', partielle: 'Partielle', payee: 'Payée', annulee: 'Annulée' };
    const facs = d.factures.length ? `<table>
      <tr><th>N°</th><th>Date</th><th>Bon</th><th>TTC</th><th>Réglé</th><th>Reste</th><th>Statut</th><th></th></tr>
      ${d.factures.map(f => `<tr>
        <td>${esc(f.numero)}</td><td>${esc((f.date || '').slice(0, 10))}</td><td>${esc(f.numero_bon || '—')}</td>
        <td>${money(f.montant_total)}</td><td>${money(f.montant_paye)}</td>
        <td class="${f.relicat > 0 ? 'neg' : 'pos'}">${money(f.relicat)}</td>
        <td>${FA[f.statut] || f.statut}</td>
        <td><button class="btn sec" onclick="imprimerFacture(${f.id})">🖨</button></td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucune facture.</div>';
    const regs = d.reglements.length ? `<table>
      <tr><th>Date</th><th>Montant</th><th>Détail</th></tr>
      ${d.reglements.map(r => `<tr><td>${esc((r.date || '').slice(0, 16))}</td>
        <td class="pos">${money(r.montant)}</td><td>${esc(r.description || '')}</td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun règlement enregistré.</div>';
    $('modalHost').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)this.remove()">
      <div class="modal" style="max-width:760px"><div class="modal-head">
        <h3>Situation — ${esc(d.client.nom)} (${esc(d.client.immatriculation)})</h3>
        <button class="modal-x" onclick="document.querySelector('.modal-bg').remove()">✕</button></div>
      <div class="modal-body">
        <div class="kpis">
          <div class="kpi"><div class="v">${money(d.totalFacture)}</div><div class="l">Total facturé</div></div>
          <div class="kpi"><div class="v">${money(d.totalRegle)}</div><div class="l">Total réglé</div></div>
          <div class="kpi"><div class="v">${money(d.client.solde_dette)}</div><div class="l">Dette</div></div>
          <div class="kpi"><div class="v">${money(d.client.solde_relicat)}</div><div class="l">Relicat (avance)</div></div>
          <div class="kpi"><div class="v">${money(Math.abs(d.solde_net))} ${d.solde_net > 0 ? 'dû' : d.solde_net < 0 ? 'avance' : ''}</div><div class="l">Solde net</div></div>
        </div>
        <h4 style="margin:16px 0 6px">Relevé de facturation</h4>${facs}
        <h4 style="margin:16px 0 6px">Règlements encaissés</h4>${regs}
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn sec" onclick="document.querySelector('.modal-bg').remove()">← Fermer</button>
          <button class="btn" onclick="document.querySelector('.modal-bg').remove();reglerClient(${id})">Encaisser un règlement</button></div>
      </div></div></div>`;
  } catch (e) { toast(e.message, true); }
};
window.reglerClient = async (id) => {
  const m = prompt('Montant encaissé :', ''); if (m === null) return;
  try { await api('/relicat/reglement', { method: 'POST', body: JSON.stringify({ client_id: id, montant: Number(m) }) });
    toast('Règlement enregistré'); loadRelicat(); } catch (e) { toast(e.message, true); }
};

/* ───────────── Recherche globale (factures / bons / enlèvements / stock) ───────────── */
async function pageRecherche() {
  $('pageTitle').textContent = 'Recherche & réimpression';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Rechercher</h3>
    <div class="hint">Retrouvez une facture, un bon, un enlèvement ou un produit (stock en cours)
      par numéro, client, immatriculation ou produit — puis réimprimez.</div>
    <div class="filters" style="margin-top:10px">
      <input id="rqInput" placeholder="N° facture / bon, client, immatriculation, produit…" style="flex:1">
      <button class="btn" id="rqGo">🔎 Rechercher</button></div>
    <div id="rqResults"><div class="hint">Saisissez un terme puis lancez la recherche.</div></div></div>`;
  $('rqGo').onclick = lancerRecherche;
  $('rqInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') lancerRecherche(); });
  $('rqInput').focus();
}
async function lancerRecherche() {
  const q = $('rqInput').value.trim();
  if (!q) return toast('Saisissez un terme de recherche', true);
  try {
    const d = await api('/recherche?q=' + encodeURIComponent(q));
    const FA = { emise: 'Émise', partielle: 'Partielle', payee: 'Payée', annulee: 'Annulée' };
    const sFac = d.factures.length ? `<table>
      <tr><th>N°</th><th>Date</th><th>Bon</th><th>Client</th><th>TTC</th><th>Reste</th><th>Statut</th><th></th></tr>
      ${d.factures.map(f => `<tr>
        <td>${esc(f.numero)}</td><td>${esc((f.date || '').slice(0, 10))}</td><td>${esc(f.numero_bon || '—')}</td>
        <td>${esc(f.client_nom || '—')}</td><td>${money(f.montant_total)}</td>
        <td class="${f.relicat > 0 ? 'neg' : 'pos'}">${money(f.relicat)}</td><td>${FA[f.statut] || f.statut}</td>
        <td><button class="btn sec" onclick="imprimerFacture(${f.id})">🖨 Réimprimer</button></td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucune facture.</div>';
    const sBon = d.bons.length ? `<table>
      <tr><th>N°</th><th>Référence</th><th>Client</th><th>Produit</th><th>Immat.</th><th>Qté</th><th>Statut</th><th></th></tr>
      ${d.bons.map(b => `<tr>
        <td>${b.numero != null ? '#' + b.numero : '—'}</td><td>${esc(b.reference)}</td>
        <td>${esc(b.client || '—')}</td><td>${esc(b.produit || '—')}</td><td>${esc(b.immatriculation || '—')}</td>
        <td>${fmt(b.quantite_prevue)}</td><td>${esc(b.statut)}</td>
        <td><button class="btn sec" onclick="imprimerBon(${b.id})">🖨 Réimprimer</button></td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun bon.</div>';
    const sEnl = d.enlevements.length ? `<table>
      <tr><th>Bon</th><th>Date</th><th>Client</th><th>Produit</th><th>Quantité</th><th></th></tr>
      ${d.enlevements.map(e => `<tr>
        <td>${esc(e.bon_numero || '—')}</td><td>${esc((e.date || '').slice(0, 16))}</td>
        <td>${esc(e.entite_nom || '—')}</td><td>${esc(e.produit_nom || '—')}</td>
        <td>${fmt(e.quantite_enlevee)} ${esc(e.unite || '')}</td>
        <td>${e.bon_id ? `<button class="btn sec" onclick="imprimerBon(${e.bon_id})">🖨 Réimprimer</button>` : '—'}</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun enlèvement.</div>';
    const sProd = d.produits.length ? `<table>
      <tr><th>Produit</th><th>Réf.</th><th>Stock actuel</th><th>Prix vente</th><th>Prix gros</th><th>TVA</th></tr>
      ${d.produits.map(p => `<tr>
        <td>${esc(p.nom)}</td><td>${esc(p.reference || '—')}</td>
        <td class="${p.stock_actuel > 0 ? 'pos' : 'neg'}">${fmt(p.stock_actuel)} ${esc(p.unite || '')}</td>
        <td>${money(p.prix_vente)}</td><td>${money(p.prix_vente_gros)}</td><td>${fmt(p.tva, 1)}%</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun produit.</div>';
    $('rqResults').innerHTML = `
      <h3 style="margin-top:16px">🧾 Factures</h3>${sFac}
      <h3 style="margin-top:16px">📤 Bons / enlèvements</h3>${sBon}
      <h3 style="margin-top:16px">📦 Enlèvements (bons d'enlèvement)</h3>${sEnl}
      <h3 style="margin-top:16px">📦 Stock en cours</h3>${sProd}`;
  } catch (e) { toast(e.message, true); }
}

/* ───────────── Paramètres de facturation (identité légale) ───────────── */
async function pageParametres() {
  $('pageTitle').textContent = 'Paramètres de facturation';
  const c = $('content');
  let p = {};
  try { p = await api('/parametres'); } catch (e) { toast(e.message, true); }
  c.innerHTML = `<div class="panel"><h3>Logo de l'entreprise</h3>
    <div class="hint">Le logo apparaît en en-tête de vos factures et bons imprimés (PNG, JPG, WEBP ou SVG, max 2 Mo).</div>
    <div style="display:flex;align-items:center;gap:18px;margin-top:12px">
      <div id="prLogoBox" style="width:160px;height:90px;border:1px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden">
        ${p.logo ? `<img src="${esc(p.logo)}" style="max-width:100%;max-height:100%;object-fit:contain">` : '<span class="hint">Aucun logo</span>'}</div>
      <div>
        <input type="file" id="prLogoFile" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="margin-bottom:8px">
        <div style="display:flex;gap:8px">
          <button class="btn sec" id="prLogoUp">Téléverser</button>
          <button class="btn danger" id="prLogoDel" ${p.logo ? '' : 'disabled'}>Retirer</button>
        </div>
      </div>
    </div></div>
    <div class="panel"><h3>Identité de l'entreprise (en-tête des factures)</h3>
    <div class="hint">Ces informations apparaissent sur toutes vos factures (mentions légales).</div>
    <div class="formgrid" style="margin-top:12px">
      <span style="flex:1 1 100%"><label>Raison sociale</label><input id="prRS" value="${esc(p.raison_sociale || p.nom || '')}"></span>
      <span style="flex:1 1 100%"><label>Adresse</label><input id="prAdr" value="${esc(p.adresse || '')}"></span>
      <span><label>Ville</label><input id="prVille" value="${esc(p.ville || '')}"></span>
      <span><label>Téléphone</label><input id="prTel" value="${esc(p.telephone || '')}"></span>
      <span><label>Email</label><input id="prMail" value="${esc(p.email || '')}"></span>
      <span><label>NINEA</label><input id="prNinea" value="${esc(p.ninea || '')}"></span>
      <span><label>RCCM</label><input id="prRccm" value="${esc(p.rccm || '')}"></span>
      <span><label>Devise</label><input id="prDev" value="${esc(p.devise || 'FCFA')}" style="width:90px"></span>
      <span><label>TVA par défaut (%)</label><input id="prTva" type="number" step="0.1" value="${p.tva_defaut ?? 18}"></span>
      <span style="flex:1 1 100%"><label>Pied de page facture</label><input id="prPied" value="${esc(p.pied_facture || '')}" placeholder="Mentions, conditions de règlement…"></span>
    </div>
    <div style="margin-top:12px"><button class="btn" id="prSave">Enregistrer</button></div></div>`;
  $('prSave').onclick = async () => {
    try {
      await api('/parametres', { method: 'PUT', body: JSON.stringify({
        raison_sociale: $('prRS').value, adresse: $('prAdr').value, ville: $('prVille').value,
        telephone: $('prTel').value, email: $('prMail').value, ninea: $('prNinea').value,
        rccm: $('prRccm').value, devise: $('prDev').value, tva_defaut: Number($('prTva').value || 18),
        pied_facture: $('prPied').value }) });
      toast('Paramètres enregistrés');
    } catch (e) { toast(e.message, true); }
  };
  $('prLogoUp').onclick = () => {
    const f = $('prLogoFile').files[0];
    if (!f) return toast('Choisissez un fichier image', true);
    if (f.size > 2 * 1024 * 1024) return toast('Logo trop volumineux (max 2 Mo)', true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api('/parametres/logo', { method: 'POST', body: JSON.stringify({ dataUrl: reader.result }) });
        $('prLogoBox').innerHTML = `<img src="${esc(r.logo)}?t=${Date.now()}" style="max-width:100%;max-height:100%;object-fit:contain">`;
        $('prLogoDel').disabled = false;
        toast('Logo enregistré');
      } catch (e) { toast(e.message, true); }
    };
    reader.readAsDataURL(f);
  };
  $('prLogoDel').onclick = async () => {
    try { await api('/parametres/logo', { method: 'DELETE' });
      $('prLogoBox').innerHTML = '<span class="hint">Aucun logo</span>';
      $('prLogoDel').disabled = true; toast('Logo retiré');
    } catch (e) { toast(e.message, true); }
  };
}

/* ───────────── Comptabilité ───────────── */
async function pageCompta() {
  $('pageTitle').textContent = 'Comptabilité';
  const c = $('content');
  c.innerHTML = `<div class="panel">
    <div class="filters">
      <label>Du</label><input type="date" id="coFrom" value="${firstOfMonth()}">
      <label>au</label><input type="date" id="coTo" value="${today()}">
      <button class="btn sec" id="coGo">Actualiser</button>
    </div>
    <div class="kpis" id="coKpis"></div></div>
    <div class="panel"><h3>Écriture manuelle (recette / dépense)</h3>
    <div class="filters">
      <span><label>Type</label><select id="coType"><option value="ENTREE">Entrée (recette)</option>
        <option value="SORTIE">Sortie (dépense)</option></select></span>
      <span><label>Catégorie</label><input id="coCat" placeholder="Ex: Loyer, Carburant…"></span>
      <span><label>Montant</label><input id="coMontant" type="number" step="0.01" value="0"></span>
      <span style="flex:1"><label>Description</label><input id="coDesc" placeholder="Détail"></span>
      <button class="btn sec" id="coAdd">Enregistrer</button>
    </div></div>
    <div class="panel"><h3>Journal des mouvements</h3><div id="coTable"><div class="hint">Chargement…</div></div></div>`;
  $('coGo').onclick = loadCompta;
  $('coAdd').onclick = async () => {
    try { await api('/comptabilite', { method: 'POST', body: JSON.stringify({
      type: $('coType').value, categorie: $('coCat').value, montant: Number($('coMontant').value || 0),
      description: $('coDesc').value }) });
      toast('Écriture enregistrée'); $('coCat').value = $('coDesc').value = ''; $('coMontant').value = '0'; loadCompta(); }
    catch (e) { toast(e.message, true); }
  };
  loadCompta();
}
async function loadCompta() {
  const qs = `?from=${$('coFrom').value}&to=${$('coTo').value}`;
  try {
    const [resume, rows] = await Promise.all([api('/comptabilite/resume' + qs), api('/comptabilite' + qs)]);
    $('coKpis').innerHTML = [
      ['Total entrées', money(resume.totalEntrees)], ['Total sorties', money(resume.totalSorties)],
      ['Solde de caisse', money(resume.solde)]
    ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    $('coTable').innerHTML = rows.length ? `<table>
      <tr><th>Date</th><th>Type</th><th>Catégorie</th><th>Description</th><th>Tiers</th><th>Montant</th></tr>
      ${rows.map(m => `<tr>
        <td>${esc((m.date || '').slice(0, 16))}</td>
        <td><span class="tag ${m.type === 'ENTREE' ? 'on' : 'off'}">${m.type === 'ENTREE' ? 'Entrée' : 'Sortie'}</span></td>
        <td>${esc(m.categorie || '')}</td><td>${esc(m.description || '')}</td>
        <td>${esc(m.client_nom || m.fournisseur_nom || '—')}</td>
        <td class="${m.type === 'ENTREE' ? 'pos' : 'neg'}">${m.type === 'ENTREE' ? '+' : '−'}${money(m.montant)}</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun mouvement sur cette période.</div>';
  } catch (e) { toast(e.message, true); }
}

/* ───────────── Rapports ───────────── */
async function pageCaisse() {
  $('pageTitle').textContent = 'Caisse du jour';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  await renderCaisse();
}
async function renderCaisse() {
  const c = $('content');
  try {
    const d = await api('/caisse/jour');
    const caisse = d.caisse;
    const dispo = round2(d.theorique);
    let bloc;
    if (!caisse) {
      bloc = `<div class="panel"><h3>Ouvrir la caisse — ${esc(d.jour)}</h3>
        <div class="hint">Saisissez le fond de caisse (espèces en début de journée).</div>
        <div class="filters" style="margin-top:8px">
          <span><label>Fond de caisse</label><input id="caFond" type="number" min="0" value="0"></span>
          <button class="btn" id="caOpen">Ouvrir la caisse</button>
        </div></div>`;
    } else if (caisse.statut === 'ouverte') {
      bloc = `<div class="panel"><h3>Caisse ouverte — ${esc(d.jour)}</h3>
        <div class="kpis">
          <div class="kpi"><div class="v">${money(caisse.fond_ouverture)}</div><div class="l">Fond d'ouverture</div></div>
          <div class="kpi"><div class="v" style="color:#16a34a">${money(d.entrees)}</div><div class="l">Entrées du jour</div></div>
          <div class="kpi"><div class="v" style="color:#b91c1c">${money(d.sorties)}</div><div class="l">Sorties du jour</div></div>
          <div class="kpi"><div class="v">${money(dispo)}</div><div class="l">Théorique en caisse</div></div>
        </div>
        <h3 style="margin-top:14px">Clôturer la caisse</h3>
        <div class="hint">Comptez les espèces réelles ; l'écart avec le théorique sera enregistré.</div>
        <div class="filters" style="margin-top:8px">
          <span><label>Montant compté</label><input id="caCompte" type="number" min="0" value="${dispo}"></span>
          <span><label>Note</label><input id="caNote" placeholder="Optionnel"></span>
          <button class="btn" id="caClose">Clôturer</button>
        </div>
        <div class="hint" id="caEcart" style="margin-top:6px"></div></div>`;
    } else {
      const ec = caisse.ecart || 0;
      bloc = `<div class="panel"><h3>Caisse clôturée — ${esc(d.jour)}</h3>
        <div class="kpis">
          <div class="kpi"><div class="v">${money(caisse.fond_ouverture)}</div><div class="l">Fond d'ouverture</div></div>
          <div class="kpi"><div class="v">${money(dispo)}</div><div class="l">Théorique</div></div>
          <div class="kpi"><div class="v">${money(caisse.montant_compte)}</div><div class="l">Compté</div></div>
          <div class="kpi"><div class="v" style="color:${ec === 0 ? '#16a34a' : '#b91c1c'}">${money(ec)}</div><div class="l">Écart</div></div>
        </div>
        ${caisse.note ? `<div class="hint">Note : ${esc(caisse.note)}</div>` : ''}
        <div class="hint">Clôturée par ${esc(caisse.ferme_par || '')} le ${esc((caisse.closed_at || '').slice(0, 16))}.</div></div>`;
    }
    c.innerHTML = bloc + '<div class="panel"><h3>Historique des caisses</h3><div id="caHist"></div></div>';
    const open = $('caOpen'); if (open) open.onclick = ouvrirCaisse;
    const close = $('caClose'); if (close) {
      const maj = () => { const v = Number($('caCompte').value) || 0; $('caEcart').textContent = 'Écart : ' + money(round2(v - dispo)); };
      $('caCompte').oninput = maj; maj();
      close.onclick = () => fermerCaisse(dispo);
    }
    loadCaisseHist();
  } catch (e) { toast(e.message, true); c.innerHTML = `<div class="panel"><div class="hint">${esc(e.message)}</div></div>`; }
}
async function ouvrirCaisse() {
  try { await api('/caisse/ouvrir', { method: 'POST', body: JSON.stringify({ fondOuverture: Number($('caFond').value) || 0 }) });
    toast('Caisse ouverte'); renderCaisse(); }
  catch (e) { toast(e.message, true); }
}
async function fermerCaisse() {
  try {
    const r = await api('/caisse/fermer', { method: 'POST', body: JSON.stringify({ montantCompte: Number($('caCompte').value) || 0, note: $('caNote').value }) });
    toast('Caisse clôturée — écart ' + money(r.ecart)); renderCaisse();
  } catch (e) { toast(e.message, true); }
}
async function loadCaisseHist() {
  try {
    const rows = await api('/caisse/historique');
    $('caHist').innerHTML = rows.length ? `<table>
      <tr><th>Jour</th><th>Statut</th><th class="r">Fond</th><th class="r">Compté</th><th class="r">Écart</th><th>Par</th></tr>
      ${rows.map(x => `<tr><td>${esc(x.jour)}</td>
        <td><span class="tag ${x.statut === 'fermee' ? 'on' : 'off'}">${x.statut}</span></td>
        <td class="r">${money(x.fond_ouverture)}</td><td class="r">${x.montant_compte != null ? money(x.montant_compte) : '—'}</td>
        <td class="r">${x.ecart != null ? money(x.ecart) : '—'}</td><td>${esc(x.ferme_par || x.ouvert_par || '')}</td></tr>`).join('')}</table>`
      : '<div class="hint">Aucune caisse enregistrée.</div>';
  } catch (e) { toast(e.message, true); }
}

async function pageRapports() {
  $('pageTitle').textContent = 'Rapports';
  const c = $('content');
  c.innerHTML = `<div class="panel">
    <div class="filters"><label>Date</label><input type="date" id="rDate" value="${today()}">
      <button class="btn sec" id="rGo">Générer</button>
      <button class="btn sec" id="rPrint">🖨 Imprimer</button></div>
    <div class="kpis" id="rKpis"></div>
    <h3>Répartition par produit</h3><div id="rProd"></div>
    <h3 style="margin-top:16px">Répartition par client</h3><div id="rCli"></div></div>`;
  $('rGo').onclick = loadStats; $('rPrint').onclick = () => window.print();
  loadStats();
}
async function loadStats() {
  try {
    const s = await api(`/stats?date=${$('rDate').value}`);
    $('rKpis').innerHTML = [
      ['Camions', s.nbCamions], ['Total tonnes', fmt(s.totalTonnes)],
      ['Moyenne/camion', fmt(s.moyenneTonnes)], ['Chiffre d\'affaires', fmt(s.chiffreAffaires, 2)]
    ].map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    const tbl = (obj) => Object.keys(obj).length ? `<table><tr><th>Libellé</th><th>Total (t)</th></tr>
      ${Object.entries(obj).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('')}</table>`
      : '<div class="hint">—</div>';
    $('rProd').innerHTML = tbl(s.parProduit);
    $('rCli').innerHTML = tbl(s.parClient);
  } catch (e) { toast(e.message, true); }
}

/* ───────────── Utilisateurs & rôles ───────────── */
async function pageUsers() {
  $('pageTitle').textContent = 'Utilisateurs & rôles';
  const c = $('content');
  const superA = S.user.role === 'superadmin';
  let distribSelect = '';
  if (superA) {
    const ds = await api('/admin/distributeurs');
    distribSelect = `<label>Espace distributeur</label><select id="uDistrib">
      ${ds.map(d => `<option value="${d.id}">${esc(d.nom)}</option>`).join('')}</select>`;
  }
  c.innerHTML = `<div class="panel"><h3>Créer un utilisateur</h3>
    <div class="filters">
      ${distribSelect}
      <span><label>Identifiant</label><input id="uName" placeholder="login"></span>
      <span><label>Nom complet</label><input id="uFull" placeholder="Nom"></span>
      <span><label>Mot de passe</label><input id="uPass" type="text" placeholder="min 6 car."></span>
      <span><label>Rôle</label><select id="uRole">
        <option value="vendeur">Vendeur</option>
        <option value="stockiste">Stockiste</option>
        <option value="comptable">Comptable</option>
        <option value="assistante">Assistante</option>
        <option value="superviseur">Superviseur</option>
        <option value="admin">Administrateur</option></select></span>
      <button class="btn sec" id="uAdd">Ajouter</button>
    </div></div>
    <div class="panel"><h3>Utilisateurs</h3><div id="uTable"><div class="hint">Chargement…</div></div></div>`;
  $('uAdd').onclick = addUser;
  if (superA) $('uDistrib').onchange = loadUsers;
  loadUsers();
}
async function loadUsers() {
  const superA = S.user.role === 'superadmin';
  const did = superA ? `?distributeurId=${$('uDistrib').value}` : '';
  try {
    const rows = await api('/admin/users' + did);
    $('uTable').innerHTML = `<table>
      <tr><th>Identifiant</th><th>Nom</th><th>Rôle</th><th>Statut</th><th></th></tr>
      ${rows.map(u => `<tr>
        <td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td>
        <td><span class="tag ${u.role}">${ROLE_LABEL[u.role] || u.role}</span></td>
        <td><span class="tag ${u.actif ? 'on' : 'off'}">${u.actif ? 'Actif' : 'Inactif'}</span></td>
        <td class="row-actions">
          <button class="btn sec" onclick="toggleUser(${u.id},${u.actif ? 0 : 1})">${u.actif ? 'Désactiver' : 'Activer'}</button>
          <button class="btn danger" onclick="delUser(${u.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`;
  } catch (e) { toast(e.message, true); }
}
async function addUser() {
  const superA = S.user.role === 'superadmin';
  const body = {
    username: $('uName').value, fullName: $('uFull').value,
    password: $('uPass').value, role: $('uRole').value
  };
  if (superA) body.distributeurId = Number($('uDistrib').value);
  try { await api('/admin/users', { method: 'POST', body: JSON.stringify(body) });
    toast('Utilisateur créé'); $('uName').value = $('uFull').value = $('uPass').value = ''; loadUsers(); }
  catch (e) { toast(e.message, true); }
}
window.toggleUser = async (id, actif) => {
  try { await api('/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ actif }) }); loadUsers(); }
  catch (e) { toast(e.message, true); }
};
window.delUser = async (id) => {
  if (!confirm('Supprimer cet utilisateur ?')) return;
  try { await api('/admin/users/' + id, { method: 'DELETE' }); loadUsers(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Administration (super-admin) ───────────── */
async function pageAdmin() {
  $('pageTitle').textContent = 'Administration mGlobal';
  const c = $('content');
  c.innerHTML = `
    <div class="panel"><h3>Liaison du poste pont bascule</h3>
      <div class="hint">Collez l'URL ci-dessous et la <b>clé de liaison</b> dans mGlobal
        (Paramètres → 🌐 Accès distant → Lier à la plateforme cloud).</div>
      <div style="margin:10px 0"><label>URL de la plateforme</label>
        <div class="keybox" id="platUrl"></div></div>
      <div id="sites"></div></div>
    <div class="panel"><h3>Boutiques (espaces)</h3>
      <div class="hint">Une boutique appartient à un propriétaire (dans la limite de son quota).</div>
      <div class="filters" style="margin-top:10px">
        <span><label>Propriétaire</label><select id="dProp"></select></span>
        <span><label>Nom de la boutique</label><input id="dNom" placeholder="Ex : Boutique Centre-ville"></span>
        <span><label>Nature</label><select id="dNature">
          <option value="habillement">Habillement</option>
          <option value="epicerie">Épicerie</option>
          <option value="depot">Dépôt</option>
          <option value="autre" selected>Autre</option></select></span>
        <button class="btn sec" id="dAdd">Créer la boutique</button></div>
      <div id="dTable"><div class="hint">Chargement…</div></div></div>
    <div class="panel"><h3>Mon mot de passe (super-admin)</h3>
      <div class="hint">Modifiez le mot de passe du compte super-admin mGlobal.</div>
      <div class="filters" style="margin-top:10px">
        <input id="pwCur" type="password" placeholder="Mot de passe actuel">
        <input id="pwNew" type="password" placeholder="Nouveau mot de passe (min. 6)">
        <input id="pwConf" type="password" placeholder="Confirmer le nouveau">
        <button class="btn sec" id="pwSave">Modifier</button></div></div>`;
  $('platUrl').textContent = location.origin;
  $('pwSave').onclick = changePassword;
  $('dAdd').onclick = async () => {
    if (!$('dProp').value) return toast('Créez d\'abord un propriétaire', true);
    try {
      await api('/admin/distributeurs', { method: 'POST', body: JSON.stringify({
        nom: $('dNom').value, proprietaireId: Number($('dProp').value), nature: $('dNature').value }) });
      toast('Boutique créée'); $('dNom').value = ''; loadDistribs();
    } catch (e) { toast(e.message, true); }
  };
  loadSites(); loadDistribProps(); loadDistribs();
}
async function loadDistribProps() {
  try {
    const ps = await api('/admin/proprietaires');
    $('dProp').innerHTML = ps.length
      ? ps.map(p => `<option value="${p.id}">${esc(p.nom)} (${p.nbBoutiques}/${p.quota_boutiques})</option>`).join('')
      : '<option value="">— aucun propriétaire —</option>';
  } catch (e) { toast(e.message, true); }
}
async function loadSites() {
  try {
    const sites = await api('/admin/sites');
    $('sites').innerHTML = `<table>
      <tr><th>Site</th><th>Clé de liaison</th><th>Dernière synchro</th><th></th></tr>
      ${sites.map(s => `<tr><td>${esc(s.nom)}</td>
        <td><span class="keybox">${esc(s.site_key)}</span></td>
        <td>${esc(s.last_seen || 'jamais')}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="dlConfig('${esc(s.site_key)}')">⬇ Config auto (.json)</button>
          <button class="btn sec" onclick="rotateKey(${s.id})">Régénérer</button></td></tr>`).join('')}
      </table>`;
  } catch (e) { toast(e.message, true); }
}
window.dlConfig = (siteKey) => {
  window.open(`/api/ingest/autoconfig?download=1&siteKey=${encodeURIComponent(siteKey)}`, '_blank');
};
window.rotateKey = async (id) => {
  if (!confirm('Régénérer la clé ? L\'ancienne ne fonctionnera plus.')) return;
  try { await api('/admin/sites/' + id + '/rotate', { method: 'POST' }); toast('Clé régénérée'); loadSites(); }
  catch (e) { toast(e.message, true); }
};
async function loadDistribs() {
  try {
    const ds = await api('/admin/distributeurs');
    $('dTable').innerHTML = `<table>
      <tr><th>Boutique</th><th>Propriétaire</th><th>Nature</th><th>Comptes</th><th>Bons</th><th>État</th><th>Contrôle</th></tr>
      ${ds.map(d => {
        const etat = d.gele ? '<span class="tag off">Gelé (bloqué)</span>'
          : d.actif ? '<span class="tag on">Actif</span>'
          : '<span class="tag off">Désactivé</span>';
        return `<tr><td>${esc(d.nom)}</td><td>${esc(d.proprietaire_nom || '—')}</td>
          <td>${esc(NATURE_LABEL[d.nature] || d.nature || '—')}</td><td>${d.nbUsers}</td><td>${d.nbBons}</td>
          <td>${etat}</td>
          <td class="row-actions">
            <button class="btn sec" onclick="setDistrib(${d.id},'actif',${d.actif ? 0 : 1})">${d.actif ? 'Désactiver' : 'Réactiver'}</button>
            <button class="btn ${d.gele ? 'sec' : 'danger'}" onclick="setDistrib(${d.id},'gele',${d.gele ? 0 : 1})">${d.gele ? 'Dégeler' : 'Geler (bloquer)'}</button>
          </td></tr>`;
      }).join('')}
      </table>`;
  } catch (e) { toast(e.message, true); }
}
window.setDistrib = async (id, champ, val) => {
  const labels = { actif: val ? 'réactiver' : 'désactiver', gele: val ? 'geler (bloquer l\'accès total à)' : 'dégeler' };
  if (!confirm(`Confirmer : ${labels[champ]} cet espace distributeur ?`)) return;
  try { await api('/admin/distributeurs/' + id, { method: 'PATCH', body: JSON.stringify({ [champ]: val }) });
    toast('Distributeur mis à jour'); loadDistribs(); }
  catch (e) { toast(e.message, true); }
};

async function changePassword() {
  const current = $('pwCur').value, nouveau = $('pwNew').value, conf = $('pwConf').value;
  if (!current || !nouveau) return toast('Renseignez le mot de passe actuel et le nouveau', true);
  if (nouveau.length < 6) return toast('Le nouveau mot de passe doit faire au moins 6 caractères', true);
  if (nouveau !== conf) return toast('La confirmation ne correspond pas', true);
  try {
    await api('/auth/password', { method: 'POST', body: JSON.stringify({ current, nouveau }) });
    toast('Mot de passe modifié');
    $('pwCur').value = $('pwNew').value = $('pwConf').value = '';
  } catch (e) { toast(e.message, true); }
}

/* ───────────── Espaces fournisseurs (super-admin) ───────────── */
async function pageFournisseursComptes() {
  $('pageTitle').textContent = 'Espaces fournisseurs';
  const c = $('content');
  let ds = [];
  try { ds = await api('/admin/distributeurs'); } catch (e) { toast(e.message, true); }
  c.innerHTML = `<div class="panel"><h3>Créer un compte fournisseur</h3>
    <div class="hint">Le fournisseur se connecte sur la page de connexion habituelle avec l'identifiant
      et le mot de passe définis ici. Sa vente/livraison alimente automatiquement le stock du distributeur.</div>
    <div class="filters" style="margin-top:10px">
      <span><label>Espace distributeur</label><select id="fcDistrib">
        ${ds.map(d => `<option value="${d.id}">${esc(d.nom)}</option>`).join('')}</select></span>
      <span><label>Nom du fournisseur</label><input id="fcNom" placeholder="Ex : Ciments du Sahel"></span>
      <span><label>Téléphone</label><input id="fcTel" placeholder="Optionnel"></span>
      <span><label>Identifiant</label><input id="fcUser" placeholder="login"></span>
      <span><label>Mot de passe</label><input id="fcPass" type="text" placeholder="min 6 car."></span>
      <button class="btn sec" id="fcAdd">Créer le compte</button>
    </div></div>
    <div class="panel"><h3>Comptes fournisseurs</h3><div id="fcTable"><div class="hint">Chargement…</div></div></div>`;
  $('fcAdd').onclick = addFournisseurCompte;
  loadFournisseursComptes();
}
async function loadFournisseursComptes() {
  try {
    const rows = await api('/admin/fournisseurs-comptes');
    $('fcTable').innerHTML = rows.length ? `<table>
      <tr><th>Distributeur</th><th>Fournisseur</th><th>Identifiant</th><th>Code</th><th>Solde dû</th><th>Statut</th><th></th></tr>
      ${rows.map(u => `<tr>
        <td>${esc(u.distributeur_nom || '—')}</td><td>${esc(u.fournisseur_nom)}</td>
        <td>${esc(u.username)}</td><td><span class="keybox">${esc(u.fournisseur_code)}</span></td>
        <td>${money(u.solde_dette)}</td>
        <td><span class="tag ${u.actif ? 'on' : 'off'}">${u.actif ? 'Actif' : 'Inactif'}</span></td>
        <td class="row-actions">
          <button class="btn sec" onclick="resetFcPass(${u.user_id})">Mot de passe</button>
          <button class="btn sec" onclick="toggleFc(${u.user_id},${u.actif ? 0 : 1})">${u.actif ? 'Désactiver' : 'Activer'}</button>
          <button class="btn danger" onclick="delFc(${u.user_id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun compte fournisseur pour l\'instant.</div>';
  } catch (e) { toast(e.message, true); }
}
async function addFournisseurCompte() {
  const body = {
    distributeurId: Number($('fcDistrib').value), nom: $('fcNom').value,
    telephone: $('fcTel').value, username: $('fcUser').value, password: $('fcPass').value
  };
  try {
    const r = await api('/admin/fournisseurs-comptes', { method: 'POST', body: JSON.stringify(body) });
    toast(`Compte créé — code ${r.code}`);
    $('fcNom').value = $('fcTel').value = $('fcUser').value = $('fcPass').value = '';
    loadFournisseursComptes();
  } catch (e) { toast(e.message, true); }
}
window.resetFcPass = async (id) => {
  const password = prompt('Nouveau mot de passe (min. 6 caractères) :');
  if (!password) return;
  try { await api('/admin/fournisseurs-comptes/' + id, { method: 'PATCH', body: JSON.stringify({ password }) });
    toast('Mot de passe modifié'); }
  catch (e) { toast(e.message, true); }
};
window.toggleFc = async (id, actif) => {
  try { await api('/admin/fournisseurs-comptes/' + id, { method: 'PATCH', body: JSON.stringify({ actif }) });
    loadFournisseursComptes(); }
  catch (e) { toast(e.message, true); }
};
window.delFc = async (id) => {
  if (!confirm('Supprimer ce compte fournisseur ?')) return;
  try { await api('/admin/fournisseurs-comptes/' + id, { method: 'DELETE' }); loadFournisseursComptes(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Espace fournisseur (compte fournisseur) ───────────── */
let EF = { devise: 'FCFA', catalogue: [] };
async function pageEspaceFournisseur() {
  $('pageTitle').textContent = 'Mon espace fournisseur';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  try {
    const d = await api('/espace-fournisseur');
    EF.devise = d.devise || 'FCFA'; EF.catalogue = d.catalogue || [];
    const f = d.fournisseur, r = d.resume || {};
    const dev = EF.devise;
    c.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v" style="color:#b91c1c">${money(f.solde_dette)} ${dev}</div><div class="l">Solde dû par le distributeur</div></div>
        <div class="kpi"><div class="v">${r.nbProduits || 0}</div><div class="l">Produits fournis</div></div>
        <div class="kpi"><div class="v">${money(r.totalLivre)} ${dev}</div><div class="l">Total livré (cumul)</div></div>
        <div class="kpi"><div class="v">${r.nbAppros || 0}</div><div class="l">Nombre de livraisons</div></div>
      </div>
      <div class="panel"><h3>📦 Vendre / livrer au distributeur</h3>
        <div class="hint">La marchandise est ajoutée directement au stock du distributeur (nouvelle entrée de stock) et au solde qui vous est dû.</div>
        <div class="filters" style="margin-top:10px">
          <span style="min-width:220px"><label>Produit</label><select id="efProd">
            ${EF.catalogue.map(p => `<option value="${p.id}" data-pa="${p.prix_achat || 0}">${esc(p.nom)} — stock ${money(p.stock_actuel)} ${esc(p.unite || '')}</option>`).join('')}
          </select></span>
          <span><label>Quantité</label><input id="efQte" type="number" step="0.001" min="0" value="0"></span>
          <span><label>Prix unitaire (achat)</label><input id="efPu" type="number" step="0.01" min="0" value="0"></span>
          <span style="min-width:200px"><label>Note (n° bon, transport…)</label><input id="efNote" placeholder="Optionnel"></span>
          <button class="btn" id="efGo">✔ Enregistrer la livraison</button>
        </div>
        <div class="hint" style="margin-top:10px">Montant total : <b id="efTotal">0 ${dev}</b></div>
      </div>
      <div class="panel"><h3>Produits que je fournis</h3><div id="efProduits"></div></div>
      <div class="panel"><h3>Historique des livraisons / approvisionnements</h3><div id="efAppros"></div></div>`;

    const maj = () => { $('efTotal').textContent = money((Number($('efQte').value) || 0) * (Number($('efPu').value) || 0)) + ' ' + dev; };
    const onProd = () => { const o = $('efProd').selectedOptions[0];
      if (o && (!Number($('efPu').value))) $('efPu').value = o.dataset.pa || 0; maj(); };
    $('efProd').onchange = onProd; $('efQte').oninput = maj; $('efPu').oninput = maj; onProd();
    $('efGo').onclick = enregistrerLivraisonEF;

    $('efProduits').innerHTML = (d.produits || []).length ? `<table>
      <tr><th>Produit</th><th class="r">Stock distributeur</th><th class="r">Dernier prix d'achat</th></tr>
      ${d.produits.map(p => `<tr><td>${esc(p.nom)}</td><td class="r">${money(p.stock_actuel)} ${esc(p.unite || '')}</td><td class="r">${money(p.prix_achat)}</td></tr>`).join('')}
      </table>` : '<div class="hint">Aucun produit associé pour l\'instant.</div>';

    $('efAppros').innerHTML = (d.approvisionnements || []).length ? `<table>
      <tr><th>Date</th><th>Désignation</th><th class="r">Montant</th></tr>
      ${d.approvisionnements.map(a => `<tr><td>${esc((a.date || '').slice(0, 16))}</td><td>${esc(a.description || a.categorie || '')}</td><td class="r">${money(a.montant)}</td></tr>`).join('')}
      </table>` : '<div class="hint">Aucune livraison enregistrée.</div>';
  } catch (e) { toast(e.message, true); c.innerHTML = `<div class="panel"><div class="hint">${esc(e.message)}</div></div>`; }
}
async function enregistrerLivraisonEF() {
  const produit_id = $('efProd').value;
  const quantite = Number($('efQte').value) || 0;
  const prix_unitaire = Number($('efPu').value) || 0;
  if (!produit_id) return toast('Sélectionnez un produit', true);
  if (quantite <= 0) return toast('Quantité invalide', true);
  if (prix_unitaire <= 0) return toast('Prix unitaire invalide', true);
  try {
    const r = await api('/espace-fournisseur/livraison', { method: 'POST',
      body: JSON.stringify({ produit_id, quantite, prix_unitaire, note: $('efNote').value }) });
    toast(r.message || 'Livraison enregistrée');
    pageEspaceFournisseur();
  } catch (e) { toast(e.message, true); }
}

/* ───────────── Propriétaires (super-admin) ───────────── */
async function pageProprietaires() {
  $('pageTitle').textContent = 'Propriétaires (réseaux)';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Créer un propriétaire</h3>
    <div class="hint">Le propriétaire se connecte sur la page de connexion habituelle. Il pourra créer
      ses sous-boutiques dans la limite du quota défini ici.</div>
    <div class="filters" style="margin-top:10px">
      <span><label>Nom / réseau</label><input id="pNom" placeholder="Ex : Groupe Diallo"></span>
      <span><label>Téléphone</label><input id="pTel" placeholder="Optionnel"></span>
      <span><label>E-mail</label><input id="pMail" placeholder="Optionnel"></span>
      <span><label>Quota boutiques</label><input id="pQuota" type="number" min="0" value="1" style="max-width:110px"></span>
      <span><label>Identifiant</label><input id="pUser" placeholder="login"></span>
      <span><label>Mot de passe</label><input id="pPass" type="text" placeholder="min 6 car."></span>
      <button class="btn sec" id="pAdd">Créer le propriétaire</button>
    </div></div>
    <div class="panel"><h3>Propriétaires</h3><div id="pTable"><div class="hint">Chargement…</div></div></div>`;
  $('pAdd').onclick = addProprietaire;
  loadProprietaires();
}
async function loadProprietaires() {
  try {
    const rows = await api('/admin/proprietaires');
    $('pTable').innerHTML = rows.length ? `<table>
      <tr><th>Nom</th><th>Identifiant</th><th>Contact</th><th>Boutiques</th><th>Quota</th><th>État</th><th>Contrôle</th></tr>
      ${rows.map(p => `<tr>
        <td>${esc(p.nom)}</td><td>${esc(p.username || '—')}</td>
        <td>${esc(p.telephone || '')}${p.telephone && p.email ? ' · ' : ''}${esc(p.email || '')}</td>
        <td>${p.nbBoutiques}</td>
        <td><input type="number" min="0" value="${p.quota_boutiques}" style="max-width:80px" id="q_${p.id}">
          <button class="btn sec" onclick="setQuota(${p.id})">OK</button></td>
        <td><span class="tag ${p.actif ? 'on' : 'off'}">${p.actif ? 'Actif' : 'Désactivé'}</span></td>
        <td class="row-actions">
          <button class="btn ${p.actif ? 'danger' : 'sec'}" onclick="setPropActif(${p.id},${p.actif ? 0 : 1})">${p.actif ? 'Désactiver (cascade)' : 'Réactiver'}</button>
          <button class="btn sec" onclick="resetPropPass(${p.id})">Mot de passe</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun propriétaire pour l\'instant.</div>';
  } catch (e) { toast(e.message, true); }
}
async function addProprietaire() {
  const body = { nom: $('pNom').value, telephone: $('pTel').value, email: $('pMail').value,
    quota: Number($('pQuota').value), username: $('pUser').value, password: $('pPass').value };
  try {
    await api('/admin/proprietaires', { method: 'POST', body: JSON.stringify(body) });
    toast('Propriétaire créé');
    $('pNom').value = $('pTel').value = $('pMail').value = $('pUser').value = $('pPass').value = '';
    $('pQuota').value = 1; loadProprietaires();
  } catch (e) { toast(e.message, true); }
}
window.setQuota = async (id) => {
  try { await api('/admin/proprietaires/' + id, { method: 'PATCH', body: JSON.stringify({ quota: Number($('q_' + id).value) }) });
    toast('Quota mis à jour'); loadProprietaires(); }
  catch (e) { toast(e.message, true); }
};
window.setPropActif = async (id, actif) => {
  if (!confirm(actif ? 'Réactiver cet espace propriétaire ?' : 'Désactiver cet espace propriétaire ? Toutes ses boutiques seront bloquées (cascade).')) return;
  try { await api('/admin/proprietaires/' + id, { method: 'PATCH', body: JSON.stringify({ actif }) });
    toast('Propriétaire mis à jour'); loadProprietaires(); }
  catch (e) { toast(e.message, true); }
};
window.resetPropPass = async (id) => {
  const password = prompt('Nouveau mot de passe (min. 6 caractères) :');
  if (!password) return;
  try { await api('/admin/proprietaires/' + id, { method: 'PATCH', body: JSON.stringify({ password }) });
    toast('Mot de passe modifié'); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Abonnements & paiements (super-admin) ───────────── */
async function pageAbonnements() {
  $('pageTitle').textContent = 'Abonnements & paiements';
  const c = $('content');
  c.innerHTML = `<div id="aboStats"></div>
    <div class="panel"><h3>Abonnements des propriétaires</h3>
      <div class="hint">Enregistrez un paiement pour prolonger l'échéance. Le montant mensuel sert de référence.</div>
      <div id="aboTable"><div class="hint">Chargement…</div></div></div>`;
  loadAboStats(); loadAbonnements();
}
async function loadAboStats() {
  try {
    const s = await api('/admin/stats');
    $('aboStats').innerHTML = `<div class="kpis">
      <div class="kpi"><div class="v">${s.nbProprietaires}</div><div class="l">Propriétaires</div></div>
      <div class="kpi"><div class="v">${s.nbBoutiques}</div><div class="l">Boutiques</div></div>
      <div class="kpi"><div class="v" style="color:#16a34a">${s.abonnements.actif}</div><div class="l">Abonnements actifs</div></div>
      <div class="kpi"><div class="v" style="color:#b91c1c">${s.abonnements.expire}</div><div class="l">Expirés</div></div>
      <div class="kpi"><div class="v">${money(s.revenusMois)}</div><div class="l">Encaissé ce mois</div></div>
      <div class="kpi"><div class="v">${money(s.revenusTotaux)}</div><div class="l">Encaissé (cumul)</div></div>
    </div>`;
  } catch (e) { toast(e.message, true); }
}
async function loadAbonnements() {
  try {
    const rows = await api('/admin/proprietaires');
    $('aboTable').innerHTML = rows.length ? `<table>
      <tr><th>Propriétaire</th><th>Statut</th><th>Échéance</th><th>Montant/mois</th><th>Paiement</th><th></th></tr>
      ${rows.map(p => { const a = p.abonnement; return `<tr>
        <td>${esc(p.nom)}</td>
        <td><span class="tag ${ABO_TAG[a.statut]}">${ABO_LABEL[a.statut]}</span></td>
        <td>${esc(aboTexte(a))}</td>
        <td><input type="number" min="0" value="${a.montant}" style="max-width:110px" id="am_${p.id}">
          <button class="btn sec" onclick="setAboMontant(${p.id})">OK</button></td>
        <td class="row-actions">
          <input type="number" min="0" placeholder="Montant" style="max-width:110px" id="pm_${p.id}">
          <input placeholder="Mois" type="number" min="1" value="1" style="max-width:70px" id="pmo_${p.id}">
          <input placeholder="Méthode (espèces…)" style="max-width:150px" id="pme_${p.id}">
          <button class="btn" onclick="ajouterPaiement(${p.id})">+ Paiement</button></td>
        <td><button class="btn sec" onclick="voirPaiements(${p.id},'${esc(p.nom)}')">Historique</button></td>
      </tr>`; }).join('')}</table>`
      : '<div class="hint">Aucun propriétaire. Créez-en un dans « 🏢 Propriétaires ».</div>';
  } catch (e) { toast(e.message, true); }
}
window.setAboMontant = async (id) => {
  try { await api('/admin/proprietaires/' + id, { method: 'PATCH', body: JSON.stringify({ abonnementMontant: Number($('am_' + id).value) }) });
    toast('Montant mensuel mis à jour'); }
  catch (e) { toast(e.message, true); }
};
window.ajouterPaiement = async (id) => {
  const montant = Number($('pm_' + id).value) || 0;
  const mois = Number($('pmo_' + id).value) || 1;
  const methode = $('pme_' + id).value;
  if (montant <= 0) return toast('Montant invalide', true);
  try {
    const r = await api('/admin/proprietaires/' + id + '/paiements', { method: 'POST', body: JSON.stringify({ montant, mois, methode }) });
    toast('Paiement enregistré — échéance : ' + r.echeance);
    loadAboStats(); loadAbonnements();
  } catch (e) { toast(e.message, true); }
};
window.voirPaiements = async (id, nom) => {
  try {
    const rows = await api('/admin/proprietaires/' + id + '/paiements');
    const lignes = rows.length ? rows.map(p => `<tr><td>${esc((p.created_at || '').slice(0, 16))}</td>
      <td>${money(p.montant)}</td><td>${esc(p.methode || '')}</td><td>${p.mois} mois</td>
      <td>${esc(p.periode_fin || '')}</td><td>${esc(p.valide_par || '')}</td></tr>`).join('')
      : '<tr><td colspan="6">Aucun paiement.</td></tr>';
    showModal(`Paiements — ${esc(nom)}`, `<table>
      <tr><th>Date</th><th>Montant</th><th>Méthode</th><th>Durée</th><th>Nouvelle échéance</th><th>Validé par</th></tr>
      ${lignes}</table>`);
  } catch (e) { toast(e.message, true); }
};

/* ───────────── Espace central propriétaire (hub) ───────────── */
let PROP = { boutiques: [] };

async function pageProprietaireDashboard() {
  $('pageTitle').textContent = 'Tableau de bord du réseau';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  try {
    const d = await api('/proprietaire/dashboard');
    const t = d.totaux;
    c.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${t.nbBoutiques}</div><div class="l">Boutiques</div></div>
        <div class="kpi"><div class="v">${money(t.caMois)}</div><div class="l">CA ce mois</div></div>
        <div class="kpi"><div class="v">${money(t.ca)}</div><div class="l">CA cumulé</div></div>
        <div class="kpi"><div class="v">${money(t.encaisse)}</div><div class="l">Encaissé</div></div>
        <div class="kpi"><div class="v" style="color:#b91c1c">${money(t.creances)}</div><div class="l">Créances clients</div></div>
        <div class="kpi"><div class="v">${money(t.valeurStock)}</div><div class="l">Valeur du stock</div></div>
      </div>
      <div class="panel"><h3>Performance par boutique</h3>
        ${d.parBoutique.length ? `<table>
          <tr><th>Boutique</th><th>Nature</th><th class="r">CA mois</th><th class="r">CA cumulé</th><th class="r">Encaissé</th><th class="r">Créances</th><th class="r">Stock (valeur)</th><th class="r">Alertes</th></tr>
          ${d.parBoutique.map(b => `<tr>
            <td>${esc(b.nom)} ${b.gele ? '<span class="tag off">suspendue</span>' : ''}</td>
            <td>${esc(NATURE_LABEL[b.nature] || b.nature)}</td>
            <td class="r">${money(b.caMois)}</td><td class="r">${money(b.ca)}</td>
            <td class="r">${money(b.encaisse)}</td><td class="r">${money(b.creances)}</td>
            <td class="r">${money(b.valeurStock)}</td>
            <td class="r">${b.alertesStock ? `<span class="tag off">${b.alertesStock}</span>` : '0'}</td>
          </tr>`).join('')}</table>`
          : '<div class="hint">Aucune boutique. Créez-en une dans « 🏬 Mes boutiques ».</div>'}
      </div>`;
  } catch (e) { toast(e.message, true); c.innerHTML = `<div class="panel"><div class="hint">${esc(e.message)}</div></div>`; }
}

async function pageProprietaireTransferts() {
  $('pageTitle').textContent = 'Transferts de stock';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  try {
    const ds = await api('/proprietaire/boutiques');
    PROP.boutiques = ds;
    if (ds.length < 2) {
      c.innerHTML = '<div class="panel"><div class="hint">Il faut au moins 2 boutiques pour effectuer un transfert.</div></div>';
      return;
    }
    const opts = ds.map(d => `<option value="${d.id}">${esc(d.nom)}</option>`).join('');
    c.innerHTML = `<div class="panel"><h3>Transférer un article entre boutiques</h3>
      <div class="hint">L'article est déduit du stock source et ajouté au stock de la boutique de destination (créé s'il n'existe pas).</div>
      <div class="filters" style="margin-top:10px">
        <span><label>Boutique source</label><select id="trSrc">${opts}</select></span>
        <span><label>Article</label><select id="trProd"><option>—</option></select></span>
        <span><label>Quantité</label><input id="trQte" type="number" step="0.001" min="0" value="0"></span>
        <span><label>Boutique destination</label><select id="trDst">${opts}</select></span>
        <span><label>Note</label><input id="trNote" placeholder="Optionnel"></span>
        <button class="btn" id="trGo">🔄 Transférer</button>
      </div>
      <div class="hint" id="trStock" style="margin-top:8px"></div></div>
      <div class="panel"><h3>Historique des transferts</h3><div id="trTable"></div></div>`;
    if (ds[1]) $('trDst').value = ds[1].id;
    $('trSrc').onchange = loadTransfertProduits;
    $('trProd').onchange = majTrStock;
    $('trGo').onclick = faireTransfert;
    loadTransfertProduits();
    loadTransferts();
  } catch (e) { toast(e.message, true); }
}
let TR_PRODUITS = [];
async function loadTransfertProduits() {
  try {
    TR_PRODUITS = await api('/proprietaire/produits?distributeurId=' + $('trSrc').value);
    $('trProd').innerHTML = TR_PRODUITS.length
      ? TR_PRODUITS.map(p => `<option value="${p.id}">${esc(p.nom)} — stock ${money(p.stock_actuel)} ${esc(p.unite || '')}</option>`).join('')
      : '<option value="">— aucun article —</option>';
    majTrStock();
  } catch (e) { toast(e.message, true); }
}
function majTrStock() {
  const p = TR_PRODUITS.find(x => String(x.id) === $('trProd').value);
  $('trStock').textContent = p ? `Stock disponible : ${money(p.stock_actuel)} ${p.unite || ''}` : '';
}
async function faireTransfert() {
  const body = { sourceId: Number($('trSrc').value), destId: Number($('trDst').value),
    produitId: Number($('trProd').value), quantite: Number($('trQte').value), note: $('trNote').value };
  if (!body.produitId) return toast('Sélectionnez un article', true);
  if (body.sourceId === body.destId) return toast('Choisissez deux boutiques différentes', true);
  try {
    await api('/proprietaire/transferts', { method: 'POST', body: JSON.stringify(body) });
    toast('Transfert effectué'); $('trQte').value = 0; $('trNote').value = '';
    loadTransfertProduits(); loadTransferts();
  } catch (e) { toast(e.message, true); }
}
async function loadTransferts() {
  try {
    const rows = await api('/proprietaire/transferts');
    $('trTable').innerHTML = rows.length ? `<table>
      <tr><th>Date</th><th>Article</th><th class="r">Quantité</th><th>Source</th><th>Destination</th><th>Par</th></tr>
      ${rows.map(t => `<tr><td>${esc((t.created_at || '').slice(0, 16))}</td>
        <td>${esc(t.produit_nom)}</td><td class="r">${money(t.quantite)} ${esc(t.unite || '')}</td>
        <td>${esc(t.source_nom)}</td><td>${esc(t.dest_nom)}</td><td>${esc(t.par || '')}</td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun transfert pour l\'instant.</div>';
  } catch (e) { toast(e.message, true); }
}
async function pageProprietaireBoutiques() {
  $('pageTitle').textContent = 'Mes boutiques';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  try {
    const me = await api('/proprietaire/me');
    const ds = await api('/proprietaire/boutiques');
    PROP.boutiques = ds;
    const peutCreer = me.quotaDisponible > 0;
    const a = me.abonnement || {};
    const aboColor = a.statut === 'actif' ? '#16a34a' : a.statut === 'essai' ? '#92400e' : '#b91c1c';
    const aboBanner = `<div class="panel" style="border-left:4px solid ${aboColor}">
      <b>Abonnement :</b> <span class="tag ${ABO_TAG[a.statut] || 'off'}">${ABO_LABEL[a.statut] || '—'}</span>
      &nbsp;${esc(aboTexte(a))}${a.montant ? ` · ${money(a.montant)}/mois` : ''}
      ${a.statut === 'expire' || a.statut === 'suspendu' ? '<div class="hint">Régularisez auprès du super-admin pour éviter le blocage de vos boutiques.</div>' : ''}
    </div>`;
    c.innerHTML = `
      ${aboBanner}
      <div class="kpis">
        <div class="kpi"><div class="v">${me.nbBoutiques}/${me.quota_boutiques}</div><div class="l">Boutiques (quota)</div></div>
        <div class="kpi"><div class="v">${me.quotaDisponible}</div><div class="l">Créations restantes</div></div>
        <div class="kpi"><div class="v">${me.nbCollabs}</div><div class="l">Collaborateurs</div></div>
      </div>
      <div class="panel"><h3>Créer une boutique</h3>
        ${peutCreer ? `<div class="filters">
          <span><label>Nom</label><input id="bNom" placeholder="Ex : Boutique Marché Sandaga"></span>
          <span><label>Nature</label><select id="bNature">
            <option value="habillement">Habillement</option>
            <option value="epicerie">Épicerie</option>
            <option value="depot">Dépôt</option>
            <option value="autre" selected>Autre</option></select></span>
          <button class="btn" id="bAdd">Créer</button>
        </div>` : '<div class="hint">Quota atteint. Contactez le super-admin pour augmenter votre quota.</div>'}
      </div>
      <div class="panel"><h3>Boutiques du réseau</h3><div id="bTable"></div></div>`;
    if (peutCreer) $('bAdd').onclick = addBoutique;
    renderBoutiques();
  } catch (e) { toast(e.message, true); c.innerHTML = `<div class="panel"><div class="hint">${esc(e.message)}</div></div>`; }
}
function renderBoutiques() {
  $('bTable').innerHTML = PROP.boutiques.length ? `<table>
    <tr><th>Boutique</th><th>Nature</th><th>Collaborateurs</th><th>État</th><th>Contrôle</th></tr>
    ${PROP.boutiques.map(d => {
      const etat = d.gele ? '<span class="tag off">Suspendue</span>'
        : d.actif ? '<span class="tag on">Active</span>' : '<span class="tag off">Désactivée</span>';
      return `<tr><td>${esc(d.nom)}</td><td>${esc(NATURE_LABEL[d.nature] || d.nature)}</td>
        <td>${d.nbUsers}</td><td>${etat}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="setBoutiqueGele(${d.id},${d.gele ? 0 : 1})">${d.gele ? 'Réactiver' : 'Suspendre'}</button>
        </td></tr>`;
    }).join('')}</table>` : '<div class="hint">Aucune boutique. Créez-en une ci-dessus.</div>';
}
async function addBoutique() {
  if (!$('bNom').value) return toast('Nom requis', true);
  try { await api('/proprietaire/boutiques', { method: 'POST', body: JSON.stringify({ nom: $('bNom').value, nature: $('bNature').value }) });
    toast('Boutique créée'); pageProprietaireBoutiques(); }
  catch (e) { toast(e.message, true); }
}
window.setBoutiqueGele = async (id, gele) => {
  try { await api('/proprietaire/boutiques/' + id, { method: 'PATCH', body: JSON.stringify({ gele }) });
    toast('Boutique mise à jour'); pageProprietaireBoutiques(); }
  catch (e) { toast(e.message, true); }
};

async function pageProprietaireCollabs() {
  $('pageTitle').textContent = 'Collaborateurs (RH)';
  const c = $('content');
  c.innerHTML = '<div class="panel"><div class="hint">Chargement…</div></div>';
  try {
    const ds = await api('/proprietaire/boutiques');
    PROP.boutiques = ds;
    if (!ds.length) { c.innerHTML = '<div class="panel"><div class="hint">Créez d\'abord une boutique.</div></div>'; return; }
    const opts = ds.map(d => `<option value="${d.id}">${esc(d.nom)}</option>`).join('');
    c.innerHTML = `<div class="panel"><h3>Affecter un collaborateur</h3>
      <div class="filters">
        <span><label>Boutique</label><select id="cBoutique">${opts}</select></span>
        <span><label>Identifiant</label><input id="cUser" placeholder="login"></span>
        <span><label>Nom complet</label><input id="cFull" placeholder="Nom"></span>
        <span><label>Mot de passe</label><input id="cPass" type="text" placeholder="min 6 car."></span>
        <span><label>Rôle</label><select id="cRole">
          <option value="vendeur">Vendeur</option>
          <option value="stockiste">Stockiste</option>
          <option value="comptable">Comptable</option>
          <option value="assistante">Assistante</option>
          <option value="admin">Gérant (admin boutique)</option></select></span>
        <button class="btn sec" id="cAdd">Ajouter</button>
      </div></div>
      <div class="panel"><h3>Collaborateurs du réseau</h3><div id="cTable"><div class="hint">Chargement…</div></div></div>`;
    $('cAdd').onclick = addCollab;
    loadCollabs();
  } catch (e) { toast(e.message, true); }
}
async function loadCollabs() {
  try {
    const rows = await api('/proprietaire/collaborateurs');
    const opts = PROP.boutiques.map(d => d.id).join(',');
    $('cTable').innerHTML = rows.length ? `<table>
      <tr><th>Identifiant</th><th>Nom</th><th>Boutique</th><th>Rôle</th><th>Statut</th><th>Mutation</th><th></th></tr>
      ${rows.map(u => `<tr>
        <td>${esc(u.username)}</td><td>${esc(u.full_name || '')}</td>
        <td>${esc(u.boutique_nom)}</td>
        <td><span class="tag ${u.role}">${ROLE_LABEL[u.role] || u.role}</span></td>
        <td><span class="tag ${u.actif ? 'on' : 'off'}">${u.actif ? 'Actif' : 'Inactif'}</span></td>
        <td><select onchange="muterCollab(${u.id}, this.value)">
          ${PROP.boutiques.map(d => `<option value="${d.id}" ${d.id === u.distributeur_id ? 'selected' : ''}>${esc(d.nom)}</option>`).join('')}
        </select></td>
        <td class="row-actions">
          <button class="btn sec" onclick="toggleCollab(${u.id},${u.actif ? 0 : 1})">${u.actif ? 'Désactiver' : 'Activer'}</button>
          <button class="btn danger" onclick="delCollab(${u.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun collaborateur pour l\'instant.</div>';
    void opts;
  } catch (e) { toast(e.message, true); }
}
async function addCollab() {
  const body = { distributeurId: Number($('cBoutique').value), username: $('cUser').value,
    fullName: $('cFull').value, password: $('cPass').value, role: $('cRole').value };
  try { await api('/proprietaire/collaborateurs', { method: 'POST', body: JSON.stringify(body) });
    toast('Collaborateur ajouté'); $('cUser').value = $('cFull').value = $('cPass').value = ''; loadCollabs(); }
  catch (e) { toast(e.message, true); }
}
window.muterCollab = async (id, distributeurId) => {
  try { await api('/proprietaire/collaborateurs/' + id, { method: 'PATCH', body: JSON.stringify({ distributeurId: Number(distributeurId) }) });
    toast('Collaborateur muté'); loadCollabs(); }
  catch (e) { toast(e.message, true); }
};
window.toggleCollab = async (id, actif) => {
  try { await api('/proprietaire/collaborateurs/' + id, { method: 'PATCH', body: JSON.stringify({ actif }) }); loadCollabs(); }
  catch (e) { toast(e.message, true); }
};
window.delCollab = async (id) => {
  if (!confirm('Supprimer ce collaborateur ?')) return;
  try { await api('/proprietaire/collaborateurs/' + id, { method: 'DELETE' }); loadCollabs(); }
  catch (e) { toast(e.message, true); }
};

/* ───────────── Démarrage ───────────── */
(async function init() {
  initOffline();
  if (S.token) {
    try { S.user = await api('/auth/me'); enterApp(); }
    catch (e) { if (!String(e.message).includes('Hors-ligne')) logout(); }
  }
})();
