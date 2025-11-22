// server/routes/voice.js
const path = require("path");
const fs = require("fs");
const { Router } = require("express");
const multer = require("multer");

const router = Router();

// Ordner vorbereiten
const UPLOAD_DIR = path.join(__dirname, "../uploads");
const VOICE_DIR = path.join(UPLOAD_DIR, "voice");
fs.mkdirSync(VOICE_DIR, { recursive: true });

// Multer Storage für Voice-Dateien
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, VOICE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".m4a") || ".m4a";
    cb(null, `voice_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// POST /chat/:chatId/voice  <-- Client sendet "file" in FormData
router.post("/chat/:chatId/voice", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const base = process.env.PUBLIC_BASE_URL || "http://192.168.0.224:5000";
    const url = `${base}/uploads/voice/${req.file.filename}`;

    return res.json({ url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;
