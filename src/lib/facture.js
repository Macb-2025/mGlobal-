// Modèle de facture professionnel (« niveau État ») + utilitaires de mise en forme.
// Rendu HTML autonome, prêt à imprimer (A4), avec en-tête vendeur, bloc client,
// détail des articles, totaux HT/TVA/TTC, montant en toutes lettres et mentions légales.

export function esc(x) {
  return String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function fmtMoney(v) {
  return Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const fmtQte = (v) => Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const fmtDate = (s) => {
  const d = new Date(s || Date.now());
  return Number.isNaN(d.getTime()) ? String(s || '') : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
};

// ── Conversion d'un montant en toutes lettres (français) ──
const UNITES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
  'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const DIZAINES = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

function centaineEnLettres(n) {
  let mots = '';
  const c = Math.floor(n / 100), reste = n % 100;
  if (c > 0) mots += (c > 1 ? UNITES[c] + ' cent' : 'cent') + (reste === 0 && c > 1 ? 's' : '') + ' ';
  if (reste > 0) {
    if (reste < 20) mots += UNITES[reste];
    else {
      const d = Math.floor(reste / 10), u = reste % 10;
      if (d === 7 || d === 9) {
        mots += DIZAINES[d] + '-' + UNITES[10 + u];
      } else {
        mots += DIZAINES[d];
        if (u === 1 && d !== 8) mots += '-et-un';
        else if (u > 0) mots += '-' + UNITES[u];
        else if (d === 8) mots += 's';
      }
    }
  }
  return mots.trim();
}

function entierEnLettres(n) {
  if (n === 0) return 'zéro';
  let mots = '';
  const millions = Math.floor(n / 1000000);
  const milliers = Math.floor((n % 1000000) / 1000);
  const reste = n % 1000;
  if (millions > 0) mots += (millions > 1 ? centaineEnLettres(millions) + ' millions ' : 'un million ');
  if (milliers > 0) mots += (milliers > 1 ? centaineEnLettres(milliers) + ' mille ' : 'mille ');
  if (reste > 0) mots += centaineEnLettres(reste);
  return mots.trim();
}

export function montantEnLettres(montant, devise = 'FCFA') {
  const n = Math.round(Number(montant || 0));
  const lettres = entierEnLettres(n);
  return (lettres.charAt(0).toUpperCase() + lettres.slice(1)) + ' ' + devise;
}

const STATUTS = {
  emise: { label: 'ÉMISE', color: '#1d4ed8' },
  partielle: { label: 'PARTIELLEMENT RÉGLÉE', color: '#b45309' },
  payee: { label: 'PAYÉE', color: '#15803d' },
  annulee: { label: 'ANNULÉE', color: '#b91c1c' }
};

// fa : facture + { lignes: [...] } ; vendeur : ligne distributeurs (identité légale).
export function factureHtml(fa, vendeur = {}) {
  const devise = vendeur.devise || 'FCFA';
  const reste = Number(fa.relicat || 0);
  const lignes = Array.isArray(fa.lignes) ? fa.lignes : [];
  const st = STATUTS[fa.statut] || STATUTS.emise;
  const clientNom = fa.client_nom_ref || fa.client_nom || '—';
  const raison = vendeur.raison_sociale || vendeur.nom || 'mGlobal';

  const lignesHtml = lignes.length ? lignes.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(l.designation)}</td>
      <td class="r">${fmtQte(l.quantite)} ${esc(l.unite || '')}</td>
      <td class="r">${fmtMoney(l.prix_unitaire)}</td>
      <td class="r">${l.remise ? fmtQte(l.remise) + ' %' : '—'}</td>
      <td class="r">${fmtQte(l.tva)} %</td>
      <td class="r">${fmtMoney(l.montant_ht)}</td>
    </tr>`).join('') : `
    <tr><td colspan="7" class="muted c">Facture forfaitaire (sans détail d'articles)</td></tr>`;

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Facture ${esc(fa.numero)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;margin:0;background:#eef2f7;}
  .sheet{max-width:820px;margin:24px auto;background:#fff;padding:42px 46px;
    box-shadow:0 8px 30px rgba(0,0,0,.10);border-top:6px solid #0f3d6e;}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;}
  .brand{font-size:22px;font-weight:800;color:#0f3d6e;letter-spacing:.3px;}
  .seller{font-size:12.5px;color:#374151;line-height:1.55;margin-top:6px;}
  .seller b{color:#111827;}
  .docbox{text-align:right;min-width:230px;}
  .doctitle{font-size:30px;font-weight:800;color:#0f3d6e;letter-spacing:2px;}
  .docmeta{margin-top:8px;font-size:12.5px;color:#374151;line-height:1.6;}
  .docmeta span{display:inline-block;min-width:96px;color:#6b7280;}
  .stamp{display:inline-block;margin-top:8px;padding:3px 12px;border:2px solid ${st.color};
    color:${st.color};font-weight:800;font-size:12px;border-radius:6px;letter-spacing:1px;}
  .parties{display:flex;gap:18px;margin:26px 0 6px;}
  .card{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;background:#f9fafb;}
  .card h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#0f3d6e;}
  .card .nm{font-weight:700;font-size:15px;color:#111827;}
  .card .ln{font-size:12.5px;color:#4b5563;line-height:1.5;}
  table.items{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px;}
  table.items th{background:#0f3d6e;color:#fff;padding:10px 9px;text-align:left;font-weight:600;font-size:12px;}
  table.items th.r,table.items td.r{text-align:right;}
  table.items th.c,table.items td.c{text-align:center;}
  table.items td{padding:9px;border-bottom:1px solid #eceff3;}
  table.items tbody tr:nth-child(even){background:#f7f9fc;}
  .muted{color:#9ca3af;}
  .bottom{display:flex;justify-content:space-between;gap:24px;margin-top:18px;}
  .totals{width:320px;margin-left:auto;}
  .totals .row{display:flex;justify-content:space-between;padding:7px 12px;font-size:13.5px;}
  .totals .row.ttc{background:#0f3d6e;color:#fff;font-weight:800;font-size:15px;border-radius:8px;margin-top:4px;}
  .totals .row.due{font-weight:700;color:${reste > 0 ? '#b91c1c' : '#15803d'};}
  .words{margin-top:18px;font-size:12.5px;background:#f1f5fb;border-left:4px solid #0f3d6e;
    padding:10px 14px;border-radius:0 8px 8px 0;}
  .pay{margin-top:14px;font-size:12.5px;color:#374151;}
  .sign{display:flex;justify-content:space-between;margin-top:46px;font-size:12.5px;color:#374151;}
  .sign div{width:45%;}
  .sign .line{margin-top:54px;border-top:1px solid #9ca3af;padding-top:5px;text-align:center;color:#6b7280;}
  .foot{margin-top:30px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:11px;color:#6b7280;text-align:center;line-height:1.6;}
  .toolbar{text-align:center;margin:16px;}
  .toolbar button{background:#0f3d6e;color:#fff;border:0;padding:10px 22px;border-radius:8px;font-size:14px;cursor:pointer;}
  @media print{body{background:#fff;}.sheet{box-shadow:none;margin:0;max-width:none;}.toolbar{display:none;}}
</style></head><body>
<div class="sheet">
  <div class="top">
    <div>
      ${vendeur.logo
        ? `<img src="${esc(vendeur.logo)}" alt="logo" style="max-height:70px;max-width:220px;object-fit:contain;margin-bottom:6px">`
        : `<div class="brand">⚖ ${esc(raison)}</div>`}
      <div class="seller">
        ${vendeur.adresse ? esc(vendeur.adresse) + '<br>' : ''}
        ${vendeur.ville ? esc(vendeur.ville) + '<br>' : ''}
        ${vendeur.telephone ? 'Tél : ' + esc(vendeur.telephone) + '<br>' : ''}
        ${vendeur.email ? esc(vendeur.email) + '<br>' : ''}
        ${vendeur.ninea ? '<b>NINEA :</b> ' + esc(vendeur.ninea) + '  ' : ''}
        ${vendeur.rccm ? '<b>RCCM :</b> ' + esc(vendeur.rccm) : ''}
      </div>
    </div>
    <div class="docbox">
      <div class="doctitle">FACTURE</div>
      <div class="docmeta">
        <div><span>N°</span><b>${esc(fa.numero)}</b></div>
        <div><span>Date</span>${esc(fmtDate(fa.date))}</div>
        ${fa.echeance ? `<div><span>Échéance</span>${esc(fmtDate(fa.echeance))}</div>` : ''}
        ${fa.numero_bon ? `<div><span>Bon n°</span>${esc(fa.numero_bon)}</div>` : ''}
      </div>
      <div class="stamp">${st.label}</div>
    </div>
  </div>

  <div class="parties">
    <div class="card">
      <h4>Émetteur</h4>
      <div class="nm">${esc(raison)}</div>
      <div class="ln">${vendeur.adresse ? esc(vendeur.adresse) + ' · ' : ''}${esc(vendeur.ville || '')}</div>
      <div class="ln">${vendeur.telephone ? 'Tél : ' + esc(vendeur.telephone) : ''}</div>
    </div>
    <div class="card">
      <h4>Facturé à</h4>
      <div class="nm">${esc(clientNom)}</div>
      <div class="ln">${fa.immatriculation ? 'Code : ' + esc(fa.immatriculation) : ''}</div>
      <div class="ln">${fa.telephone ? 'Tél : ' + esc(fa.telephone) : ''}</div>
      <div class="ln">${esc(fa.adresse || '')}</div>
    </div>
  </div>

  <table class="items">
    <thead><tr>
      <th class="c">#</th><th>Désignation</th><th class="r">Quantité</th>
      <th class="r">P.U. HT</th><th class="r">Remise</th><th class="r">TVA</th><th class="r">Montant HT</th>
    </tr></thead>
    <tbody>${lignesHtml}</tbody>
  </table>

  <div class="bottom">
    <div class="totals">
      <div class="row"><span>Total HT</span><b>${fmtMoney(fa.montant_ht)} ${devise}</b></div>
      ${fa.remise_globale ? `<div class="row"><span>Remise globale</span><b>${fmtQte(fa.remise_globale)} %</b></div>` : ''}
      <div class="row"><span>Total TVA</span><b>${fmtMoney(fa.montant_tva)} ${devise}</b></div>
      <div class="row ttc"><span>NET À PAYER (TTC)</span><span>${fmtMoney(fa.montant_total)} ${devise}</span></div>
      <div class="row"><span>Montant réglé</span><b>${fmtMoney(fa.montant_paye)} ${devise}</b></div>
      <div class="row due"><span>${reste >= 0 ? 'Reste à payer' : 'Trop-perçu (relicat)'}</span>
        <b>${fmtMoney(Math.abs(reste))} ${devise}</b></div>
    </div>
  </div>

  <div class="words">Arrêtée la présente facture à la somme de :
    <b>${esc(montantEnLettres(fa.montant_total, devise))}</b>.</div>

  ${fa.mode_paiement ? `<div class="pay"><b>Mode de règlement :</b> ${esc(fa.mode_paiement)}</div>` : ''}
  ${fa.note ? `<div class="pay"><b>Observations :</b> ${esc(fa.note)}</div>` : ''}

  <div class="sign">
    <div><div class="line">Le Client</div></div>
    <div><div class="line">Pour ${esc(raison)}</div></div>
  </div>

  <div class="foot">
    ${vendeur.pied_facture ? esc(vendeur.pied_facture) + '<br>' : ''}
    ${raison}${vendeur.ninea ? ' · NINEA ' + esc(vendeur.ninea) : ''}${vendeur.rccm ? ' · RCCM ' + esc(vendeur.rccm) : ''}
    <br>Facture générée par mGlobal Business — document émis par voie électronique.
    <br>© mGlobalTec — Aladji SALL · 771184001 · aladjisall@gmail.com / macb.global@gmail.com · Dakar, Sénégal
  </div>
</div>
<div class="toolbar"><button onclick="window.print()">🖨 Imprimer / Enregistrer en PDF</button></div>
</body></html>`;
}
