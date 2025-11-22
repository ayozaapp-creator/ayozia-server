// server/routes/snippets.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const ROOT = path.join(__dirname, "..");
const SNIPPETS_FILE = path.join(ROOT, "snippets.json");

// ───────── Helpers ─────────
function readSnips() {
  if (!fs.existsSync(SNIPPETS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SNIPPETS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeSnips(list) {
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(list, null, 2));
}

const toAbs = (req, relOrAbs) => {
  if (!relOrAbs) return relOrAbs;
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const base = `${req.protocol}://${req.headers.host}`.replace(/\/$/, "");
  const rel = relOrAbs.startsWith("/") ? relOrAbs : `/${relOrAbs}`;
  return `${base}${rel}`;
};

// ───────── POST: Snippet zu einem Track anlegen ─────────
// Body: { userId, musicId, url, title?, thumbnail?, startMs?, durationMs? }
router.post("/snippets/from-music", (req, res) => {
  try {
    const { userId, musicId, url, title, thumbnail, startMs, durationMs } = req.body || {};
    console.log("POST /snippets/from-music body:", req.body);

    if (!userId || !musicId || !url) {
      return res.status(400).json({ message: "userId, musicId und url erforderlich" });
    }

    const list = readSnips();
    const id = crypto.randomUUID();

    const item = {
      id,
      userId: String(userId),
      musicId: String(musicId),
      url: String(url),
      title: title ? String(title) : null,
      thumbnail: thumbnail || null,
      startMs: Number.isFinite(Number(startMs)) ? Number(startMs) : 0,
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : 30_000,
      createdAt: new Date().toISOString(),
    };

    list.push(item);
    writeSnips(list);
    console.log("✅ Snippet gespeichert:", item.id);

    const absItem = { ...item, url: toAbs(req, item.url) };
    return res.status(201).json({ snippet: absItem });
  } catch (e) {
    console.error("POST /snippets/from-music ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei Snippet-Create" });
  }
});

// ───────── GET: alle Snippets eines Users ─────────
router.get("/users/:id/snippets", (req, res) => {
  try {
    const userId = String(req.params.id);
    const list = readSnips()
      .filter((s) => String(s.userId) === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const snippets = list.map((s) => ({
      ...s,
      url: toAbs(req, s.url),
    }));

    console.log(`GET /users/${userId}/snippets -> ${snippets.length} items`);
    return res.json({ snippets });
  } catch (e) {
    console.error("GET /users/:id/snippets ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei Snippet-Liste" });
  }
});

// ───────── GET: einzelnes Snippet (optional) ─────────
router.get("/snippets/:id", (req, res) => {
  try {
    const id = String(req.params.id);
    const list = readSnips();
    const item = list.find((s) => String(s.id) === id);
    if (!item) return res.status(404).json({ message: "Snippet nicht gefunden" });
    return res.json({ snippet: item });
  } catch (e) {
    console.error("GET /snippets/:id ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei Snippet-Detail" });
  }
});

module.exports = router;
