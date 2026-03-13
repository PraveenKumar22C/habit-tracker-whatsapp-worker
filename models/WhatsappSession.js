import mongoose from 'mongoose';

const whatsappSessionSchema = new mongoose.Schema({
  sessionName: { type: String, required: true, unique: true },
  data:        { type: String, required: true },
  updatedAt:   { type: Date,   default: Date.now },
});

const WhatsAppSession = mongoose.model('WhatsAppSession', whatsappSessionSchema);
export default WhatsAppSession;