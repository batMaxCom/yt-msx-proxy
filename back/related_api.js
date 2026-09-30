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
// upstream budget: one InnerTube call, then the search fallback, then answer
const INNERTUBE_TIMEOUT_MS = 12000;
const DEADLINE_MS = 15000;
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
        if (typeof node.content === 'string') return node.content;
        if (Array.isArray(node.runs)) {
            return node.runs.map(r => (r && r.text) || '').join('').trim();
        }
    }
    return '';
}

/* The channel id behind the author label, so the related panel can offer
   "open this channel". The byline runs carry a browseEndpoint on the web
   client; the TV tile only has the text, so this is often empty. */
function authorIdOf(node) {
    if (!node || typeof node !== 'object') return '';
    const bid = b => {
        if (typeof b === 'string') return /^UC[\w-]{22}$/.test(b) ? b : '';
        return b && typeof b === 'object' && /^UC[\w-]{22}$/.test(String(b.browseId || '')) ? b.browseId : '';
    };
    const fromRuns = runs => {
        for (const run of runs || []) {
            const got = bid(pick(run, ['navigationEndpoint', 'browseEndpoint', 'browseId']))
                || bid(pick(run, ['onTap', 'innertubeCommand', 'browseEndpoint', 'browseId']));
            if (got) return got;
        }
        return '';
    };

    for (const key of ['ownerText', 'shortBylineText', 'longBylineText']) {
        const t = node[key];
        const got = fromRuns(t && t.runs) || bid(t);
        if (got) return got;
    }

    /* The TV client puts the byline in the tile's metadata line rather than in
       ownerText: metadata.tileMetadataRenderer.lines[].lineRenderer.items[]
       .lineItemRenderer.text.runs[], and that run does carry the browseEndpoint. */
    const lines = pick(node, ['metadata', 'tileMetadataRenderer', 'lines'])
        || (node.metadata && node.metadata.lockupMetadataViewModel
            && node.metadata.lockupMetadataViewModel.metadata
            && node.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel
            && node.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows);
    for (const line of (Array.isArray(lines) ? lines : [])) {
        const items = (line && line.lineRenderer && line.lineRenderer.items) || [];
        for (const it of items) {
            const r = it && it.lineItemRenderer;
            if (!r) continue;
            const got = fromRuns(r.text && r.text.runs);
            if (got) return got;
        }
        // the lockupMetadataViewModel shape uses metadataParts with commandRuns
        for (const part of (line && line.metadataParts) || []) {
            const got = fromRuns(part && part.text && part.text.commandRuns);
            if (got) return got;
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
    const candidates = [
        node && node.thumbnail,
        node && node.thumbnailRenderer,
        node && pick(node, ['thumbnail', 'thumbnails']) ? { thumbnails: pick(node, ['thumbnail', 'thumbnails']) } : null,
        node && pick(node, ['header', 'tileHeaderRenderer', 'thumbnail']),
        node && pick(node, ['contentImage', 'thumbnail']) ? { thumbnails: pick(node, ['contentImage', 'thumbnail', 'thumbnails']) } : null,
        node && pick(node, ['backgroundImage', 'thumbnail']) ? { thumbnails: pick(node, ['backgroundImage', 'thumbnail', 'thumbnails']) } : null,
        node && pick(node, ['richThumbnail', 'content', 'image', 'thumbnails']) ? { thumbnails: pick(node, ['richThumbnail', 'content', 'image', 'thumbnails']) } : null,
    ];
    for (const c of candidates) {
        const thumbs = c && (Array.isArray(c) ? c : c.thumbnails);
        if (!Array.isArray(thumbs) || !thumbs.length) continue;
        let best = thumbs[0];
        for (const t of thumbs) if (Number(t && t.width) > Number(best && best.width)) best = t;
        if (best && best.url) return String(best.url);
    }
    return '';
}

function overlayOf(node) {
    const out = [];
    const push = v => { if (Array.isArray(v)) for (const o of v) if (o) out.push(o); };
    push(node && node.thumbnailOverlays);
    push(pick(node, ['thumbnail', 'thumbnailOverlays']));
    push(pick(node, ['header', 'tileHeaderRenderer', 'thumbnailOverlays']));
    push(pick(node, ['thumbnailRenderer', 'thumbnailOverlays']));
    return out;
}

function durationOf(node) {
    const direct = textOf(node && node.lengthText) || textOf(node && node.simpleText);
    if (direct) return direct;
    for (const o of overlayOf(node)) {
        const r = o.thumbnailOverlayTimeStatusRenderer;
        if (!r) continue;
        const t = textOf(r.text);
        if (t) return t;
    }
    return '';
}

function looksLive(node) {
    for (const o of overlayOf(node)) {
        const r = o.thumbnailOverlayTimeStatusRenderer;
        if (!r) continue;
        if (/live/i.test(String(r.style || ''))) return true;
        if (/live/i.test(String(pick(r, ['icon', 'iconType']) || ''))) return true;
        if (/live|watching/i.test(textOf(pick(r, ['text', 'accessibility', 'accessibilityData', 'label'])))) return true;
    }
    const badges = (node && node.badges) || [];
    if (Array.isArray(badges)) {
        for (const b of badges) {
            const label = textOf(pick(b, ['metadataBadgeRenderer', 'label']))
                || textOf(pick(b, ['liveBadgeRenderer']))
                || textOf(pick(b, ['thumbnailOverlayTimeStatusRenderer', 'text']));
            if (/live/i.test(label)) return true;
        }
    }
    if (node && node.thumbnailOverlays && /LIVE_NOW|live now/i.test(JSON.stringify(node.thumbnailOverlays))) return true;
    return false;
}

function looksLikeShort(node) {
    const url = pick(node, ['navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url'])
        || pick(node, ['onSelectCommand', 'commandMetadata', 'webCommandMetadata', 'url'])
        || '';
    if (/shorts|reel|embed\//i.test(String(url))) return true;
    const type = String((node && node.contentType) || '');
    return /short|reel/i.test(type);
}

/* The video id is the only reliable key, but where it sits depends on the
   renderer: TVHTML5 grid shelves hang it off contentId / onSelectCommand,
   autoplay off autonavEndpointRenderer, the search fallback off the lockup
   model's onTap innertube command. */
function idOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (isVideoId(node.videoId)) return node.videoId;
    if (isVideoId(node.contentId)) return node.contentId;
    const holders = [
        node.onSelectCommand, node.navigationEndpoint, node.onTap, node.endpoint,
        node.autonavEndpointRenderer, node.onFocusCommand,
        pick(node, ['rendererContext', 'commandContext', 'onTap']),
        pick(node, ['autonavEndpointRenderer', 'endpoint']),
    ];
    for (const h of holders) {
        if (!h || typeof h !== 'object') continue;
        if (isVideoId(h.videoId)) return h.videoId;
        if (h.watchEndpoint && isVideoId(h.watchEndpoint.videoId)) return h.watchEndpoint.videoId;
        if (h.innertubeCommand && h.innertubeCommand.watchEndpoint && isVideoId(h.innertubeCommand.watchEndpoint.videoId)) {
            return h.innertubeCommand.watchEndpoint.videoId;
        }
    }
    return null;
}

function authorOf(node) {
    const direct = textOf(node && node.ownerText)
        || textOf(node && node.shortBylineText)
        || textOf(node && node.longBylineText)
        || textOf(pick(node, ['longBylineText', 'runs']));
    if (direct) return direct.trim();
    const meta = (node && node.metadata) || {};
    const lines = meta.tileMetadataRenderer && meta.tileMetadataRenderer.lines
        || meta.lockupMetadataViewModel && meta.lockupMetadataViewModel.metadata
            && meta.lockupMetadataViewModel.metadata.contentMetadataViewModel
            && meta.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows;
    if (!Array.isArray(lines)) return '';
    for (const line of lines) {
        const items = line && line.lineRenderer && line.lineRenderer.items;
        if (!Array.isArray(items)) continue;
        for (const it of items) {
            const t = textOf(it && it.lineItemRenderer && it.lineItemRenderer.text);
            if (t && t !== '\u2022' && !/views?$|ago$/i.test(t)) return t.trim();
        }
    }
    return '';
}

/* Renderers that carry a full video card. Anything else in the tree is
   plumbing (transport targets, prefetch tasks, tracking) and is skipped. */
const RENDERER_KEYS = [
    'tileRenderer', 'compactVideoRenderer', 'videoRenderer', 'gridVideoRenderer',
    'playlistVideoRenderer', 'reelItemRenderer', 'videoWithContextRenderer',
    'autoplayVideoRenderer', 'lockupViewModel',
];

function addItem(renderer, skipId, out, key) {
    const id = idOf(renderer);
    if (!id || id === skipId) return;
    const title = textOf(renderer.title)
        || textOf(renderer.headline)
        || textOf(pick(renderer, ['metadata', 'tileMetadataRenderer', 'title']))
        || textOf(pick(renderer, ['metadata', 'lockupMetadataViewModel', 'title']));
    const author = authorOf(renderer);
    const authorId = authorIdOf(renderer);
    const duration = durationOf(renderer);
    const thumb = thumbOf(renderer);
    const live = looksLive(renderer);
    const short = looksLikeShort(renderer);
    // YouTube's own up-next pick: the key is the marker, the renderer itself
    // only carries the endpoint we switch to
    const autoplay = /autoplay/i.test(key) || !!renderer.autoplayVideoRenderer;

    const prev = out.byId.get(id);
    if (prev) {
        // the autoplay pick arrives before the shelf that describes it: keep the
        // first position but adopt every field the earlier bare node lacked
        if (!prev.title && title) prev.title = title;
        if (!prev.author && author) prev.author = author;
        if (!prev.authorId && authorId) prev.authorId = authorId;
        if (!prev.duration && duration) prev.duration = duration;
        if (!prev.thumb && thumb) prev.thumb = thumb;
        if (live) prev.live = true;
        if (short) prev.short = true;
        if (autoplay) prev.autoplay = true;
        return;
    }
    const item = { id, title, author, authorId, duration, thumb, live, short, autoplay };
    out.byId.set(id, item);
    out.list.push(item);
}

function collectVideos(root, skipId, out) {
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        for (const key of Object.keys(node)) {
            const child = node[key];
            if (!child || typeof child !== 'object') continue;
            if (RENDERER_KEYS.indexOf(key) >= 0) {
                addItem(child, skipId, out, key);
                continue;
            }
            walk(child, depth + 1);
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
        timeout: INNERTUBE_TIMEOUT_MS,
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
    const out = { list: [], byId: new Map() };
    collectVideos(data, videoId, out);
    // The "next" response also repeats the current video inside shelves and
    // end-screen data; collectVideos already drops the current id.
    return orderCandidates(out.list);
}

async function fromSearch(videoId, meta) {
    const query = searchQueryFor(meta);
    if (!query) return [];
    const data = await innertube('search', { query });
    const out = { list: [], byId: new Map() };
    collectVideos(data, videoId, out);
    let items = orderCandidates(out.list);
    const sameChannel = String((meta && (meta.uploader_id || meta.channel_id)) || '');
    if (sameChannel) {
        const own = items.filter(v => v.author && v.author.toLowerCase() === String(meta.uploader || '').toLowerCase());
        if (own.length) items = own.concat(items.filter(v => own.indexOf(v) < 0));
    }
    return items;
}

/* The autoplay pick is the one card /next sends without any metadata (it only
   carries an endpoint), so when it is not repeated in a shelf the top row would
   render blank. Fill just that one from the yt-dlp cache, under a short budget:
   the shelf items themselves must never wait on it. */
async function enrichBareTitles(items) {
    const bare = items.filter(it => it && it.id && !it.title).slice(0, 2);
    if (!bare.length) return items;
    await Promise.all(bare.map(async it => {
        try {
            const meta = await Promise.race([
                getVideoInfoCached(it.id),
                new Promise((_, rej) => setTimeout(() => rej(new Error('title lookup timed out')), 2500)),
            ]);
            if (meta && meta.title) it.title = String(meta.title);
            if (meta && !it.author) it.author = String(meta.uploader || meta.channel || '');
        } catch (err) { /* the id is still a usable row, just unlabelled */ }
    }));
    return items;
}

async function fetchRelated(videoId, limit) {
    const max = Math.max(1, Math.min(30, Number(limit) || 12));
    const hit = cache.get(videoId);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit, cached: true };
    if (inflight.has(videoId)) return inflight.get(videoId);

    const building = (async () => {
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

        const result = { videoId, source, items: await enrichBareTitles(items.slice(0, max)) };
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

    // A stalled upstream must not hold the route open: the panel is opened by
    // the user mid-playback, so an empty answer in a few seconds beats a
    // spinner that never resolves. Whatever landed by then is still returned.
    const job = Promise.race([
        building,
        new Promise(resolve => setTimeout(() => {
            logger.warn('related', 'deadline reached, answering with what we have', {
                video_id: videoId,
            });
            resolve({ videoId, source: 'timeout', items: [] });
        }, DEADLINE_MS)),
    ]);

    inflight.set(videoId, job);
    try {
        return await job;
    } finally {
        inflight.delete(videoId);
    }
}

module.exports = { fetchRelated };
