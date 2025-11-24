// server/clean-now.js
// Einmaliger Sofort-Cleanup für Ayozia:
// - löscht Dateien in uploads/media, uploads/voice, uploads/music, uploads/images, uploads/avatars
// - setzt messages.json, users.json, follows.json, profileViews.json, snippets.json,
//   trackStats.json, music.json zurück

const fs = require("fs");
const path = require("path");

// ───────── Pfade wie im server.js ─────────
const ROOT_DIR       = __dirname;
const UPLOADS_DIR    = path.join(ROOT_DIR, "uploads");
const AVATARS_DIR    = path.join(UPLOADS_DIR, "avatars");
const VOICE_DIR      = path.join(UPLOADS_DIR, "voice");
const MEDIA_DIR      = path.join(UPLOADS_DIR, "media");
const IMAGES_DIR     = path.join(UPLOADS_DIR, "images");
const MUSIC_DIR      = path.join(UPLOADS_DIR, "music");

const DATA_DIR           = path.join(ROOT_DIR, "data");
const MESSAGES_FILE      = path.join(ROOT_DIR, "messages.json");
const USERS_FILE         = path.join(ROOT_DIR, "users.json");
const FOLLOWS_FILE       = path.join(ROOT_DIR, "follows.json");
const PROFILE_VIEWS_FILE = path.join(ROOT_DIR, "profileViews.json");
const SNIPPETS_FILE      = path.join(ROOT_DIR, "snippets.json");
const TRACK_STATS_FILE   = path.join(DATA_DIR, "trackStats.json");
const MUSIC_DB_FILE      = path.join(ROOT_DIR, "music.json");

// ---------- Helpers ----------
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function walk(dir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      out.push(full);
      if (isDir(full)) out.push(...walk(full));
    }
  } catch {}
  return out;
}
function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
function pruneDir(dir) {
  if (!isDir(dir)) return { files: 0, dirsRemoved: 0 };
  let files = 0,
    dirsRemoved = 0;

  // Dateien löschen
  for (const entry of walk(dir)) {
    if (isFile(entry)) files += safeUnlink(entry) ? 1 : 0;
  }

  // Leere Unterordner von unten nach oben entfernen
  const all = walk(dir).reverse();
  for (const p of all) {
    try {
      if (isDir(p) && fs.readdirSync(p).length === 0) {
        fs.rmdirSync(p);
        dirsRemoved++;
      }
    } catch {}
  }
  return { files, dirsRemoved };
}

function resetJson(file, emptyValue) {
  try {
    fs.writeFileSync(file, JSON.stringify(emptyValue, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ---------- Run ----------
(async () => {
  console.log("🧹 Ayozia Sofort-Cleanup gestartet…");

  // sicherstellen, dass DATA_DIR existiert (für trackStats.json)
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch {}

  console.log("   ▸ Lösche Uploads (media/voice/music/images/avatars)…");

  const mediaRes   = pruneDir(MEDIA_DIR);
  const voiceRes   = pruneDir(VOICE_DIR);
  const musicRes   = pruneDir(MUSIC_DIR);
  const imagesRes  = pruneDir(IMAGES_DIR);
  const avatarsRes = pruneDir(AVATARS_DIR);

  console.log("   ▸ Setze JSON-Dateien zurück… (Profile, Messages, Stats usw.)");

  const resMessages = resetJson(MESSAGES_FILE, []);
  const resUsers    = resetJson(USERS_FILE, []);
  const resFollows  = resetJson(FOLLOWS_FILE, []);
  const resViews    = resetJson(PROFILE_VIEWS_FILE, {});
  const resSnippets = resetJson(SNIPPETS_FILE, []);
  const resStats    = resetJson(TRACK_STATS_FILE, {});
  const resMusicDb  = resetJson(MUSIC_DB_FILE, []);

  console.log(`✅ Cleanup fertig.

   Uploads:
     • media  : ${mediaRes.files} Dateien, ${mediaRes.dirsRemoved} Ordner entfernt
     • voice  : ${voiceRes.files} Dateien, ${voiceRes.dirsRemoved} Ordner entfernt
     • music  : ${musicRes.files} Dateien, ${musicRes.dirsRemoved} Ordner entfernt
     • images : ${imagesRes.files} Dateien, ${imagesRes.dirsRemoved} Ordner entfernt
     • avatars: ${avatarsRes.files} Dateien, ${avatarsRes.dirsRemoved} Ordner entfernt

   JSON-DBs:
     • messages.json      : ${resMessages ? "zurückgesetzt" : "FEHLER"}
     • users.json (Profile): ${resUsers ? "zurückgesetzt" : "FEHLER"}
     • follows.json       : ${resFollows ? "zurückgesetzt" : "FEHLER"}
     • profileViews.json  : ${resViews ? "zurückgesetzt" : "FEHLER"}
     • snippets.json      : ${resSnippets ? "zurückgesetzt" : "FEHLER"}
     • data/trackStats.json: ${resStats ? "zurückgesetzt" : "FEHLER"}
     • music.json         : ${resMusicDb ? "zurückgesetzt" : "FEHLER"}

   Hinweis: ALLE Accounts, Chats, Follows, Profilaufrufe, Snippets, Tracks, Avatare
   sind jetzt gelöscht. Du musst dich neu registrieren.
  `);

  process.exit(0);
})();
