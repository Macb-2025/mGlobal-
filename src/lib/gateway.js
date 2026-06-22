// Passerelle de paiement pluggable (Modules 8 & 9).
// Chaque fournisseur expose :
//   - id, label, configure()            → bool (clés présentes)
//   - async initier({ paiement, baseUrl, urls }) → { paymentUrl, providerRef? }
//   - lireWebhook(req)                  → { token, providerRef, statut: 'valide'|'echoue' }
// Fournisseur par défaut : « simulation » (démo locale, sans clé).
import crypto from 'crypto';

export const PROVIDER = process.env.PAIEMENT_PROVIDER || 'simulation';
const has = (...keys) => keys.every(k => !!process.env[k]);

function nonConfigure(label, keys) {
  const e = new Error(`Fournisseur « ${label} » non configuré : variables manquantes ${keys.filter(k => !process.env[k]).join(', ')}`);
  e.code = 'provider_non_configure';
  return e;
}

async function postJson(url, { headers = {}, body } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) { const e = new Error(`Fournisseur HTTP ${res.status} : ${txt.slice(0, 300)}`); e.status = res.status; throw e; }
  return data;
}

// ── Démonstration (sans clé) : page de paiement locale ──
const simulation = {
  id: 'simulation', label: 'Démonstration',
  configure() { return true; },
  async initier({ paiement, baseUrl }) {
    return { paymentUrl: `${baseUrl}/pay.html?token=${encodeURIComponent(paiement.token)}` };
  },
  lireWebhook(req) {
    const { token, decision } = req.body || {};
    if (!token) throw new Error('Jeton manquant');
    return { token, providerRef: 'SIMU-' + token.slice(0, 8), statut: decision === 'echec' ? 'echoue' : 'valide' };
  }
};

// ── Wave (Checkout API, Sénégal) ──
// Doc : POST https://api.wave.com/v1/checkout/sessions (Bearer WAVE_API_KEY).
// Le webhook Wave est signé (en-tête « Wave-Signature ») et vérifié avec WAVE_WEBHOOK_SECRET.
const wave = {
  id: 'wave', label: 'Wave',
  configure() { return has('WAVE_API_KEY'); },
  async initier({ paiement, urls }) {
    if (!this.configure()) throw nonConfigure('Wave', ['WAVE_API_KEY']);
    const base = process.env.WAVE_API_BASE || 'https://api.wave.com';
    const data = await postJson(`${base}/v1/checkout/sessions`, {
      headers: { Authorization: `Bearer ${process.env.WAVE_API_KEY}` },
      body: {
        amount: String(Math.round(paiement.montant)),
        currency: process.env.WAVE_CURRENCY || 'XOF',
        client_reference: paiement.token,
        success_url: urls.success,
        error_url: urls.error
      }
    });
    return { paymentUrl: data.wave_launch_url || data.launch_url, providerRef: data.id };
  },
  lireWebhook(req) {
    const secret = process.env.WAVE_WEBHOOK_SECRET;
    if (secret) {
      const header = req.get('Wave-Signature') || '';
      const parts = Object.fromEntries(header.split(',').map(s => s.split('=').map(x => x && x.trim())));
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const expected = crypto.createHmac('sha256', secret).update(`${parts.t || ''}${raw}`).digest('hex');
      const given = parts.v1 || '';
      if (!given || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given.padEnd(expected.length).slice(0, expected.length))))
        throw new Error('Signature Wave invalide');
    }
    const ev = req.body || {};
    const d = ev.data || ev;
    const token = d.client_reference || d.clientReference;
    if (!token) throw new Error('Référence client manquante');
    const ok = (ev.type ? ev.type.includes('completed') || ev.type.includes('succeeded') : true)
      && (d.payment_status ? d.payment_status === 'succeeded' : true)
      && (d.status ? d.status !== 'failed' : true);
    return { token, providerRef: d.id || null, statut: ok ? 'valide' : 'echoue' };
  }
};

// ── Orange Money (Web Payment, Sénégal) ──
// OAuth client_credentials puis POST .../webpayment. Notification serveur → /webhook/orange_money.
const orangeMoney = {
  id: 'orange_money', label: 'Orange Money',
  configure() { return has('OM_AUTHORIZATION', 'OM_MERCHANT_KEY'); },
  async initier({ paiement, urls }) {
    if (!this.configure()) throw nonConfigure('Orange Money', ['OM_AUTHORIZATION', 'OM_MERCHANT_KEY']);
    const base = process.env.OM_API_BASE || 'https://api.orange.com';
    const tok = await postJson(`${base}/oauth/v3/token`, {
      headers: { Authorization: process.env.OM_AUTHORIZATION, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const env = process.env.OM_ENV || 'prod';
    const data = await postJson(`${base}/orange-money-webpay/${env}/v1/webpayment`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      body: {
        merchant_key: process.env.OM_MERCHANT_KEY,
        currency: process.env.OM_CURRENCY || 'XOF',
        order_id: paiement.token,
        amount: Math.round(paiement.montant),
        return_url: urls.success,
        cancel_url: urls.error,
        notif_url: urls.notif,
        lang: 'fr',
        reference: 'mGlobal Business'
      }
    });
    return { paymentUrl: data.payment_url, providerRef: data.pay_token || data.txnid || null };
  },
  lireWebhook(req) {
    const b = req.body || {};
    const token = b.order_id || b.reference;
    if (!token) throw new Error('order_id manquant');
    const ok = String(b.status || '').toUpperCase() === 'SUCCESS';
    return { token, providerRef: b.txnid || null, statut: ok ? 'valide' : 'echoue' };
  }
};

// ── Yas (Yas Money) ──
// API configurable (base + clé). À ajuster selon le contrat fourni par Yas ;
// par défaut le connecteur est inactif tant que les variables ne sont pas définies.
const yas = {
  id: 'yas', label: 'Yas',
  configure() { return has('YAS_API_KEY', 'YAS_API_BASE'); },
  async initier({ paiement, urls }) {
    if (!this.configure()) throw nonConfigure('Yas', ['YAS_API_KEY', 'YAS_API_BASE']);
    const data = await postJson(`${process.env.YAS_API_BASE}/payments`, {
      headers: { Authorization: `Bearer ${process.env.YAS_API_KEY}` },
      body: {
        amount: Math.round(paiement.montant),
        currency: process.env.YAS_CURRENCY || 'XOF',
        reference: paiement.token,
        callback_url: urls.notif,
        return_url: urls.success,
        cancel_url: urls.error
      }
    });
    return { paymentUrl: data.payment_url || data.checkout_url, providerRef: data.id || data.transaction_id || null };
  },
  lireWebhook(req) {
    const b = req.body || {};
    const token = b.reference || b.order_id;
    if (!token) throw new Error('Référence manquante');
    const ok = ['success', 'succeeded', 'valide', 'completed'].includes(String(b.status || '').toLowerCase());
    return { token, providerRef: b.id || b.transaction_id || null, statut: ok ? 'valide' : 'echoue' };
  }
};

const FOURNISSEURS = { simulation, wave, orange_money: orangeMoney, yas };

export function getFournisseur(nom) {
  return FOURNISSEURS[nom || PROVIDER] || simulation;
}

// Liste des fournisseurs proposés à l'interface (simulation masquée hors mode démo).
export function fournisseursDisponibles() {
  return Object.values(FOURNISSEURS)
    .filter(f => f.id !== 'simulation' || PROVIDER === 'simulation')
    .map(f => ({ id: f.id, label: f.label, configure: f.configure() }));
}
