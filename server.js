// server/server.js
// -------------------------------------------------------
// Ayozia Dev Server – komplett inkl. Chat + Auto-Lyrics
// + Track-Stats (plays/likes/saves) für Feed/Trending/Recent
// -------------------------------------------------------
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const PORT = process.env.PORT || 5000;

// ───────────────── Basis-Verzeichnisse ─────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────────────── Middleware ────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// simple request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ───────────── Beta-Limit – Testphase endet nach 3 Tagen ─────────────
// Bis einschließlich 25.11.2025 23:59:59 UTC ist der Server nutzbar.
// Danach gibt es für alle Requests 403 "Testphase beendet".
const BETA_UNTIL = new Date("2025-11-25T23:59:59Z");

app.use((req, res, next) => {
  const now = new Date();

  // /health & /verify-email dürfen immer durch, damit du den Server checken
  // und Links aus Mails anklicken kannst
  if (req.path === "/health" || req.path.startsWith("/verify-email")) {
    return next();
  }

  if (now > BETA_UNTIL) {
    return res.status(403).json({
      message:
        "Die Testphase von Ayozia ist beendet. Diese Dev-Version ist nicht mehr verfügbar.",
      code: "BETA_EXPIRED",
      betaUntil: BETA_UNTIL.toISOString(),
    });
  }

  next();
});

// ⚠️ Statische Auslieferung von Uploads
const UPLOADS_DIR = path.join(__dirname, "uploads");
const AVATARS_DIR = path.join(UPLOADS_DIR, "avatars");
const VOICE_DIR = path.join(UPLOADS_DIR, "voice");
const MEDIA_DIR = path.join(UPLOADS_DIR, "media");
const IMAGES_DIR = path.join(UPLOADS_DIR, "images");
const MUSIC_DIR = path.join(UPLOADS_DIR, "music");
const LYRICS_DIR = path.join(UPLOADS_DIR, "lyrics");

for (const d of [
  UPLOADS_DIR,
  AVATARS_DIR,
  VOICE_DIR,
  MEDIA_DIR,
  IMAGES_DIR,
  MUSIC_DIR,
  LYRICS_DIR,
]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send("🚀 Ayozia Server läuft!"));

// ---- Track Stats Laden/Speichern ----
const TRACK_STATS_PATH = path.join(DATA_DIR, "trackStats.json");

// Datei einlesen oder {} wenn nicht vorhanden/kaputt
let trackStats = {};
try {
  if (fs.existsSync(TRACK_STATS_PATH)) {
    const raw = fs.readFileSync(TRACK_STATS_PATH, "utf8");
    trackStats = raw ? JSON.parse(raw) : {};
  }
} catch (e) {
  console.error("Fehler beim Laden von trackStats:", e);
  trackStats = {};
}

