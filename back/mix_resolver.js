/**
 * Mix/Radio playlists ("RD…" ids, plus "UL…" for My Mix).
 *
 * The modern InnerTube search endpoint hands mixes to the client as plain
 * videoRenderer tiles whose "videoId" is a playlist id 26 chars long. Nothing
 * else in the app treats them specially, so without this module a mix tile is
 * a dead end: no thumbnail exists for an RD id (i.ytimg 404s) and yt-dlp
 * refuses to open one ("This playlist type is unviewable").
 *
 * Resolution works the way YouTube's own radio works: InnerTube /next with a
 * playlistId returns the mix queue (playlistPanelVideoRenderer rows). The
 * queue is cached - one InnerTube call per mix per TTL, single-flight - and
 * every consumer reads from here:
 *   - /get_video_info?video_id=RD…  plays the head of the queue;
 *   - /api/related?videoId=RD…      returns the whole queue as the chain, so
 *     playback keeps rolling through the radio after the first track;
 *   - /api/video-meta/RD…           describes the head so the watch screen
 *     has a title;
 *   - the search adapter           decorates mix tiles with the head's thumb
 *     and a "Mix – …" title.
 *
 * Renderer paths inside the /next response move around between client
 * versions, so instead of walking fixed paths the tree is scanned in depth
 * for anything shaped like a video row - the same defence the rest of this
 * backend uses against YouTube renaming wrappers.
 */

const axios = require('axios');
const logger = require('./logger');

// Same TVHTML5 key/client the rest of the project already talks to.
const API_KEY = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
const API_ROOT = 'https://www.googleapis.com/youtubei/v1';
const CLIENT = {
    clientName: 'TVHTML5',
    clientVersion: '7.20250205.16.00',
    hl: 'en',
    gl: 'US',
};

const INNERTUBE_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 64;
const MAX_QUEUE = 50;

// A real videoId is exactly 11 chars; mix ids are longer and start with the
// RD (radio) or UL (My Mix) playlist prefixes.
const VIDEO_ID_RE = /^[\w-]{11}$/;
const MIX_ID_RE = /^(RD|UL)[\w-]+$/;

function isVideoId(id) {
    return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

function isMixId(id) {
    return typeof id === 'string' && id.length > 11 && MIX_ID_RE.test(id);
}

function textOf(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
        for (const part of node) {
            const t = textOf(part);
            if (t) return t;
        }
        return '';
    }
    if (typeof node === 'object') {
        if (node.simpleText) return String(node.simpleText);
        if (Array.isArray(node.runs)) {
            return node.runs.map(r => (r && r.text) || '').join('').trim();
        }
    }
    return '';
}

function thumbOf(node) {
    const thumbs = node && node.thumbnail && (node.thumbnail.thumbnails || node.thumbnail);
    if (!Array.isArray(thumbs) || !thumbs.length) return '';
    let best = thumbs[0];
    for (const t of thumbs) if (Number(t && t.width) > Number(best && best.width)) best = t;
    return (best && best.url) || '';
}

function authorIdOf(node) {
    const runs = (node && node.longBylineText && node.longBylineText.runs)
        || (node && node.shortBylineText && node.shortBylineText.runs) || [];
    for (const run of runs) {
        const bid = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint
            && run.navigationEndpoint.browseEndpoint.browseId;
        if (typeof bid === 'string' && /^UC[\w-]{22}$/.test(bid)) return bid;
    }
    return '';
}

/* Rows of the radio queue carry only ids in this client version: the panel
   object (contents.singleColumnWatchNextResults.playlist.playlist) has no
   contents, and the full queue arrives flat in mdxExpandedVideoList.videoIds.
   The head track is the one videoMetadataRenderer describes in full - title,
   owner, artwork - so it is pulled out separately and the rest of the rows
   are enriched by the consumers that need labels. */
const ROW_KEYS = [
    'playlistPanelVideoRenderer',
    'playlistVideoRenderer',
    'videoRenderer',
    'tileRenderer',
];

function collectQueue(root) {
    const seen = new Set();
    const queue = [];

    const push = (renderer) => {
        const id = isVideoId(renderer.videoId) ? renderer.videoId
            : isVideoId(renderer.contentId) ? renderer.contentId : null;
        if (!id || seen.has(id)) return;
        const row = {
            id,
            title: textOf(renderer.title)
                || textOf(renderer.headline)
                || textOf(renderer.playlistItemTitle) || '',
            author: textOf(renderer.shortBylineText) || textOf(renderer.longBylineText) || '',
            authorId: authorIdOf(renderer),
            duration: textOf(renderer.lengthText),
            thumb: thumbOf(renderer),
        };
        seen.add(id);
        queue.push(row);
    };

    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 40 || queue.length >= MAX_QUEUE) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (!child || typeof child !== 'object') continue;
            if (ROW_KEYS.indexOf(key) >= 0) {
                push(child);
                continue;
            }
            walk(child, depth + 1);
        }
    };
    walk(root, 0);
    return queue;
}

