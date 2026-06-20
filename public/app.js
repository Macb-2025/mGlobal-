'use strict';

const S = { token: localStorage.getItem('mg_token') || '', user: null, page: 'dashboard', liveTimer: null };
const $ = (id) => document.getElementById(id);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmt = (n, d = 3) => Number(n || 0).toFixed(d);
const money = (n) => Number(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => new Date().toISOString().slice(0, 8) + '01';

function toast(msg, isErr = false) {
  const t = el(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  const res = await fetch('/api' + path, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Session expirée'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || 'Erreur serveur');
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
}

const ROLE_LABEL = { superadmin: 'Super-admin mGlobal', admin: 'Administrateur', superviseur: 'Superviseur', operateur: 'Opérateur' };

function menuFor(role) {
  // Super-admin : administration uniquement (comptes + distributeurs), aucun accès
  // aux données métier des distributeurs.
  if (role === 'superadmin') {
    return [
      { id: 'admin', label: '⚙ Administration' },
      { id: 'users', label: '🔑 Création de comptes' }
    ];
  }
  const base = [
    { id: 'dashboard', label: '📊 Dashboard mGlobal' },
    { id: 'suivi', label: '🧾 Suivi des bons' },
    { id: 'bons', label: '📤 Bons / Pesées' },
    { id: 'clients', label: '👥 Clients' },
    { id: 'fournisseurs', label: '🚚 Fournisseurs' },
    { id: 'stock', label: '📦 Stock / Produits' },
    { id: 'gros', label: '🧱 Ventes en gros' },
    { id: 'facturation', label: '🧾 Facturation' },
    { id: 'relicat', label: '💳 Relicat / Créances' },
    { id: 'compta', label: '💰 Comptabilité' },
    { id: 'rapports', label: '📈 Rapports' }
  ];
  if (role === 'admin') base.push({ id: 'users', label: '🔑 Utilisateurs & rôles' });
  return base;
}

function enterApp() {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  const u = S.user;
  $('spaceName').textContent = u.distributeur ? u.distributeur.nom : 'Vue globale mGlobal';
  $('who').innerHTML = `<b>${esc(u.fullName || u.username)}</b><br>${ROLE_LABEL[u.role] || u.role}`;
  const nav = $('nav'); nav.innerHTML = '';
  for (const m of menuFor(u.role)) {
    const b = el(`<button data-page="${m.id}">${m.label}</button>`);
    b.onclick = () => go(m.id);
    nav.appendChild(b);
  }
  go(u.role === 'superadmin' ? 'admin' : 'dashboard');
  connectWS();
}

function go(page) {
  S.page = page;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = null; }
  ({ dashboard: pageDashboard, suivi: pageSuivi, bons: pageBons, clients: pageClients,
     fournisseurs: pageFournisseurs, stock: pageStock, gros: pageGros,
     facturation: pageFacturation, relicat: pageRelicat, compta: pageCompta,
     rapports: pageRapports, users: pageUsers, admin: pageAdmin }[page] || pageDashboard)();
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
          <button class="btn sec" onclick="imprimerBon(${s.id})">Imprimer</button>
        </td></tr>`).join('')}</table>` : '<div class="hint">Aucun bon sur cette période.</div>';
  } catch (e) { toast(e.message, true); }
}
window.voirBon = (id) => window.open(`/api/bon?id=${id}&token=${encodeURIComponent(S.token)}`, '_blank');
window.imprimerBon = async (id) => {
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
  const canCreate = S.user.role === 'admin' || S.user.role === 'operateur';
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
  if (canCreate) $('cbAdd').onclick = creerBon;
  $('cbReload').onclick = loadSuivi;
  $('cbFilter').onchange = loadSuivi;
  loadSuivi();
  connectWS();
}

async function creerBon() {
  const body = {
    client: $('cbClient').value, produit: $('cbProduit').value,
    immatriculation: $('cbImmat').value, chauffeur: $('cbChauffeur').value,
    destination: $('cbDest').value, quantitePrevue: Number($('cbQte').value || 0),
    note: $('cbNote').value
  };
  try {
    await api('/bons-commande', { method: 'POST', body: JSON.stringify(body) });
    toast('Bon créé, numéroté et signé puis envoyé au pont bascule');
    ['cbClient','cbProduit','cbImmat','cbChauffeur','cbDest','cbQte','cbNote'].forEach(id => { if ($(id)) $(id).value = ''; });
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
    <div class="hint">Un code d'accès portail (immatriculation) est généré automatiquement.</div></div>
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

/* ───────────── Stock / Produits ───────────── */
let _produits = [], _fournisseurs = [];
async function pageStock() {
  $('pageTitle').textContent = 'Stock / Produits';
  const c = $('content');
  try { _fournisseurs = await api('/fournisseurs'); } catch { _fournisseurs = []; }
  const frOpts = `<option value="">— Fournisseur —</option>` +
    _fournisseurs.map(f => `<option value="${f.id}">${esc(f.nom)}</option>`).join('');
  c.innerHTML = `<div class="panel"><h3>Nouveau produit</h3>
    <div class="filters">
      <span><label>Nom</label><input id="pNom" placeholder="Ciment, sable…"></span>
      <span><label>Unité</label><input id="pUnite" value="t" style="width:60px"></span>
      <span><label>Stock initial</label><input id="pStock" type="number" step="0.001" value="0"></span>
      <span><label>Seuil alerte</label><input id="pAlerte" type="number" step="0.001" value="10"></span>
      <span><label>Prix achat</label><input id="pAchat" type="number" step="0.01" value="0"></span>
      <span><label>Prix vente gros</label><input id="pVente" type="number" step="0.01" value="0"></span>
      <span><label>Fournisseur</label><select id="pFour">${frOpts}</select></span>
      <button class="btn sec" id="pAdd">Ajouter</button>
    </div></div>
    <div class="panel"><h3>Catalogue & stock</h3><div id="pTable"><div class="hint">Chargement…</div></div></div>`;
  $('pAdd').onclick = async () => {
    if (!$('pNom').value.trim()) return toast('Le nom est requis', true);
    try {
      await api('/produits', { method: 'POST', body: JSON.stringify({
        nom: $('pNom').value, unite: $('pUnite').value, stock_actuel: Number($('pStock').value || 0),
        stock_alerte: Number($('pAlerte').value || 0), prix_achat: Number($('pAchat').value || 0),
        prix_vente_gros: Number($('pVente').value || 0), fournisseur_id: $('pFour').value || null }) });
      toast('Produit ajouté'); $('pNom').value = ''; loadProduits();
    } catch (e) { toast(e.message, true); }
  };
  loadProduits();
}
async function loadProduits() {
  try {
    _produits = await api('/produits');
    $('pTable').innerHTML = _produits.length ? `<table>
      <tr><th>Produit</th><th>Stock</th><th>Seuil</th><th>Prix achat</th><th>Vente gros</th><th>Fournisseur</th><th></th></tr>
      ${_produits.map(p => `<tr>
        <td>${esc(p.nom)}</td>
        <td class="${p.stock_actuel <= p.stock_alerte ? 'neg' : ''}">${fmt(p.stock_actuel)} ${esc(p.unite)}
          ${p.stock_actuel <= p.stock_alerte ? ' ⚠' : ''}</td>
        <td>${fmt(p.stock_alerte)}</td><td>${money(p.prix_achat)}</td><td>${money(p.prix_vente_gros)}</td>
        <td>${esc(p.fournisseur_nom || '—')}</td>
        <td class="row-actions">
          <button class="btn sec" onclick="approvProduit(${p.id})">Approvisionner</button>
          <button class="btn danger" onclick="delProduit(${p.id})">Suppr.</button>
        </td></tr>`).join('')}</table>`
      : '<div class="hint">Aucun produit pour le moment.</div>';
  } catch (e) { toast(e.message, true); }
}
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
  c.innerHTML = `<div class="panel"><h3>Ouvrir un compte gros (marchandise prépayée)</h3>
    <div class="filters">
      <span><label>Client</label><select id="gClient">
        ${clients.map(c => `<option value="${c.id}">${esc(c.nom)}</option>`).join('')}</select></span>
      <span><label>Produit</label><select id="gProd">
        ${produits.map(p => `<option value="${p.id}">${esc(p.nom)}</option>`).join('')}</select></span>
      <span><label>Quantité totale</label><input id="gQte" type="number" step="0.001" value="0"></span>
      <span><label>Prix unitaire</label><input id="gPrix" type="number" step="0.01" value="0"></span>
      <button class="btn sec" id="gAdd">Créer</button>
    </div></div>
    <div class="panel"><h3>Comptes en gros & solde à enlever</h3><div id="gTable"><div class="hint">Chargement…</div></div></div>`;
  $('gAdd').onclick = async () => {
    try { await api('/commandes-gros', { method: 'POST', body: JSON.stringify({
      entite_type: 'CLIENT', entite_id: Number($('gClient').value), produit_id: Number($('gProd').value),
      quantite_totale: Number($('gQte').value || 0), prix_unitaire: Number($('gPrix').value || 0) }) });
      toast('Compte gros créé'); loadGros(); } catch (e) { toast(e.message, true); }
  };
  loadGros();
}
async function loadGros() {
  try {
    const rows = await api('/commandes-gros');
    $('gTable').innerHTML = rows.length ? `<table>
      <tr><th>Client</th><th>Produit</th><th>Total</th><th>Restant à enlever</th><th>Prix u.</th><th></th></tr>
      ${rows.map(g => `<tr>
        <td>${esc(g.entite_nom || '—')}</td><td>${esc(g.produit_nom || '—')}</td>
        <td>${fmt(g.quantite_totale)} ${esc(g.unite || '')}</td>
        <td class="${g.quantite_restante > 0 ? 'pos' : ''}">${fmt(g.quantite_restante)} ${esc(g.unite || '')}</td>
        <td>${money(g.prix_unitaire)}</td>
        <td class="row-actions">${g.quantite_restante > 0
          ? `<button class="btn sec" onclick="enlever(${g.id},${g.quantite_restante})">Enlèvement</button>` : '✔ soldé'}</td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucun compte en gros.</div>';
  } catch (e) { toast(e.message, true); }
}
window.enlever = async (id, restant) => {
  const q = prompt(`Quantité à enlever (max ${restant}) :`, ''); if (q === null) return;
  try { await api('/enlevements', { method: 'POST', body: JSON.stringify({
    commande_gros_id: id, quantite_enlevee: Number(q) }) });
    toast('Enlèvement enregistré (stock déduit)'); loadGros(); } catch (e) { toast(e.message, true); }
};

/* ───────────── Facturation ───────────── */
async function pageFacturation() {
  $('pageTitle').textContent = 'Facturation';
  const c = $('content');
  let clients = [];
  try { clients = await api('/clients'); } catch {}
  c.innerHTML = `<div class="panel"><h3>Nouvelle facture</h3>
    <div class="filters">
      <span><label>Client</label><select id="faClient">
        <option value="">— Sans client —</option>
        ${clients.map(c => `<option value="${c.id}">${esc(c.nom)}</option>`).join('')}</select></span>
      <span><label>Montant total</label><input id="faTotal" type="number" step="0.01" value="0"></span>
      <span><label>Montant réglé</label><input id="faPaye" type="number" step="0.01" value="0"></span>
      <span style="flex:1"><label>Note</label><input id="faNote" placeholder="Observation (optionnel)"></span>
      <button class="btn sec" id="faAdd">Émettre</button>
    </div>
    <div class="hint">Le reste à payer alimente automatiquement la dette du client (ou le relicat si trop-perçu).</div></div>
    <div class="panel"><h3>Factures émises</h3><div id="faTable"><div class="hint">Chargement…</div></div></div>`;
  $('faAdd').onclick = async () => {
    try { const r = await api('/factures', { method: 'POST', body: JSON.stringify({
      client_id: $('faClient').value || null, montant_total: Number($('faTotal').value || 0),
      montant_paye: Number($('faPaye').value || 0), note: $('faNote').value }) });
      toast(`Facture ${r.numero} émise`); $('faTotal').value = $('faPaye').value = '0'; $('faNote').value = ''; loadFactures(); }
    catch (e) { toast(e.message, true); }
  };
  loadFactures();
}
async function loadFactures() {
  try {
    const rows = await api('/factures');
    $('faTable').innerHTML = rows.length ? `<table>
      <tr><th>N°</th><th>Date</th><th>Client</th><th>Total</th><th>Réglé</th><th>Reste</th><th></th></tr>
      ${rows.map(f => `<tr>
        <td>${esc(f.numero)}</td><td>${esc((f.date || '').slice(0, 16))}</td><td>${esc(f.client_nom || '—')}</td>
        <td>${money(f.montant_total)}</td><td>${money(f.montant_paye)}</td>
        <td class="${f.relicat > 0 ? 'neg' : 'pos'}">${money(f.relicat)}</td>
        <td class="row-actions"><button class="btn sec" onclick="imprimerFacture(${f.id})">Imprimer</button></td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucune facture émise.</div>';
  } catch (e) { toast(e.message, true); }
}
window.imprimerFacture = (id) => window.open(`/api/factures/${id}/imprimer?token=${encodeURIComponent(S.token)}`, '_blank');

/* ───────────── Relicat / Créances ───────────── */
async function pageRelicat() {
  $('pageTitle').textContent = 'Relicat / Créances clients';
  const c = $('content');
  c.innerHTML = `<div class="panel"><h3>Clients avec dette ou relicat</h3>
    <div class="hint">Enregistrez un règlement : il solde la dette puis verse l'excédent en relicat (acompte).</div>
    <div id="reTable"><div class="hint">Chargement…</div></div></div>`;
  loadRelicat();
}
async function loadRelicat() {
  try {
    const rows = await api('/relicat');
    $('reTable').innerHTML = rows.length ? `<table>
      <tr><th>Client</th><th>Code</th><th>Téléphone</th><th>Dette</th><th>Relicat</th><th></th></tr>
      ${rows.map(x => `<tr>
        <td>${esc(x.nom)}</td><td><span class="keybox">${esc(x.immatriculation)}</span></td>
        <td>${esc(x.telephone || '')}</td>
        <td class="${x.solde_dette > 0 ? 'neg' : ''}">${money(x.solde_dette)}</td>
        <td class="${x.solde_relicat > 0 ? 'pos' : ''}">${money(x.solde_relicat)}</td>
        <td class="row-actions"><button class="btn sec" onclick="reglerClient(${x.id})">Encaisser règlement</button></td>
      </tr>`).join('')}</table>` : '<div class="hint">Aucune dette ni relicat en cours.</div>';
  } catch (e) { toast(e.message, true); }
}
window.reglerClient = async (id) => {
  const m = prompt('Montant encaissé :', ''); if (m === null) return;
  try { await api('/relicat/reglement', { method: 'POST', body: JSON.stringify({ client_id: id, montant: Number(m) }) });
    toast('Règlement enregistré'); loadRelicat(); } catch (e) { toast(e.message, true); }
};

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
        <option value="operateur">Opérateur</option>
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
    <div class="panel"><h3>Distributeurs (espaces)</h3>
      <div class="filters"><input id="dNom" placeholder="Nom du distributeur">
        <button class="btn sec" id="dAdd">Créer l'espace</button></div>
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
    try { await api('/admin/distributeurs', { method: 'POST', body: JSON.stringify({ nom: $('dNom').value }) });
      toast('Espace créé'); $('dNom').value = ''; loadDistribs(); }
    catch (e) { toast(e.message, true); }
  };
  loadSites(); loadDistribs();
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
      <tr><th>Distributeur</th><th>Slug</th><th>Comptes</th><th>Bons</th><th>État</th><th>Contrôle</th></tr>
      ${ds.map(d => {
        const etat = d.gele ? '<span class="tag off">Gelé (bloqué)</span>'
          : d.actif ? '<span class="tag on">Actif</span>'
          : '<span class="tag off">Désactivé</span>';
        return `<tr><td>${esc(d.nom)}</td><td>${esc(d.slug)}</td><td>${d.nbUsers}</td><td>${d.nbBons}</td>
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

/* ───────────── Démarrage ───────────── */
(async function init() {
  if (S.token) {
    try { S.user = await api('/auth/me'); enterApp(); }
    catch { logout(); }
  }
})();