// Helper zum Speichern
function saveTrackStats() {
  try {
    fs.writeFileSync(
      TRACK_STATS_PATH,
      JSON.stringify(trackStats, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("Fehler beim Speichern von trackStats:", e);
  }
}

// sorgt dafür, dass ein TrackStats-Objekt existiert
function ensureTrackStats(trackId) {
  if (!trackId) return null;
  const id = String(trackId);
  if (!trackStats[id]) {
    trackStats[id] = {
      plays: 0,
      likes: 0,
      saves: 0,
      likedBy: {}, // userId → true
    };
  } else {
    // Migration für alte Einträge
    if (!trackStats[id].likedBy || typeof trackStats[id].likedBy !== "object") {
      trackStats[id].likedBy = {};
    }
    if (typeof trackStats[id].likes !== "number") {
      trackStats[id].likes = Object.keys(trackStats[id].likedBy).length;
    }
    if (typeof trackStats[id].plays !== "number") {
      trackStats[id].plays = Number(trackStats[id].plays || 0);
    }
    if (typeof trackStats[id].saves !== "number") {
      trackStats[id].saves = Number(trackStats[id].saves || 0);
    }
  }
  return trackStats[id];
}

// ───────────── SNIPPETS STORE ─────────────
const SNIPPETS_FILE = path.join(__dirname, "snippets.json");

function readSnippets() {
  if (!fs.existsSync(SNIPPETS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SNIPPETS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeSnippets(list) {
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(list, null, 2));
}

// ───────────────── Users Store ─────────────────
const USERS_FILE = path.join(__dirname, "users.json");

function safeParseJSON(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Migration/Normalisierung
function normalizeUser(raw) {
  if (!raw) return null;

  const id =
    raw.id ||
    (raw.email ? `legacy-${raw.email}` : null) ||
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  const createdAt =
    raw.createdAt && !Number.isNaN(new Date(raw.createdAt).getTime())
      ? new Date(raw.createdAt).toISOString()
      : new Date().toISOString();

  const passwordHash = raw.passwordHash ?? raw.password ?? null;

  return {
    id,
    email: (raw.email || "").toLowerCase(),
    username: raw.username ?? "",
    passwordHash,
    isVerified: !!(raw.isVerified ?? raw.verified),
    createdAt,
    avatarUrl: raw.avatarUrl ?? null,
    bio: raw.bio ?? "",
    // 💰 Wallet/Guthaben immer als Zahl normalisieren
    wallet:
      typeof raw.wallet === "number"
        ? raw.wallet
        : Number(raw.wallet || 0) || 0,

    // 🔐 Felder für E-Mail-Verifizierung
    emailVerifyToken: raw.emailVerifyToken ?? null,
    emailVerifyExpires: raw.emailVerifyExpires ?? null,
    verifiedAt: raw.verifiedAt ?? null,
  };
}

function readUsersRaw() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const txt = fs.readFileSync(USERS_FILE, "utf-8");
  return safeParseJSON(txt, []);
}

function readUsers() {
  const raw = readUsersRaw();
  const normalized = raw.map(normalizeUser).filter(Boolean);
  const changed =
    JSON.stringify(raw, null, 2) !== JSON.stringify(normalized, null, 2);
  if (changed) writeUsers(normalized);
  return normalized;
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function sanitize(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    avatarUrl: u.avatarUrl ?? null,
    bio: u.bio ?? "",
    isVerified: !!u.isVerified,
    createdAt: u.createdAt ?? null,
    // wallet absichtlich NICHT rausgeben (separater Endpoint)
  };
}


// ─────────────── Mail (Gmail SMTP) ───────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});


// ───────────── MESSAGES / CHAT (Shared Helpers) ─────────────
const MESSAGES_FILE = path.join(__dirname, "messages.json");

function readMessages() {
  if (!fs.existsSync(MESSAGES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeMessages(list) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(list, null, 2));
}

function getChatId(userA, userB) {
  return [String(userA), String(userB)].sort().join("-");
}

// --- Welcome-Fallback: schreibt DM direkt in messages.json ---
async function sendWelcomeDirect(toId, text) {
  const users = readUsers();

  // Systemkonto finden/erstellen
  let sys = users.find((u) => u.username === "Ayozia System");
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
      wallet: 0,
    };
    users.push(sys);
    writeUsers(users);
  }

  // Dedupe: gleiche Welcome-DM nicht doppelt
  const list = readMessages();
  const chatId = getChatId(sys.id, toId);
  const already = list.some(
    (m) =>
      m.chatId === chatId &&
      m.fromId === sys.id &&
      typeof m.text === "string" &&
      m.text.startsWith("🌟 Willkommen bei Ayozia")
  );
  if (already) return;

  const msg = {
    id: crypto.randomUUID(),
    chatId,
    fromId: sys.id,
    toId: String(toId),
    text,
    media: null,
    voice: null,
    replyToId: null,
    timestamp: new Date().toISOString(),
    read: false,
    reactions: {},
  };

  list.push(msg);
  writeMessages(list);
}

/* ───────────── NOTIFICATIONS ROUTER (NEU) ─────────────
   → /notifications, /notifications/unread-count, ...
---------------------------------------------------------------- */
let createNotification; // wird unten vom Router gesetzt
try {
  const notificationsModule = require("./routes/notifications");
  const notificationsRoutes = notificationsModule.router;
  createNotification = notificationsModule.createNotification;
  app.use("/", notificationsRoutes);
  console.log("✅ Notifications-Router geladen");
} catch (err) {
  console.warn("⚠️ Notifications-Router nicht geladen:", err.message);
}

// ───────────────── Auth: Register/Login ─────────────────
app.post("/register", async (req, res) => {
  try {
    const { email, password, username } = req.body || {};
    if (!email || !password || !username) {
      return res.status(400).json({ message: "Alle Felder erforderlich!" });
    }

    const normEmail = String(email).trim().toLowerCase();
    const normUser = String(username).trim();

    const users = readUsers();
    if (users.find((u) => u.email === normEmail)) {
      return res.status(409).json({ message: "E-Mail existiert bereits!" });
    }

    const passwordHash = await bcrypt.hash(String(password).trim(), 10);
    const id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Date.now().toString();

    // 🔐 Token für Verifizierung
    const emailVerifyToken = crypto.randomBytes(32).toString("hex");
    const emailVerifyExpires = new Date(
      Date.now() + 48 * 60 * 60 * 1000
    ).toISOString(); // 48h gültig

    const userRecord = {
      id,
      email: normEmail,
      username: normUser,
      passwordHash,
      isVerified: false, // ❗ jetzt wirklich erstmal NICHT verifiziert
      createdAt: new Date().toISOString(),
      avatarUrl: null,
      bio: "",
      wallet: 0,
      emailVerifyToken,
      emailVerifyExpires,
      verifiedAt: null,
    };

    users.push(userRecord);
    writeUsers(users);

    // ✅ Welcome-DM für neue Accounts (wie vorher)
    try {
      const welcomeText =
        "🌟 Willkommen bei Ayozia!\n\n" +
        "Das ist unsere Testversion. Sag uns gern, was gut ist und was fehlt.\n" +
        "Nimm dir ein wenig Zeit – es ist noch nicht alles fertig. 🙏\n" +
        "Danke fürs Mitmachen! ❤️";

      if (typeof global.sendWelcomeTo === "function") {
        console.log("Sende Welcome-DM (Router) an:", userRecord.id);
        await global.sendWelcomeTo(userRecord.id, welcomeText);
      } else {
        console.log("Sende Welcome-DM (Direct) an:", userRecord.id);
        await sendWelcomeDirect(userRecord.id, welcomeText);
      }
      console.log("Welcome-DM versendet:", userRecord.id);
    } catch (e) {
      console.warn("welcome-send failed:", e?.message);
    }

    // 🔗 Verifizierungslink bauen
    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
    const verifyLink = `${baseUrl}/verify-email?token=${encodeURIComponent(
      emailVerifyToken
    )}`;

    // 📧 Mail verschicken (Mailtrap in Dev)
    try {
      await transporter.sendMail({
        from: '"Ayozia" <no-reply@ayozia.com>',
        to: normEmail,
        subject: `🌟 Willkommen bei Ayozia, ${normUser}! Bitte bestätige deine E-Mail.`,
        html: `
          <p>Hallo ${normUser},</p>
          <p>willkommen bei <b>Ayozia</b>! Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren.</p>
          <p>
            <a href="${verifyLink}" style="display:inline-block;padding:10px 18px;background:#ff1ff1;color:#fff;border-radius:6px;text-decoration:none;">
              E-Mail jetzt bestätigen
            </a>
          </p>
          <p>Oder kopiere diesen Link in deinen Browser:</p>
          <p><code>${verifyLink}</code></p>
          <p>Der Link ist 48 Stunden gültig.</p>
        `,
      });
      console.log("Verifizierungs-Mail gesendet an:", normEmail);
    } catch (mailErr) {
      console.warn(
        "Mailversand deaktiviert/fehlgeschlagen:",
        mailErr?.message
      );
    }

    return res.status(201).json({
      message:
        "Registrierung erfolgreich. Bitte überprüfe deine E-Mails und bestätige deine Adresse.",
      user: sanitize(userRecord),
    });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res
      .status(500)
      .json({ message: "Serverfehler bei Registrierung" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Alle Felder erforderlich!" });
    }

    const normEmail = String(email).trim().toLowerCase();
    const users = readUsers();

    const user = users.find((u) => u.email === normEmail);
    if (!user)
      return res
        .status(401)
        .json({ message: "Ungültige E-Mail oder Passwort" });

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Bitte bestätige zuerst deine E-Mail.",
      });
    }

    const ok = await bcrypt.compare(
      String(password).trim(),
      user.passwordHash
    );
    if (!ok)
      return res
        .status(401)
        .json({ message: "Ungültige E-Mail oder Passwort" });

    return res
      .status(200)
      .json({ message: "Login erfolgreich", user: sanitize(user) });
  } catch (e) {
    console.error("LOGIN ERROR:", e);
    return res.status(500).json({ message: "Serverfehler bei Login" });
  }
});

// 🔗 GET /verify-email?token=...
app.get("/verify-email", (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) {
      return res
        .status(400)
        .send("<h1>Fehler</h1><p>Kein Token angegeben.</p>");
    }

    const users = readUsers();
    const idx = users.findIndex(
      (u) => u.emailVerifyToken && u.emailVerifyToken === token
    );

    if (idx === -1) {
      return res
        .status(400)
        .send(
          "<h1>Link ungültig</h1><p>Der Bestätigungslink ist ungültig oder wurde bereits verwendet.</p>"
        );
    }

    const user = users[idx];

    // Ablauf prüfen (falls gesetzt)
    if (user.emailVerifyExpires) {
      const exp = new Date(user.emailVerifyExpires).getTime();
      if (!Number.isNaN(exp) && Date.now() > exp) {
        return res
          .status(400)
          .send(
            "<h1>Link abgelaufen</h1><p>Der Bestätigungslink ist abgelaufen. Bitte registriere dich erneut.</p>"
          );
      }
    }

    // ✅ verifizieren
    user.isVerified = true;
    user.emailVerifyToken = null;
    user.emailVerifyExpires = null;
    user.verifiedAt = new Date().toISOString();
    users[idx] = user;
    writeUsers(users);

    return res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Ayozia – E-Mail bestätigt</title>
          <style>
            body { font-family: system-ui, sans-serif; background:#05000b; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
            .card { background:#140021; padding:24px 28px; border-radius:16px; text-align:center; max-width:420px; box-shadow:0 0 40px rgba(255,0,200,0.25); }
            h1 { margin-bottom:12px; }
            p { margin:4px 0; color:#ddd; }
            .accent { color:#ff4fd8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>E-Mail bestätigt 🎉</h1>
            <p>Danke, <span class="accent">${user.username}</span>.</p>
            <p>Dein Ayozia-Konto wurde erfolgreich aktiviert.</p>
            <p>Du kannst jetzt die Ayozia-App öffnen und dich einloggen.</p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    console.error("VERIFY-EMAIL ERROR:", e);
    return res
      .status(500)
      .send("<h1>Fehler</h1><p>Interner Serverfehler.</p>");
  }
});

// ───────────── FOLLOW / RELATIONS ─────────────
const FOLLOWS_FILE = path.join(__dirname, "follows.json");
function readFollows() {
  if (!fs.existsSync(FOLLOWS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FOLLOWS_FILE, "utf-8"));
  } catch {
    return [];
  }
}
function writeFollows(list) {
  fs.writeFileSync(FOLLOWS_FILE, JSON.stringify(list, null, 2));
}
function followersOf(userId) {
  return readFollows()
    .filter((e) => e.toId === userId)
    .map((e) => e.fromId);
}
function followingOf(userId) {
  return readFollows()
    .filter((e) => e.fromId === userId)
    .map((e) => e.toId);
}
function isFollowing(viewerId, targetId) {
  return readFollows().some(
    (e) => e.fromId === viewerId && e.toId === targetId
  );
}

// ───────────── PROFILE VIEWS (für Profilaufrufe) ─────────────
const PROFILE_VIEWS_FILE = path.join(__dirname, "profileViews.json");

function readProfileViews() {
  if (!fs.existsSync(PROFILE_VIEWS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROFILE_VIEWS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeProfileViews(map) {
  fs.writeFileSync(PROFILE_VIEWS_FILE, JSON.stringify(map, null, 2));
}

// 📊 GET /users/:id/relations?viewer=<viewerId>
app.get("/users/:id/relations", (req, res) => {
  const id = String(req.params.id);
  if (["image", "music", "snippet"].includes(id)) {
    return res
      .status(400)
      .json({ message: "Ungültige User-ID in der URL." });
  }

  const viewer = String(req.query.viewer || "");

  const followers = followersOf(id);
  const following = followingOf(id);

  res.json({
    userId: id,
    followersCount: followers.length,
    followingCount: following.length,
    isFollowing: viewer ? isFollowing(viewer, id) : false,
    isSelf: !!viewer && viewer === id,
  });
});

// ➕ POST /follow { fromId, toId }
app.post("/follow", (req, res) => {
  const { fromId, toId } = req.body || {};
  if (!fromId || !toId || fromId === toId) {
    return res.status(400).json({ message: "Ungültige Daten" });
  }
  const users = readUsers();
  if (
    !users.some((u) => u.id === fromId) ||
    !users.some((u) => u.id === toId)
  ) {
    return res.status(404).json({ message: "User nicht gefunden" });
  }
  const list = readFollows();
  const already = list.some(
    (e) => e.fromId === fromId && e.toId === toId
  );
  if (!already) {
    list.push({
      fromId,
      toId,
      createdAt: new Date().toISOString(),
    });
    writeFollows(list);

    if (typeof createNotification === "function") {
      createNotification({
        toId,
        fromId,
        kind: "follow",
        meta: {},
        dedupeKey: `follow:${fromId}->${toId}`,
      });
    }
  }
  return res.json({ ok: true });
});

// ➖ POST /unfollow { fromId, toId }
app.post("/unfollow", (req, res) => {
  const { fromId, toId } = req.body || {};
  if (!fromId || !toId) {
    return res.status(400).json({ message: "Ungültige Daten" });
  }
  let list = readFollows();
  const before = list.length;
  list = list.filter(
    (e) => !(e.fromId === fromId && e.toId === toId)
  );
  if (list.length !== before) writeFollows(list);
  return res.json({ ok: true });
});

// ✅ Followers & Following Listen
app.get("/users/:id/followers", (req, res) => {
  const id = String(req.params.id);
  const users = readUsers();
  const followerIds = followersOf(id);
  const allFollows = readFollows();
  const followers = users
    .filter((u) => followerIds.includes(u.id))
    .map((u) => ({
      ...sanitize(u),
      followedAt: allFollows.find(
        (f) => f.fromId === u.id && f.toId === id
      )?.createdAt,
    }));
  res.json({ followers });
});

app.get("/users/:id/following", (req, res) => {
  const id = String(req.params.id);
  const users = readUsers();
  const followingIds = followingOf(id);
  const allFollows = readFollows();
  const following = users
    .filter((u) => followingIds.includes(u.id))
    .map((u) => ({
      ...sanitize(u),
      followedAt: allFollows.find(
        (f) => f.fromId === id && f.toId === u.id
      )?.createdAt,
    }));
  res.json({ following });
});

// ───────────── USERS CRUD ─────────────
app.get("/users", (req, res) => {
  const { limit, sort = "createdAt", order = "desc", ids } = req.query;
  let users = readUsers().map(sanitize);

  if (ids) {
    const set = new Set(
      String(ids)
        .split(",")
        .map((s) => s.trim())
    );
    users = users.filter((u) => set.has(String(u.id)));
  }

  users.sort((a, b) => {
    const av = a?.[sort] ?? "";
    const bv = b?.[sort] ?? "";
    if (sort === "createdAt") {
      const ad = new Date(av || 0).getTime();
      const bd = new Date(bv || 0).getTime();
      return order === "asc" ? ad - bd : bd - ad;
    }
    return order === "asc"
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const lim = Math.max(0, parseInt(limit || "0", 10));
  if (lim > 0) users = users.slice(0, lim);

  res.json({ users });
});

app.get("/users/new", (req, res) => {
  const sinceDays = Math.max(
    1,
    parseInt(req.query.sinceDays || "7", 10)
  );
  const limit = Math.max(0, parseInt(req.query.limit || "20", 10));
  const threshold =
    Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let users = readUsers()
    .filter((u) => {
      const ts = new Date(u.createdAt || 0).getTime();
      return !Number.isNaN(ts) && ts >= threshold;
    })
    .map(sanitize)
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0) -
        new Date(a.createdAt || 0)
    );

  if (limit > 0) users = users.slice(0, limit);

  res.json({ users, sinceDays });
});

app.get("/users/:id", (req, res) => {
  const id = String(req.params.id);
  if (["image", "music", "snippet"].includes(id)) {
    return res
      .status(400)
      .json({ message: "Ungültige User-ID in der URL." });
  }
  const user = readUsers().find((u) => String(u.id) === id);
  if (!user)
    return res.status(404).json({ message: "User nicht gefunden" });
  res.json({ user: sanitize(user) });
});

// PATCH /users/:id { avatarUrl?, bio?, username? }
app.patch("/users/:id", (req, res) => {
  const id = String(req.params.id);
  const { avatarUrl, bio, username } = req.body || {};

  const users = readUsers();
  const idx = users.findIndex((u) => String(u.id) === id);
  if (idx === -1)
    return res.status(404).json({ message: "User nicht gefunden" });

  if (typeof avatarUrl === "string") users[idx].avatarUrl = avatarUrl;
  if (typeof bio === "string") users[idx].bio = bio;
  if (typeof username === "string" && username.trim())
    users[idx].username = username.trim();

  writeUsers(users);
  return res.json({ user: sanitize(users[idx]) });
});

// 📈 Profilaufruf zählen – POST /users/:id/profile-view
app.post("/users/:id/profile-view", (req, res) => {
  const id = String(req.params.id);
  const users = readUsers();
  const exists = users.find((u) => String(u.id) === id);
  if (!exists) {
    return res.status(404).json({ message: "User nicht gefunden" });
  }
  const views = readProfileViews();
  const current = Number(views[id] || 0) || 0;
  views[id] = current + 1;
  writeProfileViews(views);
  return res.json({ userId: id, profileViews: views[id] });
});

// Optional: Profilaufrufe abrufen – GET /users/:id/profile-views
app.get("/users/:id/profile-views", (req, res) => {
  const id = String(req.params.id);
  const views = readProfileViews();
  const count = Number(views[id] || 0) || 0;
  return res.json({ userId: id, profileViews: count });
});

// ───────────── WALLET / GUTHABEN ─────────────

// Aktuelles Guthaben eines Users
app.get("/wallet/:userId", (req, res) => {
  const userId = String(req.params.userId);
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    return res.status(404).json({ message: "User nicht gefunden" });
  }
  const user = users[idx];
  if (typeof user.wallet !== "number" || Number.isNaN(user.wallet)) {
    user.wallet = 0;
    writeUsers(users);
  }
  return res.json({ userId, balance: user.wallet });
});

// Guthaben ändern (delta positiv = aufladen, negativ = abziehen)
app.post("/wallet/:userId/change", (req, res) => {
  const userId = String(req.params.userId);
  const { delta } = req.body || {};

  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return res
      .status(400)
      .json({ message: "delta muss eine Zahl sein (z.B. 100 oder -50)" });
  }

  const users = readUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) {
    return res.status(404).json({ message: "User nicht gefunden" });
  }

  const user = users[idx];
  if (typeof user.wallet !== "number" || Number.isNaN(user.wallet)) {
    user.wallet = 0;
  }

  user.wallet += delta;
  if (user.wallet < 0) user.wallet = 0; // kein Minus-Guthaben

  users[idx] = user;
  writeUsers(users);

  return res.json({ userId, balance: user.wallet });
});

// ❤ Track-Like erhöhen – pro userId nur 1×
app.post("/tracks/:id/like", (req, res) => {
  const trackId = req.params.id;
  const { userId } = req.body || {};

  if (!trackId) {
    return res.status(400).json({ message: "Track-ID fehlt" });
  }
  if (!userId) {
    return res.status(400).json({ message: "userId erforderlich" });
  }

  const stats = ensureTrackStats(trackId);
  if (!stats) {
    return res
      .status(500)
      .json({ message: "Stats konnten nicht erzeugt werden" });
  }

  if (!stats.likedBy || typeof stats.likedBy !== "object") {
    stats.likedBy = {};
  }

  // Bereits geliked → nicht nochmal zählen
  if (stats.likedBy[String(userId)]) {
    return res.json({
      trackId: String(trackId),
      plays: stats.plays || 0,
      likes: stats.likes || Object.keys(stats.likedBy).length,
      saves: stats.saves || 0,
      alreadyLiked: true,
    });
  }

  stats.likedBy[String(userId)] = true;
  stats.likes = Object.keys(stats.likedBy).length;

  saveTrackStats();
  broadcastTrackUpdate(trackId);

  return res.json({
    trackId: String(trackId),
    plays: stats.plays || 0,
    likes: stats.likes || 0,
    saves: stats.saves || 0,
  });
});

// ▶ Track-Play erhöhen (Client sorgt für 60%-Regel)
app.post("/tracks/:id/play", (req, res) => {
  const trackId = req.params.id;
  if (!trackId) {
    return res.status(400).json({ message: "Track-ID fehlt" });
  }

  const stats = ensureTrackStats(trackId);
  if (!stats) {
    return res
      .status(500)
      .json({ message: "Stats konnten nicht erzeugt werden" });
  }

  stats.plays = (stats.plays || 0) + 1;
  saveTrackStats();
  broadcastTrackUpdate(trackId);

  return res.json({
    trackId: String(trackId),
    plays: stats.plays || 0,
    likes: stats.likes || 0,
    saves: stats.saves || 0,
  });
});

// ───────────── MESSAGES / CHAT ROUTES ─────────────

// 📩 GET /messages/:chatId → Thread
app.get("/messages/:chatId", (req, res) => {
  const chatId = String(req.params.chatId);
  const all = readMessages().filter(
    (m) => String(m.chatId) === chatId
  );
  res.json({ messages: all });
});

// 📨 POST /messages/send → Text/Media/Voice
app.post("/messages/send", (req, res) => {
  const {
    fromId,
    toId,
    text = "",
    media,
    voice,
    replyToId = null,
  } = req.body || {};

  if (!fromId || !toId)
    return res
      .status(400)
      .json({ message: "fromId und toId erforderlich" });

  const cleanText = String(text || "").trim();
  if (!cleanText && !media && !voice) {
    return res.status(400).json({
      message: "text oder media oder voice erforderlich",
    });
  }

  const users = readUsers();
  if (
    !users.find((u) => String(u.id) === String(fromId)) ||
    !users.find((u) => String(u.id) === String(toId))
  ) {
    return res
      .status(404)
      .json({ message: "Absender oder Empfänger nicht gefunden" });
  }

  const list = readMessages();
  const newMsg = {
    id: crypto.randomUUID(),
    chatId: getChatId(fromId, toId),
    fromId: String(fromId),
    toId: String(toId),
    text: cleanText || "",
    media: media || null,
    voice: voice || null,
    replyToId: replyToId ? String(replyToId) : null,
    timestamp: new Date().toISOString(),
    read: false,
    reactions: {},
  };
  list.push(newMsg);
  writeMessages(list);

  if (fromId !== toId && typeof createNotification === "function") {
    const preview = cleanText
      ? cleanText.slice(0, 80)
      : voice
      ? "🎙 Sprachmemo"
      : media
      ? "📎 Medien"
      : "";
    try {
      createNotification({
        toId,
        fromId,
        kind: "message",
        meta: {
          chatId: newMsg.chatId,
          messageId: newMsg.id,
          preview,
        },
      });
    } catch (e) {
      console.warn(
        "createNotification failed:",
        e?.message
      );
    }
  }

  return res.json({
    message: "gesendet ✅",
    data: newMsg,
  });
});

// 🔊 /messages/send-voice
app.post("/messages/send-voice", (req, res) => {
  try {
    const {
      fromId,
      toId,
      url,
      durationMs = 0,
      waveform,
    } = req.body || {};
    if (!fromId || !toId || !url) {
      return res.status(400).json({
        message: "fromId, toId und url erforderlich",
      });
    }

    const users = readUsers();
    const from = users.find(
      (u) => String(u.id) === String(fromId)
    );
    const to = users.find((u) => String(u.id) === String(toId));
    if (!from || !to)
      return res
        .status(404)
        .json({ message: "Absender oder Empfänger nicht gefunden" });

    const chatId = getChatId(fromId, toId);
    const list = readMessages();

    const existing = list.find(
      (m) =>
        m.chatId === chatId &&
        m.voice &&
        m.voice.uri === String(url)
    );
    if (existing)
      return res.json({
        message: "bereits vorhanden",
        data: existing,
      });

    const newMsg = {
      id: crypto.randomUUID(),
      chatId,
      fromId: String(fromId),
      toId: String(toId),
      text: "",
      media: null,
      voice: {
        uri: String(url),
        durationMs: Number(durationMs) || 0,
        waveform: waveform || undefined,
      },
      replyToId: null,
      timestamp: new Date().toISOString(),
      read: false,
      reactions: {},
    };
    list.push(newMsg);
    writeMessages(list);
    return res.json({
      message: "voice gesendet ✅",
      data: newMsg,
    });
  } catch (e) {
    console.error("SEND-VOICE ERROR:", e);
    return res
      .status(500)
      .json({ message: "Serverfehler bei send-voice" });
  }
});

// ✅ POST /messages/read
app.post("/messages/read", (req, res) => {
  const { messageId, userId } = req.body || {};
  if (!messageId || !userId)
    return res.status(400).json({
      message: "messageId und userId erforderlich",
    });

  const list = readMessages();
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1)
    return res
      .status(404)
      .json({ message: "Nachricht nicht gefunden" });

  if (String(list[idx].toId) === String(userId)) {
    list[idx].read = true;
    writeMessages(list);
  }
  res.json({ ok: true });
});

// 🗑️ einzelne Nachricht löschen
app.post("/messages/delete", (req, res) => {
  const { messageId } = req.body || {};
  if (!messageId)
    return res.status(400).json({
      message: "messageId erforderlich",
    });

  const list = readMessages();
  const before = list.length;
  const filtered = list.filter(
    (m) => m.id !== String(messageId)
  );
  writeMessages(filtered);

  return res.json({
    ok: true,
    deleted: before - filtered.length,
  });
});

// 😀 Reaction setzen
app.post("/messages/react", (req, res) => {
  const { messageId, emoji, userId } = req.body || {};
  if (!messageId || !emoji)
    return res.status(400).json({
      message: "messageId und emoji erforderlich",
    });

  const list = readMessages();
  const idx = list.findIndex(
    (m) => m.id === String(messageId)
  );
  if (idx === -1)
    return res
      .status(404)
      .json({ message: "Nachricht nicht gefunden" });

  if (!list[idx].reactions || typeof list[idx].reactions !== "object")
    list[idx].reactions = {};
  if (userId)
    list[idx].reactions[String(userId)] = String(emoji);
  else list[idx].reaction = String(emoji);

  writeMessages(list);
  return res.json({ ok: true });
});

/* ========= COMPAT-Aliase ========= */
app.get("/messages/thread", (req, res) => {
  const { meId, partnerId } = req.query || {};
  if (!meId || !partnerId)
    return res.status(400).json({
      message: "meId und partnerId erforderlich",
    });
  const chatId = getChatId(meId, partnerId);
  const all = readMessages().filter(
    (m) => String(m.chatId) === chatId
  );
  return res.json({ messages: all });
});
app.post("/messages/mark-read", (req, res) => {
  const { messageId, userId } = req.body || {};
  if (!messageId || !userId)
    return res.status(400).json({
      message: "messageId und userId erforderlich",
    });
  const list = readMessages();
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1)
    return res
      .status(404)
      .json({ message: "Nachricht nicht gefunden" });
  if (String(list[idx].toId) === String(userId)) {
    list[idx].read = true;
    writeMessages(list);
  }
  return res.json({ ok: true });
});

