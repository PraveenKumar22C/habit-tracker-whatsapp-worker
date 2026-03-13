import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import whatsappClient from './services/whatsappClient.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Only allow requests from your Render backend
const WORKER_SECRET = process.env.WORKER_SECRET;

app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const secret = req.headers['x-worker-secret'];
  if (!WORKER_SECRET || secret !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

mongoose.connect(process.env.MONGODB_URI, { family: 4 })
  .then(() => console.log('[Worker] MongoDB connected'))
  .catch(err => console.error('[Worker] MongoDB error:', err));

// ── Routes ────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    whatsappConnected: whatsappClient.isConnected(),
    qrAvailable: !!whatsappClient.getQRCodeDataUri(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({ connected: whatsappClient.isConnected() });
});

app.get('/qr', (req, res) => {
  if (whatsappClient.isConnected()) {
    return res.json({ connected: true, qrCode: null, expiresIn: 0 });
  }
  const qrCode = whatsappClient.getQRCodeDataUri();
  const expiresIn = whatsappClient.getQRExpiresIn();
  if (!qrCode) {
    return res.json({ connected: false, qrCode: null, expiresIn: 0, message: 'QR not ready yet' });
  }
  res.json({ connected: false, qrCode, expiresIn });
});

app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'number and message are required' });
  }
  if (!whatsappClient.isConnected()) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    await whatsappClient.sendMessage(number, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Worker] Server running on port ${PORT}`);
  whatsappClient.initialize().catch(err => {
    console.warn('[Worker] WhatsApp init error (will retry):', err.message);
  });
});

process.on('SIGINT', async () => {
  await whatsappClient.close();
  process.exit(0);
});