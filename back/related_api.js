/**
 * Related videos for the endless ("chain") playback mode.
 *
 * Priority order, exactly like YouTube's own "Up next" machinery:
 *   1. InnerTube /next for the current video — its response carries the
 *      autoplay pick (compactAutoplayRenderer) first, then the "more videos
 *      from this channel"/"up next" shelves, in YouTube's own ranked order.
 *   2. InnerTube /search seeded with the current video's title/uploader (taken
 *      from the yt-dlp metadata cache), preferring results from the same
 *      channel — used when /next comes back without any related item (e.g. for
 *      freshly uploaded videos where the related shelf is not built yet).
 *
 * Renderers differ between InnerTube client versions, so instead of walking a
 * fixed tree we scan for any node that looks like a video and pull id/title/
 * author out of it. Order of appearance is preserved, which keeps YouTube's
 * ranking, and the autoplay pick is hoisted to the front.
 */

const axios = require('axios');
const logger = require('./logger');
const { getVideoInfoCached } = require('./get_video_info');

// Same TVHTML5 key/client the rest of the project already talks to.
const API_KEY = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
const API_ROOT = 'https://www.googleapis.com/youtubei/v1';
const CLIENT = {
    clientName: 'TVHTML5',
    clientVersion: '7.20250205.16.00',
    hl: 'en',
    gl: 'US',
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 64;
const cache = new Map();      // videoId -> { items, ts, source }
const inflight = new Map();   // videoId -> Promise

const VIDEO_ID_RE = /^[\w-]{11}$/;

function isVideoId(v) {
    return typeof v === 'string' && VIDEO_ID_RE.test(v);
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

function pick(node, path) {
    let cur = node;
    for (const key of path) {
        if (cur === null || cur === undefined) return null;
        cur = cur[key];
    }
    return cur === undefined ? null : cur;
}

function thumbOf(node) {
    const thumbs = pick(node, ['thumbnail', 'thumbnails'])
        || pick(node, ['thumbnails'])
        || pick(node, ['thumbnailRenderer', 'thumbnails'])
        || pick(node, ['thumbnail', 'thumbnails']);
    if (!Array.isArray(thumbs) || !thumbs.length) return '';
    let best = thumbs[0];
    for (const t of thumbs) if (Number(t && t.width) > Number(best && best.width)) best = t;
    return best && best.url ? String(best.url) : '';
}

function looksLive(node) {
    const badges = (node && node.badges) || [];
    if (Array.isArray(badges)) {
        for (const b of badges) {
            const label = textOf(pick(b, ['metadataBadgeRenderer', 'label']))
                || textOf(pick(b, ['liveBadgeRenderer']))
                || textOf(pick(b, ['thumbnailOverlayTimeStatusRenderer', 'text']));
            if (/live/i.test(label)) return true;
        }
    }
    if (pick(node, ['thumbnailOverlays'])) {
        const raw = JSON.stringify(node.thumbnailOverlays);
        if (/LIVE_NOW|live now/i.test(raw)) return true;
    }
    const type = textOf(pick(node, ['thumbnailOverlayTimeStatusRenderer', 'style']));
    if (/LIVE/i.test(type)) return true;
    return false;
}

function looksLikeShort(node) {
    return /shorts|reel/i.test(String(pick(node, ['navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url']) || ''));
}

// Collect every video-looking node out of an arbitrary InnerTube response.
function collectVideos(root, skipId, out) {
    const seen = out.byId;
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        const id = isVideoId(node.videoId) ? node.videoId : null;
        if (id && id !== skipId && !seen[id]) {
            const title = textOf(node.title)
                || textOf(pick(node, ['headline']))
                || textOf(pick(node, ['metadata', 'videoDetails', 'title']));
            const author = textOf(node.ownerText)
                || textOf(node.shortBylineText)
                || textOf(node.longBylineText)
                || textOf(pick(node, ['longBylineText', 'runs']));
            seen[id] = true;
            out.list.push({
                id,
                title: title || id,
                author,
                duration: textOf(node.lengthText) || textOf(pick(node, ['lengthText', 'simpleText'])),
                thumb: thumbOf(node),
                live: looksLive(node),
                short: looksLikeShort(node),
                autoplay: !!(node.compactAutoplayRenderer || node.autoplayRenderer),
            });
        }
        for (const key of Object.keys(node)) {
            if (key === 'thumbnail' || key === 'thumbnails') continue;
            walk(node[key], depth + 1);
        }
    };
    walk(root, 0);
}

function orderCandidates(list) {
    const autoplay = list.filter(v => v.autoplay);
    const rest = list.filter(v => !v.autoplay);
    const byId = new Map();
    for (const v of autoplay.concat(rest)) if (!byId.has(v.id)) byId.set(v.id, v);
    return Array.from(byId.values());
}

async function innertube(endpoint, body) {
    const url = `${API_ROOT}/${endpoint}?key=${API_KEY}`;
    const resp = await axios.post(url, { context: { client: CLIENT }, ...body }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000,
    });
    return resp.data;
}

