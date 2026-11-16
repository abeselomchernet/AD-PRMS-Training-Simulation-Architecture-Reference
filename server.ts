import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type ArifPayServerSession,
  OfficeSqliteStore,
  type SyncEventPayload,
} from './server/officeStore.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

function verifyOptionalArifPaySignature(rawBody: string, signatureHeader: string): boolean {
  const secret = process.env.ARIFPAY_WEBHOOK_SECRET || '';
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader.trim()));
  } catch {
    return false;
  }
}

function verifyOptionalTelebirrSignature(payload: Record<string, unknown>): boolean {
  const publicKeyPem = process.env.TELEBIRR_PUBLIC_KEY_PEM || '';
  if (!publicKeyPem) return true;
  const sig = String(payload.sign || '');
  if (!sig) return false;
  const canonical = Object.keys(payload)
    .filter((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '' && k !== 'sign' && k !== 'sign_type')
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join('&');
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(canonical);
    return verifier.verify(publicKeyPem, sig, 'base64');
  } catch {
    return false;
  }
}

async function startServer() {
  const store = new OfficeSqliteStore(
    path.resolve(import.meta.dirname, '.data'),
    process.env.OFFICE_DB_PATH
  );

  const app = express();

  // Raw binary route for local evidence uploads (before express.json)
  app.post(
    '/api/office/uploads',
    express.raw({
      type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      limit: '11mb',
    }),
    (req, res) => {
      const mimeType = String(req.headers['content-type'] || '').split(';')[0].trim();
      const rawName = String(req.headers['x-file-name'] || 'evidence');
      let filename = 'evidence';
      try {
        filename = decodeURIComponent(rawName);
      } catch {
        filename = rawName;
      }
      const ownerId = String(req.headers['x-owner-id'] || 'OWN-ALPHA');
      const entityType = String(req.headers['x-entity-type'] || 'GENERAL');
      const entityRefId = String(req.headers['x-entity-ref-id'] || '');

      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: true, msg: 'Binary file body is required.' });
        return;
      }

      const saved = store.saveUploadedFile({
        ownerId,
        entityType,
        entityRefId,
        filename,
        mimeType,
        buffer: req.body,
      });

      if (!saved.ok) {
        res.status(400).json({ error: true, msg: saved.error });
        return;
      }

      res.status(200).json({
        ok: true,
        fileId: saved.file.fileId,
        objectKey: `office-vault/${saved.file.ownerId.toLowerCase()}/${saved.file.fileId}`,
        url: `/api/office/uploads/${saved.file.fileId}`,
        filename: saved.file.filename,
        mimeType: saved.file.mimeType,
        sizeBytes: saved.file.sizeBytes,
        sha256: saved.file.sha256,
        createdAt: saved.file.createdAt,
      });
    }
  );

  app.use(express.json({ limit: '15mb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  const broadcastSyncEvent = (event: SyncEventPayload) => {
    const inserted = store.recordSyncEvent(event);
    if (!inserted) return;

    const encoded = JSON.stringify({ kind: 'sync:event', event });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    });
  };

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        kind: 'sync:hello',
        serverTime: new Date().toISOString(),
        connectedClients: wss.clients.size,
        recentEvents: store.getRecentSyncEvents(20),
      })
    );

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as {
          kind?: string;
          event?: SyncEventPayload;
        };
        if (parsed.kind === 'sync:publish' && parsed.event && parsed.event.eventId) {
          broadcastSyncEvent(parsed.event);
          ws.send(JSON.stringify({ kind: 'sync:ack', eventId: parsed.event.eventId }));
        }
      } catch {
        // Ignore malformed socket frames cleanly
      }
    });
  });

  app.get('/api/health', (_req, res) => {
    const wsState = store.getWorkspaceState();
    res.json({
      ok: true,
      mode: 'AD-PRMS Office Test & Training Server (SQLite)',
      sqlite: true,
      revision: wsState.revision,
      uploadsCount: store.getUploadsCount(),
      pushSubscribers: store.getPushSubscribersCount(),
      connectedClients: wss.clients.size,
      timestamp: new Date().toISOString(),
    });
  });

  // --------------------------------------------------------------------------
  // Persistent Office SQLite State API
  // --------------------------------------------------------------------------
  app.get('/api/office/state', (_req, res) => {
    res.json(store.getWorkspaceState());
  });

  app.put('/api/office/state', (req, res) => {
    const body = (req.body || {}) as {
      state?: Record<string, unknown>;
      updatedBy?: string;
      onlyIfUninitialized?: boolean;
      expectedRevision?: number;
      originClientId?: string;
      ownerId?: string;
    };
    if (!body.state || typeof body.state !== 'object') {
      res.status(400).json({ error: true, msg: 'Valid state object is required.' });
      return;
    }

    const saved = store.saveWorkspaceState(
      body.state,
      String(body.updatedBy || 'office-client'),
      Boolean(body.onlyIfUninitialized),
      typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
    );

    if (saved.conflict) {
      res.status(409).json({
        error: true,
        conflict: true,
        currentRevision: saved.revision,
        updatedAt: saved.updatedAt,
        msg: 'Workspace revision conflict. Reload latest SQLite state before saving.',
      });
      return;
    }

    if (!saved.reusedExisting) {
      broadcastSyncEvent({
        eventId: `EVT-STATE-${saved.revision}-${Date.now()}`,
        type: 'state:synced',
        ownerId: String(body.ownerId || 'OWN-ALPHA'),
        originClientId: body.originClientId,
        timestamp: saved.updatedAt,
        data: { revision: saved.revision, updatedBy: body.updatedBy || 'office-client' },
      });
    }

    res.json({
      ok: true,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
      reusedExisting: saved.reusedExisting,
    });
  });

  app.post('/api/office/reset', (req, res) => {
    const body = (req.body || {}) as {
      state?: Record<string, unknown>;
      resetBy?: string;
      originClientId?: string;
      ownerId?: string;
    };
    const resetBy = String(body.resetBy || '').trim();
    const roleHeader = String(req.headers['x-office-role'] || '').trim();
    const isAuthorizedTrainer =
      resetBy === 'trainer.demo' || roleHeader === 'Training Coordinator';
    if (!isAuthorizedTrainer) {
      res.status(403).json({
        error: true,
        msg: 'Seed reset is restricted to Training Coordinator (trainer.demo).',
      });
      return;
    }
    if (!body.state || typeof body.state !== 'object') {
      res.status(400).json({ error: true, msg: 'Initial seed state is required for reset.' });
      return;
    }
    const saved = store.resetWorkspaceState(body.state, resetBy || 'trainer.demo');
    broadcastSyncEvent({
      eventId: `EVT-RESET-${saved.revision}-${Date.now()}`,
      type: 'state:reset',
      ownerId: String(body.ownerId || 'OWN-ALPHA'),
      originClientId: body.originClientId,
      timestamp: saved.updatedAt,
      data: { revision: saved.revision, resetBy: resetBy || 'trainer.demo' },
    });
    res.json({ ok: true, revision: saved.revision, updatedAt: saved.updatedAt });
  });

  // --------------------------------------------------------------------------
  // Normalized Double-Entry Ledger API (SQLite)
  // --------------------------------------------------------------------------
  app.get('/api/office/ledger/summary', (req, res) => {
    const ownerId = String(req.query.ownerId || req.headers['x-owner-id'] || 'OWN-ALPHA');
    res.json(store.getLedgerSummary(ownerId));
  });

  app.get('/api/office/ledger/accounts', (req, res) => {
    const ownerId = String(req.query.ownerId || req.headers['x-owner-id'] || 'OWN-ALPHA');
    res.json({ ok: true, ownerId, accounts: store.listLedgerAccountsSql(ownerId) });
  });

  app.get('/api/office/ledger/journals', (req, res) => {
    const ownerId = String(req.query.ownerId || req.headers['x-owner-id'] || 'OWN-ALPHA');
    const accountCodePrefix = req.query.accountPrefix ? String(req.query.accountPrefix) : undefined;
    const periodCode = req.query.periodCode ? String(req.query.periodCode) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json({
      ok: true,
      ownerId,
      journals: store.listLedgerJournalsSql(ownerId, { accountCodePrefix, periodCode, limit }),
    });
  });

  app.get('/api/office/ledger/trial-balance', (req, res) => {
    const ownerId = String(req.query.ownerId || req.headers['x-owner-id'] || 'OWN-ALPHA');
    const periodCode = req.query.periodCode ? String(req.query.periodCode) : undefined;
    res.json(store.getLedgerTrialBalanceSql(ownerId, periodCode));
  });

  app.post('/api/office/ledger/post', (req, res) => {
    const body = (req.body || {}) as {
      ownerId?: string;
      entryDate?: string;
      periodCode?: string;
      ruleId?: string;
      sourceType?: string;
      sourceId?: string;
      idempotencyKey?: string;
      description?: string;
      makerActorId?: string;
      checkerActorId?: string;
      lines?: Array<{ accountCode: string; accountName?: string; debitCents: number; creditCents: number }>;
    };
    const result = store.postLedgerJournalSql({
      ownerId: String(body.ownerId || 'OWN-ALPHA'),
      entryDate: String(body.entryDate || new Date().toISOString().slice(0, 10)),
      periodCode: String(body.periodCode || '2019-03'),
      ruleId: String(body.ruleId || 'Manual'),
      sourceType: String(body.sourceType || 'ManualJournal'),
      sourceId: String(body.sourceId || ''),
      idempotencyKey: String(body.idempotencyKey || `API-${Date.now()}`),
      description: String(body.description || 'SQLite ledger entry'),
      makerActorId: String(body.makerActorId || 'SYSTEM'),
      checkerActorId: body.checkerActorId ? String(body.checkerActorId) : undefined,
      lines: Array.isArray(body.lines) ? body.lines : [],
    });
    if (!result.ok) {
      res.status(400).json({ error: true, msg: result.error });
      return;
    }
    res.json(result);
  });

  app.post('/api/office/ledger/reverse', (req, res) => {
    const body = (req.body || {}) as {
      ownerId?: string;
      journalId?: string;
      entryDate?: string;
      periodCode?: string;
      reason?: string;
      makerActorId?: string;
      checkerActorId?: string;
    };
    const result = store.reverseLedgerJournalSql({
      ownerId: String(body.ownerId || 'OWN-ALPHA'),
      journalId: String(body.journalId || ''),
      entryDate: String(body.entryDate || new Date().toISOString().slice(0, 10)),
      periodCode: String(body.periodCode || '2019-03'),
      reason: String(body.reason || 'PR-25 Mirror Reversal'),
      makerActorId: String(body.makerActorId || ''),
      checkerActorId: String(body.checkerActorId || ''),
    });
    if (!result.ok) {
      res.status(400).json({ error: true, msg: result.error });
      return;
    }
    res.json(result);
  });

  app.post('/api/office/ledger/period-close', (req, res) => {
    const body = (req.body || {}) as {
      ownerId?: string;
      periodCode?: string;
      closedBy?: string;
      makerActorId?: string;
      checkerActorId?: string;
    };
    const result = store.requestPeriodCloseSql({
      ownerId: String(body.ownerId || 'OWN-ALPHA'),
      periodCode: String(body.periodCode || '2019-03'),
      closedBy: String(body.closedBy || 'Demo General Manager'),
      makerActorId: String(body.makerActorId || 'USR-SYNTH-03'),
      checkerActorId: String(body.checkerActorId || 'USR-SYNTH-02'),
    });
    if (!result.ok) {
      res.status(400).json({ error: true, msg: result.error });
      return;
    }
    res.json(result);
  });

  app.get('/api/office/ledger/manifest', (req, res) => {
    const ownerId = String(req.query.ownerId || req.headers['x-owner-id'] || 'OWN-ALPHA');
    res.json(store.getBackupLedgerManifest(ownerId));
  });

  // --------------------------------------------------------------------------
  // Local Evidence Vault Retrieval & Listing
  // --------------------------------------------------------------------------
  app.get('/api/office/uploads', (req, res) => {
    const ownerId =
      typeof req.query.ownerId === 'string'
        ? req.query.ownerId
        : typeof req.headers['x-owner-id'] === 'string'
          ? req.headers['x-owner-id']
          : undefined;
    res.json({ ok: true, files: store.listUploadedFiles(ownerId) });
  });

  app.get('/api/office/uploads/:fileId', (req, res) => {
    const file = store.getUploadedFile(req.params.fileId);
    if (!file) {
      res.status(404).json({ error: true, msg: 'Evidence file not found.' });
      return;
    }
    const requestedOwner =
      typeof req.query.ownerId === 'string'
        ? req.query.ownerId
        : typeof req.headers['x-owner-id'] === 'string'
          ? req.headers['x-owner-id']
          : undefined;
    if (requestedOwner && requestedOwner !== file.meta.ownerId) {
      res.status(403).json({ error: true, msg: 'Forbidden cross-owner upload access.' });
      return;
    }
    res.setHeader('Content-Type', file.meta.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${file.meta.filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(file.buffer);
  });

  // --------------------------------------------------------------------------
  // Zero-Key Local VAPID Web Push API
  // --------------------------------------------------------------------------
  app.get('/api/office/push/vapid-key', (_req, res) => {
    res.json({
      ok: true,
      publicKey: store.getVapidPublicKey(),
      mode: 'local-sqlite-vapid',
    });
  });

  app.post('/api/office/push/subscribe', (req, res) => {
    const body = (req.body || {}) as {
      endpoint?: string;
      p256dh?: string;
      auth?: string;
      device_label?: string;
      deviceLabel?: string;
      ownerId?: string;
      actorId?: string;
    };
    if (!body.endpoint || !body.p256dh || !body.auth) {
      res.status(400).json({ error: true, msg: 'endpoint, p256dh, and auth are required.' });
      return;
    }
    const saved = store.savePushSubscription({
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      deviceLabel: body.deviceLabel || body.device_label || 'AD-PRMS Device',
      ownerId: body.ownerId,
      actorId: body.actorId,
    });
    res.status(200).json({ ok: true, id: saved.endpoint, totalSubscribers: store.getPushSubscribersCount() });
  });

  app.delete('/api/office/push/subscribe', (req, res) => {
    const body = (req.body || {}) as { endpoint?: string };
    if (body.endpoint) {
      store.removePushSubscription(body.endpoint);
    }
    res.json({ ok: true, totalSubscribers: store.getPushSubscribersCount() });
  });

  app.post('/api/office/push/send', async (req, res) => {
    const body = (req.body || {}) as {
      title?: string;
      body?: string;
      url?: string;
      tag?: string;
      ownerId?: string;
    };
    const result = await store.sendPushNotifications({
      title: body.title || 'AD-PRMS Office Test Alert',
      body: body.body || 'Background Web Push is active via local SQLite VAPID.',
      url: body.url || '/',
      tag: body.tag || 'adprms-office-push',
      ownerId: body.ownerId,
    });
    res.json({ ok: true, mode: 'local-sqlite-vapid', ...result });
  });

  // --------------------------------------------------------------------------
  // Simulated Tenant Phone OTP (Office Test & Training Mode)
  // --------------------------------------------------------------------------
  app.post('/api/office/auth/tenant/otp/request', (req, res) => {
    const body = (req.body || {}) as { msisdn?: string; locale?: 'en' | 'am' };
    const result = store.requestSimulatedTenantOtp(String(body.msisdn || ''), body.locale || 'en');
    if (!result.ok) {
      res.status(400).json({ error: true, detail: result.error });
      return;
    }

    broadcastSyncEvent({
      eventId: `EVT-OTP-${Date.now()}`,
      type: 'sms:dispatched',
      ownerId: result.matchedAccount?.ownerId || 'OWN-ALPHA',
      timestamp: new Date().toISOString(),
      data: {
        count: 1,
        msisdn: result.msisdn,
        mode: 'OFFICE TEST SANDBOX OTP — NO LIVE TELCO',
      },
    });

    res.json({
      ok: true,
      msisdn: result.msisdn,
      sandboxOtpCode: result.code,
      matchedAccount: result.matchedAccount,
      detail: `Sandbox SMS OTP ${result.code} logged to SQLite SMS Outbox for ${result.msisdn}.`,
    });
  });

  app.post('/api/office/auth/tenant/otp/verify', (req, res) => {
    const body = (req.body || {}) as { msisdn?: string; code?: string };
    const result = store.verifySimulatedTenantOtp(String(body.msisdn || ''), String(body.code || ''));
    if (!result.ok || !result.account) {
      res.status(400).json({ error: true, detail: result.error || 'OTP verification failed.' });
      return;
    }
    res.json({
      ok: true,
      msisdn: result.msisdn,
      account: result.account,
    });
  });

  // --------------------------------------------------------------------------
  // ArifPay, Telebirr & SMS Sandbox Routes (Persisted in SQLite)
  // --------------------------------------------------------------------------
  app.post('/api/gateways/arifpay/session', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const nonce = String(body.nonce || `AP-NONCE-${Date.now()}`);
    const existing = store.getArifPaySessionByNonce(nonce);
    if (existing) {
      res.status(200).json({ error: false, reused: true, data: existing });
      return;
    }

    const amountEtb = Number(body.amountEtb || 0);
    if (!Number.isFinite(amountEtb) || amountEtb <= 0) {
      res.status(400).json({ error: true, msg: 'Invalid amountEtb for ArifPay sandbox session.' });
      return;
    }

    const sessionId = `AP-SESS-${Math.floor(100000 + Math.random() * 900000)}`;
    const transactionId = `AP-TX-${Math.floor(1000000 + Math.random() * 9000000)}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const session: ArifPayServerSession = {
      sessionId,
      nonce,
      ownerId: String(body.ownerId || 'OWN-ALPHA'),
      tenantId: String(body.tenantId || ''),
      chargeId: String(body.chargeId || ''),
      amountEtb,
      paymentMethods: Array.isArray(body.paymentMethods)
        ? body.paymentMethods.map(String)
        : ['TELEBIRR', 'CBE'],
      checkoutUrl: `https://gateway.arifpay.org/sandbox/checkout/${sessionId}`,
      status: 'PENDING',
      transactionId,
      createdAt,
      expiresAt,
    };
    store.upsertArifPaySession(session);
    res.status(200).json({ error: false, reused: false, data: session });
  });

  app.post('/api/gateways/arifpay/verify', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) {
      res.status(400).json({ error: true, msg: 'sessionId is required.' });
      return;
    }
    const session = store.getArifPaySessionById(sessionId);
    if (!session) {
      res.status(404).json({ error: true, msg: 'ArifPay session not found.' });
      return;
    }
    session.status = 'COMPLETED';
    store.upsertArifPaySession(session);
    res.status(200).json({ error: false, data: session });
  });

  app.post('/api/webhooks/arifpay', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const sig = String(req.headers['x-arifpay-signature'] || '');
    if (!verifyOptionalArifPaySignature(JSON.stringify(body), sig)) {
      res.status(403).json({ error: true, msg: 'Invalid ArifPay webhook signature.' });
      return;
    }
    const sessionId = String(body.sessionId || '');
    const session = store.getArifPaySessionById(sessionId);
    if (session) {
      session.status = 'COMPLETED';
      store.upsertArifPaySession(session);
    }
    const ownerId = String(body.ownerId || session?.ownerId || 'OWN-ALPHA');
    const amountEtb = Number(body.amountEtb || session?.amountEtb || 0);
    broadcastSyncEvent({
      eventId: `EVT-AP-${Date.now()}`,
      type: 'payment:settled',
      ownerId,
      timestamp: new Date().toISOString(),
      data: {
        gateway: 'ArifPay Checkout',
        sessionId,
        transactionId: String(body.transactionId || session?.transactionId || ''),
        amountEtb,
        status: String(body.status || 'COMPLETED'),
        signatureVerified: Boolean(process.env.ARIFPAY_WEBHOOK_SECRET),
      },
    });
    void store.sendPushNotifications({
      title: 'ArifPay Sandbox Settlement',
      body: `ETB ${amountEtb.toLocaleString()} settled in Office Test Mode.`,
      ownerId,
      tag: `arifpay-${sessionId}`,
    });
    res.status(200).json({ received: true, provider: 'ArifPay Sandbox (SQLite)' });
  });

  app.post('/api/webhooks/telebirr', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!verifyOptionalTelebirrSignature(body)) {
      res.status(403).json({ error: true, msg: 'Invalid Telebirr RSA signature.' });
      return;
    }
    const ownerId = String(body.ownerId || 'OWN-ALPHA');
    broadcastSyncEvent({
      eventId: `EVT-TB-${Date.now()}`,
      type: 'payment:settled',
      ownerId,
      timestamp: new Date().toISOString(),
      data: {
        gateway: 'Telebirr USSD QR',
        ...body,
        signatureVerified: Boolean(process.env.TELEBIRR_PUBLIC_KEY_PEM),
      },
    });
    res.status(200).json({ received: true, provider: 'Telebirr Sandbox (SQLite)' });
  });

  app.post('/api/sms/dispatch', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const ownerId = String(body.ownerId || 'OWN-ALPHA');
    const logged = store.logSmsOutbox({
      ownerId,
      msisdn: String(body.msisdn || '+251900000000'),
      triggerType: String(body.triggerType || 'General Notice'),
      locale: String(body.locale || 'en'),
      body: String(body.body || `Batch dispatch (${Number(body.count || 1)} recipient(s))`),
    });
    broadcastSyncEvent({
      eventId: `EVT-SMS-${Date.now()}`,
      type: 'sms:dispatched',
      ownerId,
      timestamp: logged.createdAt,
      data: {
        dispatchId: logged.id,
        count: Number(body.count || 1),
        mode: 'SANDBOX DISPATCH — NO LIVE TELCO',
      },
    });
    res.status(200).json({
      ok: true,
      dispatchId: logged.id,
      mode: 'SANDBOX DISPATCH — NO LIVE TELCO',
    });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: {
          server,
          path: '/vite-hmr',
        },
        hmr:
          process.env.DISABLE_HMR === 'true'
            ? false
            : {
                server,
                path: '/vite-hmr',
              },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(import.meta.dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `AD-PRMS Office Test & Training Server (SQLite) listening on http://0.0.0.0:${PORT}`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start AD-PRMS server:', err);
  process.exit(1);
});
