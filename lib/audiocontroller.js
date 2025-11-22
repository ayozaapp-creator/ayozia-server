// server/lib/audiocontroller.js
import axios from "axios";
import {
  Audio,
  InterruptionModeAndroid,
  InterruptionModeIOS,
} from "expo-av";

const API =
  process.env.EXPO_PUBLIC_API_URL || "https://ayozia-server.onrender.com";

const http = axios.create({
  baseURL: API,
  timeout: 8000,
});

/** ───────────────────────── Store/Subscribe ───────────────────────── */
const listeners = new Set();
function emit() {
  for (const cb of listeners) cb(getSnapshot());
}
function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let sound = null;
let isLoading = false; // Loading-Lock gegen doppelte Instanzen

// 60%-Play-Logik
let playReportedForCurrent = false;

// Queue / Playlist für prev / next
let queue = []; // [{...track}]
let queueIndex = -1;

let state = {
  current: null, // { id, title, url, cover } | null
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  isBuffering: false,
  isLoading: false, // für UI (Buttons sperren)
};

function setState(patch) {
  state = { ...state, ...patch };
  emit();
}
function getSnapshot() {
  return { ...state };
}

/** ───────────────────────── Audio-Mode einmal setzen ───────────────────────── */
(async function configure() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: true,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: false,
    });
  } catch {}
})();

/** ───────────────────────── Helpers ───────────────────────── */
async function unload() {
  if (!sound) return;
  try {
    await sound.unloadAsync();
  } catch {}
  try {
    sound.setOnPlaybackStatusUpdate(null);
  } catch {}
  sound = null;
}

/**
 * Track in Queue/Historie aufnehmen.
 * - trackKey = id oder url als Fallback
 */
function updateQueueForTrack(track) {
  if (!track) return;
  const key = track.id ?? track.url;
  if (!key) return;

  if (queueIndex >= 0 && queueIndex < queue.length - 1) {
    // alles "rechts" wegschneiden, wenn wir mitten in der History
    queue = queue.slice(0, queueIndex + 1);
  }

  const existingIndex = queue.findIndex(
    (t) => (t.id ?? t.url) === key
  );

  if (existingIndex === -1) {
    queue.push(track);
    queueIndex = queue.length - 1;
  } else {
    queueIndex = existingIndex;
    queue[existingIndex] = { ...queue[existingIndex], ...track };
  }
}

/**
 * Ganze Queue / Playlist von außen setzen.
 * Wird zum Beispiel vom Feed mit allen Songs aufgerufen.
 */
function setFullQueue(tracks, startIndex = 0) {
  if (!Array.isArray(tracks) || tracks.length === 0) return;

  const filtered = tracks.filter((t) => t && (t.id || t.url));
  if (!filtered.length) return;

  queue = filtered;
  queueIndex = Math.max(
    0,
    Math.min(startIndex, filtered.length - 1)
  );
}

/**
 * Wird von AVPlayer bei jedem Status-Update aufgerufen
 */
function onStatusUpdate(s) {
  if (!s) return;
  const positionMs = s.positionMillis ?? 0;
  const durationMs = s.durationMillis ?? 0;

  setState({
    isPlaying: !!s.isPlaying,
    isBuffering: !!s.isBuffering,
    positionMs,
    durationMs,
  });

  // 🔥 60%-Regel: erst dann wird ein Play gezählt
  if (
    !playReportedForCurrent &&
    state.current?.id &&
    durationMs > 0
  ) {
    const ratio = positionMs / durationMs;
    if (ratio >= 0.6) {
      playReportedForCurrent = true;
      reportPlay(state.current).catch(() => {});
    }
  }

  // Auto-Next, wenn der Track fertig ist (kein Loop)
  if (s.didJustFinish && !s.isLooping) {
    controller.next().catch(() => {});
  }
}

/**
 * 🔥 Track-Play an den Server melden
 * Wird NUR einmal pro Track/Session aufgerufen,
 * wenn 60 % gehört wurden (siehe onStatusUpdate).
 */
async function reportPlay(track) {
  if (!track?.id) return;
  try {
    await http.post(`/tracks/${encodeURIComponent(track.id)}/play`);
  } catch (e) {
    console.log("Track-Play-Report fehlgeschlagen:", e?.message);
  }
}

/**
 * Helper: lädt einen Track neu und startet die Wiedergabe.
 * opts.fromQueue = true, wenn der Aufruf von prev()/next()/playFromQueue kam.
 */
