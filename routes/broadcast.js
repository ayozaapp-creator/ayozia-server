// server/routes/broadcast.js
// Broadcast-Router für Ayozia
// - sendWelcomeTo(userId, text|{text})
// - POST /admin/broadcast  → System-Nachricht an alle User

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

// Pfade zu den JSON-Daten (eine Ebene höher als /routes)
const USERS_FILE = path.join(__dirname, "..", "users.json");
const MESSAGES_FILE = path.join(__dirname, "..", "messages.json");

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const txt = fs.readFileSync(USERS_FILE, "utf-8");
  return safeParseJSON(txt, []);
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function readMessages() {
  if (!fs.existsSync(MESSAGES_FILE)) return [];
  const txt = fs.readFileSync(MESSAGES_FILE, "utf-8");
  return safeParseJSON(txt, []);
}
function writeMessages(list) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(list, null, 2));
}

function getChatId(a, b) {
  return [String(a), String(b)].sort().join("-");
}

// System-User sicherstellen
function ensureSystemUser() {
  const users = readUsers();
  let sys = users.find((u) => u && u.username === "Ayozia System");
  if (!sys) {
    sys = {
      id: crypto.randomUUID(),
      email: "",
      username: "Ayozia System",
      passwordHash: null,
      isVerified: true,
      createdAt: new Date().toISOString(),
      avatarUrl: null,
      bio: "Offizielle Systemnachrichten",
    };
    users.push(sys);
    writeUsers(users);
  }
  return sys;
}

// Hilfsfunktion: generische System-Nachricht an EINEN User
async function sendSystemMessageTo(userId, text) {
  const sys = ensureSystemUser();
  const list = readMessages();

  const msg = {
    id: crypto.randomUUID(),
    chatId: getChatId(sys.id, userId),
    fromId: sys.id,
    toId: String(userId),
    text: String(text || ""),
    media: null,
    voice: null,
    replyToId: null,
    timestamp: new Date().toISOString(),
    read: false,
    reactions: {},
  };

  list.push(msg);
  writeMessages(list);
  return msg;
}

// Exportierte Funktion: Welcome-DM für neue User
async function sendWelcomeTo(userId, payload) {
  const text =
    typeof payload === "string"
      ? payload
      : payload && typeof payload.text === "string"
      ? payload.text
      : "";

  if (!text.trim()) return;

  const sys = ensureSystemUser();
  const list = readMessages();
  const chatId = getChatId(sys.id, userId);

  // Dedupe: gleiche Welcome nicht doppelt
  const already = list.some(
    (m) =>
      m.chatId === chatId &&
      m.fromId === sys.id &&
      typeof m.text === "string" &&
      m.text.trim() === text.trim()
  );
  if (already) return;

  const msg = {
    id: crypto.randomUUID(),
    chatId,
    fromId: sys.id,
    toId: String(userId),
    text: text,
    media: null,
    voice: null,
    replyToId: null,
    timestamp: new Date().toISOString(),
    read: false,
    reactions: {},
  };

  list.push(msg);
  writeMessages(list);
  console.log("Welcome-DM (Router) gespeichert für", userId);
  return msg;
}

// POST /admin/broadcast  → System-Nachricht an alle User
router.post("/admin/broadcast", async (req, res) => {
  const { text } = req.body || {};
  const clean = String(text || "").trim();
  if (!clean) {
    return res.status(400).json({
      ok: false,
      error: "Broadcast-Text fehlt.",
    });
  }

  try {
    const users = readUsers().filter((u) => u && u.id);
    if (!users.length) {
      return res.json({
        ok: true,
        count: 0,
        message: "Keine User vorhanden – nichts gesendet.",
      });
    }

    console.log("🔊 Starte Broadcast an", users.length, "User…");
    for (const u of users) {
      await sendSystemMessageTo(u.id, clean);
    }
    console.log("✅ Broadcast fertig!");

    return res.json({
      ok: true,
      count: users.length,
      message: "Broadcast erfolgreich gesendet.",
    });
  } catch (err) {
    console.error("Broadcast-Fehler:", err);
    return res.status(500).json({
      ok: false,
      error: "Broadcast fehlgeschlagen.",
    });
  }
});

module.exports = {
  router,
  sendWelcomeTo,
};
