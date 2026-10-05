/*
 * Local watch history.
 *
 * YouTube's own history is not reachable from this build: playback goes through
 * yt-dlp, so no InnerTube /player or /stats/watchtime request is ever made and
 * the account's FEhistory stays empty. This store is the replacement.
 *
 * The server is shared between several viewers, so every record is filed under
 * a profile_id. The player supplies it (see resolveProfileId in server.js); a
 * client without one lands in "default" rather than being dropped.
 *
 * Storage is a single JSON file per profile under back/history/. No native
 * dependency: the box this runs on is old, and node:sqlite would need Node 22+
 * (this project targets Node 20). Records are kept in memory and flushed
 * atomically with a debounce, so the common path - a handful of videos over a
 * few minutes - costs one write, not one write per request.
 *
 * A record is written when the player reports real playing time past
 * MIN_WATCH_SECONDS. Watching the same video again accumulates
 * watch_seconds instead of adding a second row, which keeps "continue
 * watching" and the affinity ranking honest.
 */

const fs = require('fs');
const path = require('path');

const logger = require('./logger');

const DATA_DIR = path.join(__dirname, 'history');

// A view has to get past this before it counts as "watched". Below ~30s it is
// usually a preview, a mis-click or a row that autoplayed while the user was
// still browsing.
const MIN_WATCH_SECONDS = 30;

// Housekeeping bounds, applied on every flush.
const MAX_RECORDS = 500;
const MAX_AGE_DAYS = 90;

// Clients report on navigation away from the watch screen, so a crash or a
// pulled plug loses the current session. 30s of lost time is cheap.
const MAX_SESSION_SECONDS = 6 * 60 * 60;

const MAX_PLAYS = 100000;

const FLUSH_DEBOUNCE_MS = 2000;

// profileId -> { records: Map<videoId, record>, dirty: bool, timer: Node|null }
const cache = new Map();

// profileId -> in-flight refresh promise, so concurrent first writes of the
// same profile do not both read the file and clobber each other.
const loading = new Map();

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isValidProfileId(value) {
    return typeof value === 'string' && PROFILE_RE.test(value);
}

function profilePath(profileId) {
    return path.join(DATA_DIR, `${profileId}.json`);
}

function clampString(value, max) {
    if (typeof value !== 'string') return '';
    return value.slice(0, max);
}

function clampSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n), MAX_SESSION_SECONDS);
}

function clampPlays(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.round(n), MAX_PLAYS);
}

function sanitizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const videoId = clampString(raw.video_id, 24);
    if (!/^[\w-]{6,24}$/.test(videoId)) return null;
    const watchedAt = Number(raw.watched_at);
    return {
        video_id: videoId,
        title: clampString(raw.title, 300),
        channel_id: clampString(raw.channel_id, 64),
        channel: clampString(raw.channel, 160),
        thumbnail: clampString(raw.thumbnail, 600),
        duration: Math.max(0, Math.round(Number(raw.duration) || 0)),
        watch_seconds: clampSeconds(raw.watch_seconds),
        first_watched_at: Number.isFinite(watchedAt) ? watchedAt : 0,
        watched_at: Number.isFinite(watchedAt) ? watchedAt : 0,
        plays: clampPlays(raw.plays),
    };
}

function loadFromDisk(profileId) {
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(profilePath(profileId), 'utf8'));
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            logger.error('history', 'profile read failed, starting empty', {
                profile_id: profileId,
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
        return { version: 1, profile_id: profileId, records: new Map() };
    }

    const records = new Map();
    const list = parsed && Array.isArray(parsed.records) ? parsed.records : [];
    for (const raw of list) {
        const rec = sanitizeRecord(raw);
        if (rec) records.set(rec.video_id, rec);
    }
    return { version: 1, profile_id: profileId, records };
}

function entryFor(profileId) {
    let entry = cache.get(profileId);
    if (!entry) {
        entry = { records: new Map(), dirty: false, timer: null };
        cache.set(profileId, entry);
    }
    return entry;
}