/* Flat id list of the whole radio session. Sits next to the panel; when the
   client version renames it, the tree walk below still yields something. */
function flatQueueIds(root) {
    const out = [];
    const seen = new Set();
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 12 || out.length >= MAX_QUEUE) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (key === 'videoIds' && Array.isArray(child)) {
                for (const id of child) {
                    if (isVideoId(id) && !seen.has(id)) {
                        seen.add(id);
                        out.push(id);
                    }
                }
                continue;
            }
            if (child && typeof child === 'object') walk(child, depth + 1);
        }
    };
    walk(root, 0);
    return out;
}

/* Full metadata of the track that is playing now: title, owner, artwork. */
function headMetadata(root) {
    let meta = null;
    const walk = (node, depth) => {
        if (meta || !node || typeof node !== 'object' || depth > 12) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (!child || typeof child !== 'object') continue;
            if (key === 'videoMetadataRenderer' && isVideoId(child.videoId)) {
                const owner = child.owner && child.owner.videoOwnerRenderer;
                const authorText = owner && (textOf(owner.title) || '');
                meta = {
                    id: child.videoId,
                    title: textOf(child.title),
                    author: authorText,
                    authorId: '',
                    thumb: thumbOf(owner || {}),
                };
                return;
            }
            walk(child, depth + 1);
        }
    };
    walk(root, 0);
    return meta;
}

/* Radio identity from the panel: "Electric Callboy" / "Artist radio". */
function radioIdentity(root) {
    let panel = null;
    const walk = (node, depth) => {
        if (panel || !node || typeof node !== 'object' || depth > 8) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (key === 'playlist' && child && typeof child === 'object' && isMixId(child.playlistId)) {
                panel = child;
                return;
            }
            walk(child, depth + 1);
        }
    };
    walk(root, 0);
    if (!panel) return null;
    return {
        title: textOf(panel.title) || '',
        kind: textOf(panel.ownerName) || '',
        isInfinite: !!panel.isInfinite,
        currentIndex: Number(panel.currentIndex) || 0,
    };
}

async function fetchMixQueue(mixId) {
    const url = `${API_ROOT}/next?key=${API_KEY}`;
    const resp = await axios.post(url, {
        context: { client: CLIENT },
        playlistId: mixId,
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: INNERTUBE_TIMEOUT_MS,
    });
    const data = resp.data;

    const identity = radioIdentity(data);
    const head = headMetadata(data);

    // Whole session as a flat id list, head first; merge in any labelled rows
    // the tree walk finds so a renamed wrapper degrades to fewer rows instead
    // of an empty queue.
    const ids = flatQueueIds(data);
    const walked = collectQueue(data);
    const seen = new Set();
    const queue = [];
    const addRow = (row) => {
        if (!row || !isVideoId(row.id) || seen.has(row.id)) return;
        seen.add(row.id);
        queue.push(row);
    };
    if (head) {
        addRow({
            id: head.id,
            title: head.title,
            author: head.author,
            authorId: head.authorId,
            duration: '',
            thumb: head.thumb,
        });
    }
    for (const id of ids) addRow({ id, title: '', author: '', authorId: '', duration: '', thumb: '' });
    for (const row of walked) addRow(row);

    if (!queue.length) {
        throw new Error('mix queue came back empty');
    }
    logger.info('mix', 'queue built', {
        mix_id: mixId,
        count: queue.length,
        head: queue[0].id,
        radio: identity && identity.title || '',
        kind: identity && identity.kind || '',
    });
    return { queue, identity };
}

const cache = new Map();     // mixId -> { queue, identity, head, ts }
const inflight = new Map();  // mixId -> Promise

/* Head of the mix plus the full queue. Resolved once per TTL and shared by
   every consumer, so the search decoration, the watch screen and the chain
   all hit the same InnerTube call. */
async function resolveMix(mixId) {
    if (!isMixId(mixId)) throw new Error('not a mix id: ' + mixId);

    const hit = cache.get(mixId);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;

    const pending = inflight.get(mixId);
    if (pending) return pending;

    const job = fetchMixQueue(mixId)
        .then(({ queue, identity }) => {
            const result = { mixId, queue, identity, head: queue[0], ts: Date.now() };
            if (cache.size > MAX_CACHE) cache.clear();
            cache.set(mixId, result);
            inflight.delete(mixId);
            return result;
        })
        .catch(err => {
            inflight.delete(mixId);
            logger.warn('mix', 'resolve failed', {
                mix_id: mixId,
                message: logger.truncateStderr(String(err.message || err)),
            });
            throw err;
        });
    inflight.set(mixId, job);
    return job;
}

module.exports = { isMixId, isVideoId, resolveMix };