/* ========= Chatliste / Konversationen ========= */
app.get("/messages/for/:userId", (req, res) => {
  const userId = String(req.params.userId);
  const all = readMessages();
  const mine = all.filter(
    (m) => m.fromId === userId || m.toId === userId
  );
  res.json({ messages: mine });
});
app.get("/conversations/:userId", (req, res) => {
  const userId = String(req.params.userId);
  const users = readUsers();
  const all = readMessages();

  const partners = new Set();
  for (const m of all) {
    if (m.fromId === userId) partners.add(m.toId);
    if (m.toId === userId) partners.add(m.fromId);
  }
  partners.delete(userId);

  const items = [];
  for (const pid of partners) {
    const chatId = getChatId(userId, pid);
    const thread = all.filter(
      (m) => m.chatId === chatId
    );
    if (thread.length === 0) continue;

    const last = thread.reduce((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return tb > ta ? b : a;
    });

    const unreadCount = thread.filter(
      (m) => m.toId === userId && !m.read
    ).length;

    const partner = users.find(
      (u) => String(u.id) === String(pid)
    );
    items.push({
      partner:
        sanitize(partner) || {
          id: pid,
          username: "Unbekannt",
          avatarUrl: null,
        },
      lastMessage: {
        id: last.id,
        text: last.text || "",
        timestamp: last.timestamp,
        media: last.media || null,
        voice: last.voice || null,
        createdAt: last.timestamp,
      },
      unreadCount,
    });
  }

  items.sort((a, b) => {
    const ta = new Date(
      a.lastMessage.timestamp || 0
    ).getTime();
    const tb = new Date(
      b.lastMessage.timestamp || 0
    ).getTime();
    return tb - ta;
  });

  res.json({ items });
});

