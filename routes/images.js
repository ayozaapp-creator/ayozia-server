// server/routes/images.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const router = express.Router();

/* ───── Pfade / Dateien ───── */
const ROOT = path.join(__dirname, "..");            // /server
const DATA_DIR = ROOT;                              // users.json, images.json im /server
const USERS_FILE  = path.join(DATA_DIR, "users.json");
const IMAGES_FILE = path.join(DATA_DIR, "images.json");

const UPLOADS_DIR = path.join(ROOT, "uploads");
const MEDIA_DIR   = path.join(UPLOADS_DIR, "media");
const IMAGES_DIR  = path.join(MEDIA_DIR, "images");

// Ordner sichern
for (const d of [UPLOADS_DIR, MEDIA_DIR, IMAGES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ───── Helpers ───── */
function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, "utf-8");
    return JSON.parse(txt);
  } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function userExists(id) {
  const users = safeReadJSON(USERS_FILE, []);
  return users.some((u) => String(u.id) === String(id));
}

function toAbs(req, relOrAbs) {
  if (!relOrAbs) return relOrAbs;
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const base = `${req.protocol}://${req.headers.host}`.replace(/\/$/, "");
  const rel  = relOrAbs.startsWith("/") ? relOrAbs : `/${relOrAbs}`;
  return `${base}${rel}`;
}

// disk path von image-record ableiten
function resolveImageDiskPath(item) {
  // Standard: url ist ABSOLUT, beginnt mit http.../uploads/media/images/DATEI
  if (item?.url) {
    const rel = item.url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/?uploads\//, "");
    return path.join(UPLOADS_DIR, rel);
  }
  // Fallback: relPath gespeichert?
  if (item?.relPath) return path.join(UPLOADS_DIR, item.relPath);
  return null;
}
function fileExists(p) {
  try { return !!(p && fs.existsSync(p)); } catch { return false; }
}
function filterExisting(list) {
  return list.filter((it) => fileExists(resolveImageDiskPath(it)));
}

/* ───── Multer (Image Upload) ───── */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const userId = String(req.params.id || "unk");
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const name = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});
function fileFilter(_req, file, cb) {
  const ok = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype || "");
  if (!ok) return cb(new Error("Nur Bilder erlaubt (jpg, jpeg, png, webp)"), false);
  cb(null, true);
}
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* Daten-Shape:
   images.json: Array<{ id, userId, url(abs), kind:'image', createdAt, width?, height? }>
*/

/* ───── GET: alle Bilder eines Users (nur existierende Dateien) ─────
   Optional: ?sanitize=1 -> entfernt fehlende Records dauerhaft aus images.json
*/
router.get("/users/:id/images", (req, res) => {
  try {
    const userId = String(req.params.id);
    if (!userId) return res.status(400).json({ message: "Fehlende user-id" });
    if (!userExists(userId)) return res.status(404).json({ message: "User nicht gefunden" });

    const all = safeReadJSON(IMAGES_FILE, []);
    const list = all
      .filter((it) => String(it.userId) === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const kept = filterExisting(list);

    if (String(req.query.sanitize || "0") === "1" && kept.length !== list.length) {
      const whole = safeReadJSON(IMAGES_FILE, []);
      const keepIds = new Set(kept.map(x => x.id));
      const cleaned = whole.filter(x => keepIds.has(x.id) || String(x.userId) !== userId);
      writeJSON(IMAGES_FILE, cleaned);
    }

    // sicherstellen, dass URLs absolut sind
    const images = kept.map(it => ({
      ...it,
      url: toAbs(req, it.url || `/uploads/media/images/${path.basename(resolveImageDiskPath(it) || "")}`)
    }));

    return res.json({ images, removed: list.length - kept.length });
  } catch (e) {
    console.error("GET /users/:id/images ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei images-get" });
  }
});

/* ───── POST: Bild-Upload für User ───── */
router.post("/users/:id/images", upload.single("file"), (req, res) => {
  try {
    const userId = String(req.params.id);
    if (!userId) return res.status(400).json({ message: "Fehlende user-id" });
    if (!userExists(userId)) return res.status(404).json({ message: "User nicht gefunden" });
    if (!req.file) return res.status(400).json({ message: "Keine Datei erhalten (field: file)" });

    const relPath = `/uploads/media/images/${req.file.filename}`;
    const absUrl  = toAbs(req, relPath);

    const rec = {
      id: crypto.randomUUID(),
      userId,
      url: absUrl,                 // ABSOLUTE URL speichern
      relPath: `media/images/${req.file.filename}`, // zusätzlich für Cleanup
      kind: "image",
      createdAt: new Date().toISOString(),
      width: undefined,
      height: undefined,
    };

    const all = safeReadJSON(IMAGES_FILE, []);
    all.push(rec);
    writeJSON(IMAGES_FILE, all);

    return res.status(201).json(rec);
  } catch (e) {
    console.error("POST /users/:id/images ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei image-upload" });
  }
});

/* ───── Optional: globaler Cleanup ───── */
router.post("/admin/images/cleanup", (_req, res) => {
  const all = safeReadJSON(IMAGES_FILE, []);
  const kept = filterExisting(all);
  if (kept.length !== all.length) writeJSON(IMAGES_FILE, kept);
  res.json({ ok: true, removed: all.length - kept.length, kept: kept.length });
});

module.exports = router;
