import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../lib/db.js';
import { requireAuth, requireRole, requireSite } from '../lib/auth.js';
import { newKey } from '../lib/db.js';

const r = Router();

// ══════════════════════════════════════════
// 1. VÉRIFICATION DE LICENCE (côté poste pont bascule)
// ══════════════════════════════════════════

// Le poste envoie son hardware_id au démarrage. Le cloud vérifie la licence et
// lie le matériel au premier appel (activation). Toute tentative de clonage
// (hardware_id différent) est refusée.
r.post('/check', requireSite, (req, res) => {
  const hwId = String(req.body?.hardware_id || '').trim();
  if (!hwId) return res.status(400).json({ error: 'hardware_id requis' });

  const lic = db.prepare(`SELECT * FROM licences WHERE site_id = ? ORDER BY id DESC LIMIT 1`)
    .get(req.site.id);
  if (!lic) return res.status(403).json({ status: 'NO_LICENSE', error: 'Aucune licence pour ce site' });

  // Licence révoquée ou expirée ?
  if (lic.status === 'REVOKED')
    return res.status(403).json({ status: 'REVOKED', error: 'Licence révoquée' });
  if (lic.status === 'EXPIRED' || (lic.expires_at && new Date(lic.expires_at) < new Date()))
    return res.status(403).json({ status: 'EXPIRED', error: 'Licence expirée' });

  // Première activation : lier le hardware_id
  if (!lic.hardware_id) {
    db.prepare(`UPDATE licences SET hardware_id = ?, activated_at = datetime('now') WHERE id = ?`)
      .run(hwId, lic.id);
    return res.json({ status: 'ACTIVE', message: 'Licence activée', license_key: lic.license_key });
  }

  // Anti-clonage : le hardware_id doit correspondre
  if (lic.hardware_id !== hwId)
    return res.status(403).json({ status: 'HARDWARE_MISMATCH',
      error: 'Matériel non reconnu. Cette licence est liée à un autre poste.' });

  res.json({
    status: 'ACTIVE',
    license_key: lic.license_key,
    expires_at: lic.expires_at || null
  });
});

// Statut de la licence (GET, sans hardware_id — simple consultation)
r.get('/status', requireSite, (req, res) => {
  const lic = db.prepare(`SELECT license_key, status, hardware_id, expires_at, activated_at
    FROM licences WHERE site_id = ? ORDER BY id DESC LIMIT 1`).get(req.site.id);
  if (!lic) return res.json({ status: 'NO_LICENSE' });
  const expired = lic.expires_at && new Date(lic.expires_at) < new Date();
  res.json({ ...lic, status: expired ? 'EXPIRED' : lic.status });
});

// ══════════════════════════════════════════
// 2. OTA — vérification de mise à jour
// ══════════════════════════════════════════

// Le poste envoie sa version actuelle, le cloud renvoie la dernière disponible.
r.get('/ota/check', requireSite, (req, res) => {
  const currentVersion = String(req.query.version || '0.0.0');
  const latest = db.prepare(`SELECT * FROM ota_updates ORDER BY id DESC LIMIT 1`).get();
  if (!latest) return res.json({ update_available: false });
  const available = latest.version !== currentVersion;
  res.json({
    update_available: available,
    ...(available ? {
      version: latest.version,
      url: latest.url || null,
      filename: latest.filename || null,
      changelog: latest.changelog || '',
      mandatory: !!latest.mandatory
    } : {})
  });
});

// ══════════════════════════════════════════
// 3. ADMINISTRATION DES LICENCES (super-admin)
// ══════════════════════════════════════════