function searchQueryFor(meta) {
    const title = String((meta && meta.title) || '').replace(/\s+/g, ' ').trim();
    if (!title) return '';
    // Drop the usual "official video / hd / lyrics" noise, keep the meat of the title.
    const cleaned = title
        .replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ')
        .replace(/\b(official|official video|official audio|music video|lyrics?|lyric video|hd|hq|4k|remastered|full album|audio|visualizer|mv)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const uploader = String((meta && (meta.uploader || meta.channel || meta.artist)) || '').trim();
    const query = (cleaned || title).slice(0, 120);
    return uploader ? `${uploader} ${query}`.slice(0, 160) : query;
}

async function fromNext(videoId) {
    const data = await innertube('next', { videoId });
    const out = { list: [], byId: {} };
    collectVideos(data, videoId, out);
    // The "next" response also repeats the current video inside shelves and
    // end-screen data; collectVideos already drops the current id.
    return orderCandidates(out.list);
}

async function fromSearch(videoId, meta) {
    const query = searchQueryFor(meta);
    if (!query) return [];
    const data = await innertube('search', { query });
    const out = { list: [], byId: {} };
    collectVideos(data, videoId, out);
    let items = orderCandidates(out.list);
    const sameChannel = String((meta && (meta.uploader_id || meta.channel_id)) || '');
    if (sameChannel) {
        const own = items.filter(v => v.author && v.author.toLowerCase() === String(meta.uploader || '').toLowerCase());
        if (own.length) items = own.concat(items.filter(v => own.indexOf(v) < 0));
    }
    return items;
}

async function fetchRelated(videoId, limit) {
    const max = Math.max(1, Math.min(30, Number(limit) || 12));
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit, cached: true };
    if (inflight.has(videoId)) return inflight.get(videoId);

    const job = (async () => {
        let items = [];
        let source = 'next';
        try {
            items = await fromNext(videoId);
        } catch (err) {
            logger.warn('related', 'InnerTube next failed', {
                video_id: videoId,
                message: logger.truncateStderr(String(err.message || err)),
            });
        }

        if (!items.length) {
            source = 'search';
            let meta = null;
            try {
                meta = await getVideoInfoCached(videoId);
            } catch (err) {
                logger.warn('related', 'metadata for search seed unavailable', {
                    video_id: videoId,
                    message: logger.truncateStderr(String(err.message || err)),
                });
            }
            try {
                items = await fromSearch(videoId, meta);
            } catch (err) {
                logger.warn('related', 'InnerTube search failed', {
                    video_id: videoId,
                    message: logger.truncateStderr(String(err.message || err)),
                });
            }
        }

        const result = { videoId, source, items: items.slice(0, max) };
        try {
            if (cache.size > MAX_CACHE) cache.clear();
        } catch (e) { /* ignore */ }
        cache.set(videoId, { ...result, ts: Date.now() });
        logger.info('related', 'related list built', {
            video_id: videoId,
            source,
            count: result.items.length,
        });
        return result;
    })();

    inflight.set(videoId, job);
    try {
        return await job;
    } finally {
        inflight.delete(videoId);
    }
}

module.exports = { fetchRelated };
