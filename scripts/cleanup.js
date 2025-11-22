// server/scripts/cleanup.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, ".."); // -> server
const UPLOADS = path.join(ROOT, "uploads");

// Ordner vollständig leeren (Dateien + Unterordner)
const DIRS_TO_WIPE = ["music", "images", "media", "voice", "lyrics", "snippets", "covers"];

// Diese JSON-"Indizes" auf [] zurücksetzen (nur wenn vorhanden)
const JSON_FILES_TO_RESET = [
  "messages.json",
  "music.json",
  "snippets.json",
  "images.json",
  "notifications.json",
  // "follows.json", // <- nur auskommentieren, wenn du Follows auch löschen willst
];

function emptyDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const name of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, name), { recursive: true, force: true });
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resetJsonArray(filePath) {
  try {
    fs.writeFileSync(filePath, "[\n]\n");
    console.log(`🧾 ${path.basename(filePath)} geleert`);
  } catch (e) {
    console.warn("⚠️ Fehler beim Schreiben:", filePath, e.message);
  }
}

function main() {
  console.log("🧹 Starte Cleanup ...");
  ensureDir(UPLOADS);

  for (const d of DIRS_TO_WIPE) {
    const dir = path.join(UPLOADS, d);
    ensureDir(dir);
    emptyDir(dir);
    console.log(`✅ /uploads/${d} geleert`);
  }

  // Avatare üblicherweise behalten
  const avatars = path.join(UPLOADS, "avatars");
  ensureDir(avatars);
  console.log("🛡️  /uploads/avatars bleibt erhalten");

  for (const f of JSON_FILES_TO_RESET) {
    const file = path.join(ROOT, f);
    if (fs.existsSync(file)) resetJsonArray(file);
  }

  console.log("✅ Cleanup abgeschlossen!");
}

if (require.main === module) main();