async function ensureLoaded(profileId) {
    const entry = entryFor(profileId);
    if (entry.records.size > 0) return entry;
    let pending = loading.get(profileId);
    if (!pending) {
        pending = Promise.resolve().then(() => {
            loading.delete(profileId);
            // Another write may have landed while we were resolving.
            if (entry.records.size > 0) return entry;
            const loaded = loadFromDisk(profileId);
            for (const [id, rec] of loaded.records) entry.records.set(id, rec);
            return entry;
        });
        loading.set(profileId, pending);
    }
    return pending;
}

function prune(entry, now) {
    const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, rec] of entry.records) {
        if (rec.watched_at < cutoff) entry.records.delete(id);
    }
    if (entry.records.size > MAX_RECORDS) {
        const sorted = [...entry.records.entries()].sort((a, b) => b[1].watched_at - a[1].watched_at);
        for (const [id] of sorted.slice(MAX_RECORDS)) entry.records.delete(id);
    }
}

function writeToDisk(profileId, entry, now) {
    prune(entry, now);
    const list = [...entry.records.values()].sort((a, b) => b.watched_at - a.watched_at);
    const payload = JSON.stringify({ version: 1, profile_id: profileId, records: list });
    const file = profilePath(profileId);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
        // rename(2) is atomic within a filesystem, so a reader never sees a
        // half-written file even if the box loses power mid-write.
        fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
        // rename keeps the source file's mode, so the mode has to be set on the
        // temporary file above - setting it after the rename would leave a window
        // where the journal was world-readable. This is what someone watched, and
        // it is keyed by account, so it gets the same 600 as back/accounts/.
        fs.renameSync(tmp, file);
    } catch (err) {
        logger.error('history', 'profile write failed', {
            profile_id: profileId,
            message: logger.truncateStderr(String(err.message || err)),
        });
        try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    }
}

function scheduleFlush(profileId) {
    const entry = entryFor(profileId);
    entry.dirty = true;
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!entry.dirty) return;
        entry.dirty = false;
        writeToDisk(profileId, entry, Date.now());
    }, FLUSH_DEBOUNCE_MS);
    if (entry.timer.unref) entry.timer.unref();
}

function flushProfile(profileId) {
    const entry = entryFor(profileId);
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    if (!entry.dirty) return;
    entry.dirty = false;
    writeToDisk(profileId, entry, Date.now());
}

function flushAll() {
    for (const profileId of cache.keys()) flushProfile(profileId);
}

/*
 * Record a play session. Returns the stored record, or null when the session
 * did not last long enough to count.
 *
 * `plays` is a delta, not a flag: a session reports its watch time in pieces (a
 * heartbeat while playing, a flush when it stops), and only the piece that ends
 * the session counts as one play. Left out, a report counts as one play.
 */
async function recordPlay(profileId, payload) {
    const now = Date.now();
    const entry = await ensureLoaded(profileId);
    const seconds = clampSeconds(payload && payload.watch_seconds);
    const plays = payload && payload.plays !== undefined
        ? Math.max(0, Math.min(Math.round(Number(payload.plays) || 0), 10))
        : 1;
    const incoming = sanitizeRecord({
        video_id: payload && payload.video_id,
        title: payload && payload.title,
        channel_id: payload && payload.channel_id,
        channel: payload && payload.channel,
        thumbnail: payload && payload.thumbnail,
        duration: payload && payload.duration,
        watch_seconds: seconds,
        watched_at: now,
        plays,
    });
    if (!incoming) return null;

    const existing = entry.records.get(incoming.video_id);
    let rec = existing;
    if (existing) {
        // Keep the richest metadata we ever saw for this video; a heartbeat
        // session carries no title of its own.
        if (incoming.title) existing.title = incoming.title;
        if (incoming.channel_id) existing.channel_id = incoming.channel_id;
        if (incoming.channel) existing.channel = incoming.channel;
        if (incoming.thumbnail) existing.thumbnail = incoming.thumbnail;
        if (incoming.duration) existing.duration = incoming.duration;
        existing.watch_seconds = clampSeconds(existing.watch_seconds + incoming.watch_seconds);
        existing.watched_at = now;
        existing.plays = clampPlays(existing.plays + plays);
        if (!existing.first_watched_at) existing.first_watched_at = now;
        rec = existing;
    } else {
        // Replaying a long video should not restart its clock: seed from the
        // already known position so an accumulation can pass the threshold.
        rec = incoming;
        rec.first_watched_at = now;
        entry.records.set(rec.video_id, rec);
    }

    if (rec.watch_seconds < MIN_WATCH_SECONDS) {
        // Still worth persisting: the next session of the same video pushes it
        // over the line, and we do not want to re-add it from scratch.
        scheduleFlush(profileId);
        return rec;
    }
    scheduleFlush(profileId);
    return rec;
}