// ───────────── AVATAR UPLOAD ─────────────
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const id = String(req.params.id || "unk");
    const ext =
      path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const name = `${id}-${Date.now()}${ext}`;
    cb(null, name);
  },
});
function avatarFileFilter(_req, file, cb) {
  const ok = /image\/(jpeg|png|jpg|webp)/.test(file.mimetype || "");
  if (!ok)
    return cb(
      new Error("Nur Bilddateien erlaubt (jpg, jpeg, png, webp)")
    );
  cb(null, true);
}
const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});
app.post(
  "/users/:id/avatar",
  avatarUpload.single("file"),
  (req, res) => {
    const id = String(req.params.id);
    const users = readUsers();
    const idx = users.findIndex((u) => String(u.id) === id);
    if (idx === -1)
      return res
        .status(404)
        .json({ message: "User nicht gefunden" });
    if (!req.file)
      return res
        .status(400)
        .json({ message: "Keine Datei erhalten" });

    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const publicUrl = `${baseUrl}/uploads/avatars/${req.file.filename}`;

    users[idx].avatarUrl = publicUrl;
    writeUsers(users);

    return res.json({
      message: "Avatar aktualisiert",
      avatarUrl: publicUrl,
      user: sanitize(users[idx]),
    });
  }
);

/* ─────────────────────────────
   ROUTES: Voice + Media (bestehend)
   ───────────────────────────── */
