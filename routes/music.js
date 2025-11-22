// server/routes/music.js
// -------------------------------------------------------------
// Ayozia – Music Upload + User-Music
// Upload, /music, /users/:id/music
// Feed/Trending/Recent kommen zentral aus server.js (mit Stats)
// -------------------------------------------------------------
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const router = express.Router();

// -------------------------------------------------------------
// FIXED PATHS – GENAU wie in deinem server.js
// -------------------------------------------------------------
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const MUSIC_DIR = path.join(UPLOADS_DIR, "music");
const COVERS_DIR = path.join(UPLOADS_DIR, "covers");
const DB_PATH = path.join(__dirname, "..", "music.json");

// Ordner vorbereiten
for (const d of [UPLOADS_DIR, MUSIC_DIR, COVERS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// -------------------------------------------------------------
// Read + Write DB
// -------------------------------------------------------------
function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function readMusic() {
  if (!fs.existsSync(DB_PATH)) return [];
  const txt = fs.readFileSync(DB_PATH, "utf8");
  const arr = safeParseJSON(txt, []);
  return Array.isArray(arr) ? arr : [];
}

function writeMusic(list) {
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2));
}

// -------------------------------------------------------------
// Normalize Track – Basis-Daten (ohne Stats)
// -------------------------------------------------------------
function normalizeTrack(raw) {
  if (!raw) return null;

  const id = String(raw.id || crypto.randomUUID());
  const userId = String(raw.userId || "unknown");
  const title = String(raw.title || "Unbenannter Track");

  const relPath =
    raw.relPath ||
    raw.path ||
    (raw.filename ? `music/${raw.filename}` : null);

  const url = raw.url || (relPath ? `/uploads/${relPath}` : null);

  const coverRelPath =
    raw.coverRelPath ||
    (raw.cover && raw.cover.startsWith("/uploads/")
      ? raw.cover.replace(/^\/?uploads\//, "")
      : null);

  const cover =
    raw.cover ||
    (coverRelPath ? `/uploads/${coverRelPath}` : null);

  const createdAt = raw.createdAt
    ? new Date(raw.createdAt).toISOString()
    : new Date().toISOString();

  return {
    id,
    userId,
    title,
    relPath,
    url,
    cover,
    coverRelPath,
    createdAt,
    durationMs: raw.durationMs ?? null,
    snippetStartMs: raw.snippetStartMs ?? 0,
    snippetDurationMs: raw.snippetDurationMs ?? 30000,
    hasLyrics: !!raw.hasLyrics,
    // Stats werden in server.js aus trackStats.json gemerged
    likes: raw.likes ?? 0,
    plays: raw.plays ?? 0,
    saves: raw.saves ?? 0,
  };
}

// -------------------------------------------------------------
// Multer Upload – ALLES erlaubt (upload.any())
// -------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mime = file.mimetype || "";
    if (mime.startsWith("image/")) return cb(null, COVERS_DIR);
    if (mime.startsWith("audio/")) return cb(null, MUSIC_DIR);
    cb(null, MUSIC_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 70 * 1024 * 1024 },
});

// -------------------------------------------------------------
// POST /music/upload
// → Musik + Cover + Snippet-Daten speichern
// -------------------------------------------------------------
router.post("/music/upload", (req, res) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error("UPLOAD ERROR:", err);
      return res.status(400).json({ ok: false, message: err.message });
    }

    const files = req.files || [];

    const audioFile =
      files.find((f) => f.mimetype.startsWith("audio/")) ||
      files.find((f) => /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f.originalname));

    if (!audioFile) {
      return res
        .status(400)
        .json({ ok: false, message: "Keine Audiodatei erhalten" });
    }

    // Optional Cover
    const coverFile =
      files.find((f) => f.mimetype.startsWith("image/")) || null;

    const userId = String(req.body.userId || req.body.uid || "unknown");
    const title = String(req.body.title || audioFile.originalname);

    const snippetStartMs = parseInt(req.body.snippetStartMs || "0", 10);
    const snippetDurationMs = parseInt(
      req.body.snippetDurationMs || "30000",
      10
    );

    const relPath = `music/${audioFile.filename}`;
    const url = `/uploads/${relPath}`;

    let coverRelPath = null;
    let cover = null;

    if (coverFile) {
      coverRelPath = `covers/${coverFile.filename}`;
      cover = `/uploads/${coverRelPath}`;
    }

    const item = normalizeTrack({
      id: crypto.randomUUID(),
      userId,
      title,
      relPath,
      url,
      cover,
      coverRelPath,
      createdAt: new Date().toISOString(),
      snippetStartMs,
      snippetDurationMs,
      durationMs: null,
      likes: 0,
      plays: 0,
      hasLyrics: false,
    });

    const list = readMusic();
    list.push(item);
    writeMusic(list);

    const BASE = "http://192.168.0.224:5000";

    return res.json({
      ok: true,
      item,
      url: `${BASE}${item.url}`,
      cover: item.cover ? `${BASE}${item.cover}` : null,
    });
  });
});

// -------------------------------------------------------------
// GET /music → alle Songs (Basisdaten)
// GET /users/:id/music → Songs eines Users
// -------------------------------------------------------------
router.get("/music", (req, res) => {
  res.json({ items: readMusic().map(normalizeTrack).filter(Boolean) });
});

router.get("/users/:id/music", (req, res) => {
  const id = String(req.params.id);
  const list = readMusic().filter((t) => String(t.userId) === id);
  res.json({ music: list.map(normalizeTrack) });
});

// FEED / TRENDING / RECENT kommen **zentral aus server.js**
// (dort werden trackStats.json + music.json zusammengeführt)

module.exports = router;
