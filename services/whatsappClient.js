import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { MongoStore } from './mongoStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tempDir = path.join(__dirname, '../.wwebjs_auth');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // Railway installs chromium via apt
  const paths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      console.log(`[Chrome] Found at: ${p}`);
      return p;
    }
  }
  console.warn('[Chrome] No Chrome binary found — Puppeteer will use its default');
  return undefined;
}

class WhatsAppClient {
  constructor() {
    this.client            = null;
    this.isReady           = false;
    this.qrCode            = null;
    this.qrDataUri         = null;
    this.qrReceivedAt      = null;
    this.reconnectAttempts = 0;
    this.baseDelay         = 15000;
    this.isInitializing    = false;
    this._sessionWiped     = false;
    this._stopped          = false;
    this._reconnectTimer   = null;
  }

  async initialize() {
    if (this.isInitializing) {
      console.log('[WhatsApp] Already initializing — skipping.');
      return;
    }
    this.isInitializing = true;
    this._stopped = false;

    try {
      console.log('[WhatsApp] Initializing...');

      if (this.client) {
        try { await this.client.destroy(); } catch {}
        this.client = null;
        await new Promise(r => setTimeout(r, 3000));
      }

      const store = new MongoStore({ verbose: true });

      this.client = new Client({
        authStrategy: new RemoteAuth({
          clientId: 'habit-tracker-bot',
          store,
          backupSyncIntervalMs: 60000,
          dataPath: tempDir,
        }),
        puppeteer: {
          headless: true,
          protocolTimeout: 600000,
          executablePath: getChromePath(),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--memory-pressure-off',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ],
        },
      });

      this.client.on('qr', async (qr) => {
        console.log('[WhatsApp] QR received — rendering PNG...');
        this.isReady      = false;
        this.qrCode       = qr;
        this.qrReceivedAt = Date.now();
        try {
          this.qrDataUri = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
          console.log('[WhatsApp] QR ready — 10 minutes to scan');
        } catch (err) {
          console.error('[WhatsApp] QR render failed:', err.message);
          this.qrDataUri = null;
        }
      });

      this.client.on('authenticated', () => {
        console.log('[WhatsApp] Authenticated — saving session...');
        this._sessionWiped = false;
        this._clearQR();
      });

      this.client.on('remote_session_saved', () => {
        console.log('[WhatsApp] Session saved to MongoDB — no re-scan needed on restart');
      });

      this.client.on('ready', () => {
        console.log('[WhatsApp] Ready!');
        this.isReady           = true;
        this.reconnectAttempts = 0;
        this.isInitializing    = false;
        this._clearQR();
      });

      this.client.on('auth_failure', async (msg) => {
        console.error('[WhatsApp] Auth failure:', msg);
        this.isReady        = false;
        this.isInitializing = false;
        if (!this._sessionWiped) {
          this._sessionWiped = true;
          await this._wipeDBSession();
        }
        this._scheduleReconnect();
      });

      this.client.on('disconnected', async (reason) => {
        console.log('[WhatsApp] Disconnected:', reason);
        this.isReady        = false;
        this.isInitializing = false;
        if ((reason === 'LOGOUT' || reason === 'CONFLICT') && !this._sessionWiped) {
          this._sessionWiped = true;
          await this._wipeDBSession();
        }
        this._scheduleReconnect();
      });

      await this.client.initialize();

    } catch (error) {
      console.error('[WhatsApp] Initialization error:', error.message);
      this.isInitializing = false;
      this._scheduleReconnect();
    }
  }

  _clearQR() {
    this.qrCode       = null;
    this.qrDataUri    = null;
    this.qrReceivedAt = null;
  }

  async _wipeDBSession() {
    try {
      const store = new MongoStore({ verbose: true });
      await store.delete({ session: 'RemoteAuth-habit-tracker-bot' });
      console.log('[WhatsApp] DB session wiped.');
    } catch (err) {
      console.error('[WhatsApp] Failed to wipe DB session:', err.message);
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const delay = Math.min(this.baseDelay * Math.pow(1.5, this.reconnectAttempts), 120000);
    this.reconnectAttempts++;
    console.log(`[WhatsApp] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.initialize();
    }, delay);
  }

  isConnected() { return this.isReady; }

  getQRCodeDataUri() {
    if (!this.qrDataUri || !this.qrReceivedAt) return null;
    if (Date.now() - this.qrReceivedAt > 10 * 60 * 1000) return null;
    return this.qrDataUri;
  }

  getQRExpiresIn() {
    if (!this.qrReceivedAt) return 0;
    return Math.max(0, Math.round((10 * 60 * 1000 - (Date.now() - this.qrReceivedAt)) / 1000));
  }

  getQRCode() { return this.qrCode; }

  async sendMessage(number, message) {
    if (!this.isReady) throw new Error('WhatsApp client is not ready');
    const chatId = `${number}@c.us`;
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('sendMessage timed out after 60s')), 60000)
    );
    await Promise.race([this.client.sendMessage(chatId, message), timeout]);
    console.log(`[WhatsApp] Sent to ${number}`);
    return { success: true };
  }

  async close() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.client) {
        await this.client.destroy();
        this.isReady = false;
      }
    } catch (err) {
      console.error('[WhatsApp] Error closing:', err.message);
    }
  }
}

export default new WhatsAppClient();