try {
  const voiceRoutes = require("./routes/voice"); // /chat/:chatId/voice
  const mediaRoutes = require("./routes/media"); // /chat/:chatId/media
  app.use("/", voiceRoutes);
  app.use("/", mediaRoutes);
} catch (err) {
  console.warn(
    "⚠️ Voice/Media-Routen nicht gefunden:",
    err.message
  );
}

/* ─────────────────────────────
   ROUTES: Images
   ───────────────────────────── */
try {
  const imagesRoutes = require("./routes/images"); // /users/:id/images*
  app.use("/", imagesRoutes);
} catch (err) {
  console.warn(
    "⚠️ Images-Routen nicht gefunden:",
    err.message
  );
}

/* ─────────────────────────────
   ROUTES: Music (MUSS vor 404!)
   – nutzt music.json als DB
   – Stats kommen aus trackStats.json
   ───────────────────────────── */
const MUSIC_DB_FILE = path.join(__dirname, "music.json");

function readMusicDb() {
  if (!fs.existsSync(MUSIC_DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(MUSIC_DB_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function toAbsFromReq(req, relOrAbs) {
  if (!relOrAbs) return relOrAbs;
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const base = `${req.protocol}://${req.headers.host}`.replace(/\/$/, "");
  const rel = relOrAbs.startsWith("/") ? relOrAbs : `/${relOrAbs}`;
  return `${base}${rel}`;
}

function normalizeTrackForFeed(raw, req) {
  if (!raw) return null;
  const url =
    raw.absUrl ||
    raw.url ||
    (raw.relPath
      ? `/uploads/${raw.relPath.replace(/^\/+/, "")}`
      : null);
  const cover =
    raw.absCover ||
    raw.cover ||
    (raw.coverRelPath
      ? `/uploads/${raw.coverRelPath.replace(/^\/+/, "")}`
      : null);

  const stats = ensureTrackStats(raw.id); // Stats-Objekt (plays/likes/saves)

  return {
    id: String(raw.id),
    userId: raw.userId ? String(raw.userId) : null,
    title: raw.title || raw.originalName || "Unbenannter Track",
    url: url ? toAbsFromReq(req, url) : null,
    cover: cover ? toAbsFromReq(req, cover) : null,
    durationMs: raw.durationMs ?? null,
    createdAt: raw.createdAt || new Date().toISOString(),
    hasLyrics: !!raw.hasLyrics,
    plays: stats?.plays ?? raw.plays ?? 0,
    likes:
      stats?.likes ??
      (stats?.likedBy ? Object.keys(stats.likedBy).length : raw.likes ?? 0),
    saves: stats?.saves ?? raw.saves ?? 0,
  };
}

try {
  const musicRoutes = require(path.join(
    __dirname,
    "routes",
    "music"
  ));
  app.use("/", musicRoutes);
  console.log("✅ Music-Router geladen");
} catch (err) {
  console.error(
    "❌ Music-Router konnte nicht geladen werden:",
    err
  );
}

/* ───────────── MUSIC FEED / TRENDING / RECENT ─────────────
   Nutzt dieselbe music.json wie routes/music.js
   und merged Stats aus trackStats.json
---------------------------------------------------------------- */

// FEED = komplette Liste nach Datum
app.get("/music/feed", (req, res) => {
  try {
    const limit = Math.max(
      1,
      parseInt(req.query.limit || "0", 10)
    ); // 0 = kein Limit
    let db = readMusicDb();

    db = db
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0) -
          new Date(a.createdAt || 0)
      );

    if (limit > 0) db = db.slice(0, limit);

    const list = db
      .map((m) => normalizeTrackForFeed(m, req))
      .filter(Boolean);

    return res.json({ items: list });
  } catch (e) {
    console.error("FEED ERROR:", e);
    return res
      .status(500)
      .json({ message: "Feed-Fehler" });
  }
});

// TRENDING = sortiert nach Score (plays * 2 + likes + saves)
app.get("/music/trending", (req, res) => {
  try {
    let db = readMusicDb();

    const list = db
      .map((m) => normalizeTrackForFeed(m, req))
      .filter(Boolean)
      .sort((a, b) => {
        const sA =
          (a.plays || 0) * 2 +
          (a.likes || 0) +
          (a.saves || 0);
        const sB =
          (b.plays || 0) * 2 +
          (b.likes || 0) +
          (b.saves || 0);
        return sB - sA;
      });

    return res.json({ items: list });
  } catch (e) {
    console.error("TRENDING ERROR:", e);
    return res
      .status(500)
      .json({ message: "Trending-Fehler" });
  }
});

// RECENT = nur die neuesten (default 50) – mit Stats
app.get("/music/recent", (req, res) => {
  try {
    const limit = Math.max(
      1,
      parseInt(req.query.limit || "50", 10)
    );
    let db = readMusicDb();

    db = db
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt || 0) -
          new Date(a.createdAt || 0)
      )
      .slice(0, limit);

    const list = db
      .map((m) => normalizeTrackForFeed(m, req))
      .filter(Boolean);

    return res.json({ items: list });
  } catch (e) {
    console.error("RECENT ERROR:", e);
    return res
      .status(500)
      .json({ message: "Recent-Fehler" });
  }
});

