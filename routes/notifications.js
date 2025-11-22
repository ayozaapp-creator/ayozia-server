// server/routes/notifications.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

// Speicherpfade
const ROOT = __dirname.endsWith("routes")
  ? path.join(__dirname, "..")
  : __dirname;
const NOTI_FILE = path.join(ROOT, "notifications.json");
const USERS_FILE = path.join(ROOT, "users.json");

// Helpers
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readUsers() {
  return readJson(USERS_FILE, []);
}
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username || "",
    avatarUrl: u.avatarUrl || null,
  };
}
function readNotis() {
  return readJson(NOTI_FILE, []);
}
function writeNotis(list) {
  writeJson(NOTI_FILE, list);
}

// ⇒ Public API für Server: createNotification(...)
function createNotification({
  toId,
  fromId,
  kind,          // 'message' | 'follow' | 'like' | 'comment'
  meta = {},     // { chatId, messageId, preview } usw.
  dedupeKey,     // optional: verhindert Duplikate (z.B. follow: A->B)
  ttlHours = 720 // 30 Tage aufbewahren
}) {
  if (!toId || !fromId || !kind) return null;

  const now = Date.now();
  const cutoff = now - ttlHours * 3600 * 1000;

  const list = readNotis().filter(n => new Date(n.createdAt).getTime() >= cutoff);

  // Dedupe (optional)
  if (dedupeKey && list.some(n => n.dedupeKey === String(dedupeKey))) {
    // Update timestamp, unread setzen
    for (const n of list) {
      if (n.dedupeKey === String(dedupeKey)) {
        n.createdAt = new Date().toISOString();
        n.read = false;
      }
    }
    writeNotis(list);
    return { deduped: true };
  }

  const users = readUsers();
  const actor = sanitizeUser(users.find(u => String(u.id) === String(fromId)));

  const item = {
    id: crypto.randomUUID(),
    toId: String(toId),
    fromId: String(fromId),
    kind: String(kind),
    meta,
    actor,                 // für UI: { id, username, avatarUrl }
    createdAt: new Date().toISOString(),
    read: false,
    dedupeKey: dedupeKey ? String(dedupeKey) : undefined,
  };

  list.push(item);
  // Max 500 pro User halten
  const byUser = list.filter(n => n.toId === String(toId));
  if (byUser.length > 500) {
    const overflow = byUser.length - 500;
    let removed = 0;
    for (let i = 0; i < list.length && removed < overflow; i++) {
      if (list[i].toId === String(toId)) {
        list.splice(i, 1);
        i--;
        removed++;
      }
    }
  }

  writeNotis(list);
  return item;
}

// ───────────── Routes ─────────────

// GET /notifications?userId=...&limit=20&cursor=<ISO>
// Sort: neu → alt, Pagination via cursor (ISO)
router.get("/notifications", (req, res) => {
  const userId = String(req.query.userId || "");
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "20", 10)));
  const cursor = req.query.cursor ? new Date(String(req.query.cursor)).getTime() : null;

  if (!userId) return res.status(400).json({ message: "userId erforderlich" });

  const list = readNotis()
    .filter(n => n.toId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const filtered = cursor
    ? list.filter(n => new Date(n.createdAt).getTime() < cursor)
    : list;

  const page = filtered.slice(0, limit);
  const nextCursor = page.length === limit
    ? page[page.length - 1].createdAt
    : null;

  return res.json({ items: page, nextCursor });
});

// GET /notifications/unread-count?userId=...
router.get("/notifications/unread-count", (req, res) => {
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).json({ message: "userId erforderlich" });
  const count = readNotis().filter(n => n.toId === userId && !n.read).length;
  res.json({ unread: count });
});

// POST /notifications/mark-all-read { userId }
router.post("/notifications/mark-all-read", (req, res) => {
  const userId = String((req.body && req.body.userId) || "");
  if (!userId) return res.status(400).json({ message: "userId erforderlich" });

  const list = readNotis();
  let changed = 0;
  for (const n of list) {
    if (n.toId === userId && !n.read) {
      n.read = true;
      changed++;
    }
  }
  writeNotis(list);
  res.json({ ok: true, changed });
});

// (Optional) Debug: Notification anlegen
router.post("/notifications/create", (req, res) => {
  const item = createNotification(req.body || {});
  if (!item) return res.status(400).json({ message: "ungültige Daten" });
  res.json({ ok: true, item });
});

module.exports = { router, createNotification };
