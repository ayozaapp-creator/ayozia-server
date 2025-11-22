// server/routes/media.js
const path = require("path");
const fs = require("fs");
const { Router } = require("express");
const multer = require("multer");

const router = Router();

const UPLOAD_DIR = path.join(__dirname, "../uploads");
const MEDIA_DIR  = path.join(UPLOAD_DIR, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `media_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/|^video\//.test(file.mimetype || "");
    if (!ok) return cb(new Error("Nur Bild/Video erlaubt"));
    cb(null, true);
  },
});

// POST /chat/:chatId/media  -> FormData: file (+ optional width,height,kind)
router.post("/chat/:chatId/media", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
    const url  = `${base.replace(/\/$/,"")}/uploads/media/${req.file.filename}`;

    const mime = req.file.mimetype || "";
    const kind =
      mime.startsWith("image/") ? "image" :
      mime.startsWith("video/") ? "video" : "unknown";

    const width  = req.body?.width  ? Number(req.body.width)  : undefined;
    const height = req.body?.height ? Number(req.body.height) : undefined;

    return res.json({
      url,
      kind,
      width:  Number.isFinite(width)  ? width  : undefined,
      height: Number.isFinite(height) ? height : undefined,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;