/* ───────────── USER INSIGHTS (für "Meine Daten auf Ayoza") ─────────────
   GET /users/:id/insights
   → Aggregiert Plays/Likes/Saves der Tracks eines Users,
     Follower/Folgt, Profilaufrufe, Nachrichten.
---------------------------------------------------------------- */
app.get("/users/:id/insights", (req, res) => {
  try {
    const id = String(req.params.id);

    const users = readUsers();
    const user = users.find((u) => String(u.id) === id);
    if (!user) {
      return res.status(404).json({ message: "User nicht gefunden" });
    }

    // Tracks des Users
    const tracksDb = readMusicDb().filter(
      (t) => String(t.userId || "") === id
    );
    const trackCount = tracksDb.length;

    let plays = 0;
    let likes = 0;
    let saves = 0;

    for (const t of tracksDb) {
      const stats = ensureTrackStats(t.id);
      if (!stats) continue;
      const p = stats.plays || 0;
      const l =
        typeof stats.likes === "number"
          ? stats.likes
          : Object.keys(stats.likedBy || {}).length;
      const s = stats.saves || 0;

      plays += p;
      likes += l;
      saves += s;
    }

    // Follower / Following
    const followers = followersOf(id);
    const following = followingOf(id);

    // Profilaufrufe
    const viewsMap = readProfileViews();
    const profileViews = Number(viewsMap[id] || 0) || 0;

    // Nachrichten-Aktivität
    const allMessages = readMessages();
    const sentMessages = allMessages.filter((m) => m.fromId === id).length;
    const receivedMessages = allMessages.filter((m) => m.toId === id).length;

    return res.json({
      userId: id,
      username: user.username,
      tracks: {
        count: trackCount,
        plays,
        likes,
        saves,
      },
      social: {
        followers: followers.length,
        following: following.length,
      },
      profile: {
        views: profileViews,
      },
      messages: {
        sent: sentMessages,
        received: receivedMessages,
      },
    });
  } catch (e) {
    console.error("USER INSIGHTS ERROR:", e);
    return res.status(500).json({ message: "Insights error" });
  }
});