/* Records for one profile, newest first. */
async function listHistory(profileId, limit) {
    const entry = await ensureLoaded(profileId);
    const cap = Math.max(1, Math.min(Number(limit) || MAX_RECORDS, MAX_RECORDS));
    const list = [...entry.records.values()]
        .filter((r) => r.watch_seconds >= MIN_WATCH_SECONDS)
        .sort((a, b) => b.watched_at - a.watched_at)
        .slice(0, cap);
    return list;
}

/*
 * Channel affinity for the home feed, derived from the local journal: how many
 * distinct videos were watched per channel, how much time went into them and
 * how recent they are.
 */
async function affinity(profileId, opts) {
    const o = opts || {};
    const windowDays = Math.max(1, Math.min(Number(o.windowDays) || 30, MAX_AGE_DAYS));
    const limit = Math.max(1, Math.min(Number(o.limit) || 12, 50));
    const entry = await ensureLoaded(profileId);
    const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const channels = new Map();
    for (const rec of entry.records.values()) {
        if (rec.watch_seconds < MIN_WATCH_SECONDS) continue;
        if (rec.watched_at < since) continue;
        const key = rec.channel_id || rec.channel;
        if (!key) continue;
        const ageDays = Math.max(0, (now - rec.watched_at) / 86400000);
        // Recency decay on a 14 day half life, so a month-old binge does not
        // outrank what someone played this week.
        const recency = Math.pow(0.5, ageDays / 14);
        const row = channels.get(key) || {
            channel_id: rec.channel_id || '',
            channel: rec.channel || '',
            videos: 0,
            watch_seconds: 0,
            score: 0,
        };
        row.videos += 1;
        row.watch_seconds += rec.watch_seconds;
        row.score += recency * (1 + Math.min(rec.watch_seconds, 3600) / 3600);
        if (!row.channel && rec.channel) row.channel = rec.channel;
        channels.set(key, row);
    }

    return [...channels.values()]
        .sort((a, b) => b.score - a.score || b.watch_seconds - a.watch_seconds)
        .slice(0, limit);
}

/* Videos that should be surfaced first on the home feed, for this profile. */
async function topVideos(profileId, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(Number(o.limit) || 20, MAX_RECORDS));
    const windowDays = Math.max(1, Math.min(Number(o.windowDays) || 30, MAX_AGE_DAYS));
    const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const entry = await ensureLoaded(profileId);
    const now = Date.now();

    return [...entry.records.values()]
        .filter((r) => r.watch_seconds >= MIN_WATCH_SECONDS && r.watched_at >= since)
        .map((r) => {
            const ageDays = Math.max(0, (now - r.watched_at) / 86400000);
            const recency = Math.pow(0.5, ageDays / 14);
            const completion = r.duration > 0 ? Math.min(r.watch_seconds / r.duration, 1) : 0;
            return { rec: r, score: recency * (1 + completion) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.rec);
}

function stats(profileId) {
    const entry = entryFor(profileId);
    let seconds = 0;
    let counted = 0;
    for (const rec of entry.records.values()) {
        if (rec.watch_seconds >= MIN_WATCH_SECONDS) {
            seconds += rec.watch_seconds;
            counted += 1;
        }
    }
    return { records: entry.records.size, counted, watch_seconds: seconds, min_watch_seconds: MIN_WATCH_SECONDS };
}

/* Local watch journal.
 *
 * Keyed on the viewer's Google `sub` and reachable only through a server-verified
 * session - see historyAccount in server.js. Nothing the caller sends names the
 * file any more, so there is no id to guess and no "default" bucket to read.
 * Rows written under the old caller-supplied profile ids stay on disk, untouched,
 * and are no longer served by anything.
 */
const ENABLED = true;

module.exports = {
    ENABLED,
    MIN_WATCH_SECONDS,
    isValidProfileId,
    recordPlay,
    listHistory,
    affinity,
    topVideos,
    stats,
    flushAll,
    flushProfile,
};
