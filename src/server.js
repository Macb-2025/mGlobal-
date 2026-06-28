import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import './lib/db.js'; // initialise la base, les migrations et l'amorçage
import { initRealtime } from './lib/realtime.js';

import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import dashboardRouter from './routes/dashboard.js';
import dataRouter from './routes/data.js';
import bonsRouter from './routes/bons.js';
import ingestRouter from './routes/ingest.js';
import modulesRouter from './routes/modules.js';
import portailRouter from './routes/portail.js';
import espaceFournisseurRouter from './routes/espaceFournisseur.js';
import licenseRouter from './routes/license.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));

// Interfaces statiques (SPA distributeur + portails publics)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Sondes de santé
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// APIs applicatives
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/bons-commande', bonsRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api', portailRouter);   // portails publics (client / fournisseur) — sans auth
app.use('/api/espace-fournisseur', espaceFournisseurRouter); // espace fournisseur authentifié (compte super-admin)
app.use('/api', dataRouter);      // pesées, rapports, impression (auth JWT)
app.use('/api/license', licenseRouter); // licences anti-clonage + OTA + mot de passe journalier
app.use('/api', modulesRouter);   // modules métier (auth JWT + multi-tenant)

// Gestionnaire d'erreurs JSON
app.use((err, _req, res, _next) => {
  console.error('[erreur]', err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

const PORT = process.env.PORT || 3060;
const server = http.createServer(app);
initRealtime(server); // WebSocket temps réel (/ws)

server.listen(PORT, () => {
  console.log(`mGlobal Cloud opérationnel sur le port ${PORT}`);
});

export default app;