/* ROUTES: Broadcast (Admin + Welcome-DM via Router) */
try {
  const {
    router: broadcastRoutes,
    sendWelcomeTo,
  } = require("./routes/broadcast");
  app.use("/", broadcastRoutes);
  global.sendWelcomeTo = sendWelcomeTo; // damit /register darauf zugreifen kann
  console.log("✅ Broadcast-Router geladen");
} catch (err) {
  console.warn(
    "⚠️ Broadcast-Router nicht geladen:",
    err.message
  );
}

/* ───────────── Lyrics-Endpoints (TOP-LEVEL!) ─────────────
   Mappt ?path=music/<file>.mp3  →  uploads/lyrics/<file>.lrc
---------------------------------------------------------------- */
app.get("/lyrics", (req, res) => {
  try {
    const q = String(req.query.path || "").trim(); // z. B. "music/abc.mp3"
    if (!q) return res.status(400).json({ message: "missing ?path" });

    const base = path.basename(q); // "abc.mp3"
    const lrcName = base.replace(path.extname(base), ".lrc"); // "abc.lrc"
    const lrcPath = path.join(LYRICS_DIR, lrcName);

    if (!fs.existsSync(lrcPath)) {
      return res.status(404).json({ message: "lyrics not ready" });
    }
    return res.sendFile(lrcPath);
  } catch (e) {
    console.error("LYRICS ERROR:", e);
    return res
      .status(500)
      .json({ message: "server error in /lyrics" });
  }
});