async function loadAndPlay(track, opts = {}) {
  if (isLoading) return;
  if (!track?.url) return;

  isLoading = true;
  setState({ isLoading: true, current: track });

  // neue Session → 60%-Flag zurücksetzen
  playReportedForCurrent = false;

  // Queue nur aktualisieren, wenn nicht explizit aus Queue navigiert
  if (!opts.fromQueue) {
    updateQueueForTrack(track);
  }

  try {
    await unload();

    const { sound: newSound } = await Audio.Sound.createAsync(
      { uri: track.url },
      { shouldPlay: false, progressUpdateIntervalMillis: 200 }
    );

    sound = newSound;
    sound.setOnPlaybackStatusUpdate(onStatusUpdate);

    setState({
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
    });

    await sound.playAsync();
  } finally {
    isLoading = false;
    setState({ isLoading: false });
  }
}

/** ───────────────────────── Controller ───────────────────────── */
class AudioController {
  subscribe = subscribe;

  getSnapshot() {
    return getSnapshot();
  }

  // aktuelles Queue-Setup (z.B. zum Debuggen)
  getQueue() {
    return {
      items: [...queue],
      index: queueIndex,
    };
  }

  /**
   * Playlist / Queue von außen setzen
   */
  setQueue(tracks, startIndex = 0) {
    setFullQueue(tracks, startIndex);
  }

  /**
   * Direkt aus einer Liste spielen (Feed übergibt playlist + index)
   */
  async playFromQueue(tracks, index = 0) {
    if (isLoading) return;
    if (!Array.isArray(tracks) || !tracks.length) return;

    setFullQueue(tracks, index);
    const track = queue[queueIndex];
    if (!track) return;
    return loadAndPlay(track, { fromQueue: true });
  }

  async play(track) {
    if (!track?.url || isLoading) return;

    // gleicher Track → resume
    if (state.current?.id === track.id && sound) {
      return this.resume();
    }

    // neuer Track → load + play
    updateQueueForTrack(track);
    return loadAndPlay(track, { fromQueue: true });
  }

  async toggle(track) {
    if (!track?.url || isLoading) return;

    // anderer Track oder noch kein Sound → load + play
    if (state.current?.id !== track.id || !sound) {
      updateQueueForTrack(track);
      return loadAndPlay(track, { fromQueue: true });
    }

    // gleicher Track → Pause/Resume
    if (state.isPlaying) return this.pause();
    return this.resume();
  }

  async pause() {
    if (!sound) return;
    try {
      await sound.pauseAsync();
    } catch {}
  }

  async resume() {
    if (!sound) return;
    try {
      await sound.playAsync();
    } catch {}
  }

  async stop() {
    await unload();
    setState({
      current: null,
      isPlaying: false,
      positionMs: 0,
      durationMs: 0,
    });
    playReportedForCurrent = false;
    queue = [];
    queueIndex = -1;
  }

  /** ratio 0..1 (alte API) */
  async seek(ratio) {
    if (!sound || !state.durationMs) return;
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    const target = clamped * state.durationMs;
    return this.seekTo(target);
  }

  /** neue API: direkt in ms springen */
  async seekTo(ms) {
    if (!sound || !state.durationMs) return;
    const duration = state.durationMs;
    const target = Math.max(0, Math.min(duration, Number(ms) || 0));
    try {
      await sound.setPositionAsync(target);
      setState({ positionMs: target });
    } catch {}
  }

  /** vorheriger Track in der Queue */
  async prev() {
    if (!queue.length) return;

    // Wenn wir am Anfang sind → nur zum Anfang des Songs springen
    if (queueIndex <= 0) {
      if (sound) {
        try {
          await sound.setPositionAsync(0);
          await sound.playAsync();
          setState({ positionMs: 0, isPlaying: true });
        } catch {}
      }
      return;
    }

    queueIndex = queueIndex - 1;
    const track = queue[queueIndex];
    if (!track) return;
    return loadAndPlay(track, { fromQueue: true });
  }

  /** nächster Track in der Queue */
  async next() {
    if (!queue.length) return;
    if (queueIndex >= queue.length - 1) {
      // kein nächster Track → einfach am Ende bleiben
      return;
    }

    queueIndex = queueIndex + 1;
    const track = queue[queueIndex];
    if (!track) return;
    return loadAndPlay(track, { fromQueue: true });
  }
}

const controller = new AudioController();

/** React-freundliche API (Hook-ähnlich) */
export function useAudioSnapshot() {
  return {
    snapshot: controller.getSnapshot(),
    subscribe: (cb) => controller.subscribe(cb),
  };
}

export const audio = controller;
export default controller;
