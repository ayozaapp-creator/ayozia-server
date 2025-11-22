// server/clean-now.js
// Einmaliger Sofort-Cleanup: löscht Dateien in uploads/media, uploads/voice & uploads/music
// (+ leert messages.json), lässt uploads/avatars & User/Profile unberührt.

const fs = require("fs");
const path = require("path");

const UPLOADS_DIR   = path.join(__dirname, "uploads");
const AVATARS_DIR   = path.join(UPLOADS_DIR, "avatars");
const VOICE_DIR     = path.join(UPLOADS_DIR, "voice");
const MEDIA_DIR     = path.join(UPLOADS_DIR, "media");
const MUSIC_DIR     = path.join(UPLOADS_DIR, "music");   // ⬅️ NEU: Musik-Ordner
const MESSAGES_FILE = path.join(__dirname, "messages.json");

// ---------- Helpers ----------
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
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
  try { fs.unlinkSync(p); return true; } catch { return false; }
}
function pruneDir(dir) {
  if (!isDir(dir)) return { files: 0, dirsRemoved: 0 };
  let files = 0, dirsRemoved = 0;

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

function clearMessagesJson(file) {
  try {
    if (!fs.existsSync(file)) return { removed: 0 };
    const raw = fs.readFileSync(file, "utf-8");
    const list = JSON.parse(raw);
    fs.writeFileSync(file, JSON.stringify([], null, 2));
    return { removed: Array.isArray(list) ? list.length : 0 };
  } catch {
    return { removed: 0 };
  }
}

// ---------- Run ----------
(async () => {
  console.log("🧹 Sofort-Cleanup gestartet…");
  console.log("   ▸ Lass PROFILES/AVATARE in Ruhe:", AVATARS_DIR);

  // 1) Medien & Voice & Music löschen (aber NICHT avatars)
  const mediaRes = pruneDir(MEDIA_DIR);
  const voiceRes = pruneDir(VOICE_DIR);
  const musicRes = pruneDir(MUSIC_DIR); // ⬅️ Musik löschen

  // 2) messages.json leeren (optional über ENV abschaltbar)
  const DO_PRUNE_MESSAGES = process.env.PRUNE_MESSAGES !== "false";
  let msgRes = { removed: 0 };
  if (DO_PRUNE_MESSAGES) {
    msgRes = clearMessagesJson(MESSAGES_FILE);
  }

  console.log(`✅ Fertig.
   • media gelöscht:  ${mediaRes.files} Dateien, ${mediaRes.dirsRemoved} Ordner
   • voice gelöscht:  ${voiceRes.files} Dateien, ${voiceRes.dirsRemoved} Ordner
   • music gelöscht:  ${musicRes.files} Dateien, ${musicRes.dirsRemoved} Ordner
   • messages.json:   ${DO_PRUNE_MESSAGES ? `entfernt ${msgRes.removed} Einträge` : "unverändert"}
   • behalten:        ${AVATARS_DIR} (Avatare/Profilbilder)
  `);
})();