// optional: direkter Zugriff /lyrics/by-file/:name.lrc
app.get("/lyrics/by-file/:name", (req, res) => {
  const safe = path.basename(req.params.name || "");
  const lrcPath = path.join(LYRICS_DIR, safe);
  if (!fs.existsSync(lrcPath)) return res.status(404).end();
  res.sendFile(lrcPath);
});

/* ───────────── SNIPPETS ROUTES ─────────────
   - GET  /users/:id/snippets   → Profil lädt Snippets
   - POST /snippets/:source     → Snippet speichern
---------------------------------------------------------------- */

// Liste aller Snippets eines Users
app.get("/users/:id/snippets", (req, res) => {
  const userId = String(req.params.id);
  const all = readSnippets();
  const list = all.filter((s) => String(s.userId || "") === userId);
  return res.json({ snippets: list });
});

// Snippet erstellen
app.post("/snippets/:source", (req, res) => {
  const source = String(req.params.source || "unknown");
  const payload = req.body || {};

  console.log("Snippet-Create request:", {
    source,
    payload,
  });

  const snippetId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const list = readSnippets();

  const snippet = {
    id: snippetId,
    source,
    userId: payload.userId ? String(payload.userId) : null,
    musicId: payload.musicId ? String(payload.musicId) : null,
    title: payload.title || "Snippet",
    url: payload.url || "",
    thumbnail: payload.thumbnail || null,
    startMs: Number(payload.startMs ?? 0) || 0,
    durationMs: Number(payload.durationMs ?? 30000) || 30000,
    createdAt,
  };

  list.push(snippet);
  writeSnippets(list);

  return res.json({
    ok: true,
    snippetId,
    source,
    createdAt,
    snippet,
  });
});

// 404-Logger (NACH allen Routen)
app.use((req, res) => {
  console.warn("404 – no route:", req.method, req.url);
  res
    .status(404)
    .json({ error: "Not found", path: req.url });
});

// ───────────── HTTP + Socket.io Start ─────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// optional nur zum Debuggen
io.on("connection", (socket) => {
  console.log("🔌 Client verbunden:", socket.id);
});

// Helper: Stats-Update an alle Clients schicken
function broadcastTrackUpdate(trackId) {
  const stats = ensureTrackStats(trackId);
  if (!stats) return;

  io.emit("track:update", {
    trackId: String(trackId),
    plays: stats.plays || 0,
    likes:
      typeof stats.likes === "number"
        ? stats.likes
        : Object.keys(stats.likedBy || {}).length,
    saves: stats.saves || 0,
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server + Socket.io läuft auf Port ${PORT}`);
});