r.get('/admin/all', requireAuth, requireRole('superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, s.nom AS site_nom, s.site_key, s.last_seen
    FROM licences l
    JOIN sites s ON s.id = l.site_id
    ORDER BY l.created_at DESC`).all();
  res.json(rows);
});

// Créer une licence pour un site
r.post('/admin', requireAuth, requireRole('superadmin'), (req, res) => {
  const { site_id, expires_at, note } = req.body || {};
  if (!site_id) return res.status(400).json({ error: 'site_id requis' });
  const site = db.prepare(`SELECT id FROM sites WHERE id = ?`).get(site_id);
  if (!site) return res.status(404).json({ error: 'Site introuvable' });
  const lk = 'LIC-' + newKey();
  db.prepare(`INSERT INTO licences (site_id, license_key, expires_at, note) VALUES (?,?,?,?)`)
    .run(site_id, lk, expires_at || null, note || null);
  res.json({ ok: true, license_key: lk });
});

// Modifier une licence (révoquer, prolonger, réinitialiser le hardware)
r.patch('/admin/:id', requireAuth, requireRole('superadmin'), (req, res) => {
  const lic = db.prepare(`SELECT * FROM licences WHERE id = ?`).get(req.params.id);
  if (!lic) return res.status(404).json({ error: 'Licence introuvable' });
  const { status, expires_at, reset_hardware, note } = req.body || {};
  if (status && ['ACTIVE', 'EXPIRED', 'REVOKED'].includes(status))
    db.prepare(`UPDATE licences SET status = ? WHERE id = ?`).run(status, lic.id);
  if (expires_at !== undefined)
    db.prepare(`UPDATE licences SET expires_at = ? WHERE id = ?`).run(expires_at || null, lic.id);
  if (reset_hardware)
    db.prepare(`UPDATE licences SET hardware_id = NULL, activated_at = NULL WHERE id = ?`).run(lic.id);
  if (note !== undefined)
    db.prepare(`UPDATE licences SET note = ? WHERE id = ?`).run(note, lic.id);
  res.json({ ok: true, licence: db.prepare(`SELECT * FROM licences WHERE id = ?`).get(lic.id) });
});

// Supprimer une licence
r.delete('/admin/:id', requireAuth, requireRole('superadmin'), (req, res) => {
  const info = db.prepare(`DELETE FROM licences WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Licence introuvable' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 4. ADMINISTRATION OTA (super-admin)
// ══════════════════════════════════════════

r.get('/admin/ota', requireAuth, requireRole('superadmin'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM ota_updates ORDER BY id DESC`).all());
});

r.post('/admin/ota', requireAuth, requireRole('superadmin'), (req, res) => {
  const { version, filename, url, changelog, mandatory } = req.body || {};
  if (!version) return res.status(400).json({ error: 'Version requise' });
  const info = db.prepare(`INSERT INTO ota_updates (version, filename, url, changelog, mandatory)
    VALUES (?,?,?,?,?)`).run(version, filename || null, url || null, changelog || '', mandatory ? 1 : 0);
  res.json({ ok: true, id: info.lastInsertRowid });
});

r.delete('/admin/ota/:id', requireAuth, requireRole('superadmin'), (req, res) => {
  const info = db.prepare(`DELETE FROM ota_updates WHERE id = ?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Mise à jour introuvable' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// 5. MOT DE PASSE JOURNALIER (offline)
// ══════════════════════════════════════════

// Génère un mot de passe temporaire basé sur la date du jour et un secret
// par distributeur. Utilisé pour l'accès offline au poste pont bascule.
function dailyPassword(secret, dateStr) {
  const hash = crypto.createHmac('sha256', secret)
    .update(dateStr || new Date().toISOString().slice(0, 10))
    .digest('hex');
  // 6 caractères numériques dérivés du hash
  return String(parseInt(hash.slice(0, 8), 16) % 1000000).padStart(6, '0');
}

// Super-admin : génère le mot de passe du jour pour un distributeur
r.get('/admin/daily-password/:distributeurId', requireAuth, requireRole('superadmin'), (req, res) => {
  const d = db.prepare(`SELECT id, nom, daily_password_secret FROM distributeurs WHERE id = ?`)
    .get(req.params.distributeurId);
  if (!d) return res.status(404).json({ error: 'Distributeur introuvable' });
  // Créer un secret s'il n'en a pas encore
  if (!d.daily_password_secret) {
    const secret = crypto.randomBytes(32).toString('hex');
    db.prepare(`UPDATE distributeurs SET daily_password_secret = ? WHERE id = ?`).run(secret, d.id);
    d.daily_password_secret = secret;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  res.json({
    distributeur: d.nom,
    date: dateStr,
    password: dailyPassword(d.daily_password_secret, dateStr)
  });
});

// Le poste vérifie un mot de passe journalier (avec siteKey pour identifier le distributeur)
r.post('/daily-password/verify', requireSite, (req, res) => {
  const { password, distributeur_id } = req.body || {};
  if (!password || !distributeur_id)
    return res.status(400).json({ error: 'password et distributeur_id requis' });
  const d = db.prepare(`SELECT daily_password_secret FROM distributeurs WHERE id = ?`)
    .get(distributeur_id);
  if (!d || !d.daily_password_secret)
    return res.status(404).json({ error: 'Pas de mot de passe journalier configuré' });
  const dateStr = new Date().toISOString().slice(0, 10);
  const expected = dailyPassword(d.daily_password_secret, dateStr);
  res.json({ valid: password === expected });
});

export default r;
