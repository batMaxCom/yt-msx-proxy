/**
 * Channel pages for anonymous browsing.
 *
 * Everything here is public channel data, no account involved.
 *
 * Input is forgiving on purpose. A TV remote cannot type a 24 character
 * channel id, so the user will hand us whatever they have:
 *   UCxxxxxxxxxxxxxxxxxxxxxx   a channel id
 *   @handle                    a handle
 *   youtube.com/@handle/videos a full url, tab included
 * /navigation/resolve_url turns anything that is not a channel id into a
 * { browseId, params } pair. It is also how the tab parameter is discovered
 * rather than hardcoded, so "videos", "shorts", "live" and "playlists" keep
 * working when YouTube reorders the opaque blobs.
 *
 * This talks to the WEB client rather than the TVHTML5 one the rest of the
 * project uses. On a TVHTML5 browse every tab answers with the same home
 * shelves and no continuation, so there is no uploads list to page through and
 * no way to reach the tab the user asked for. The WEB client returns a real
 * header, a real per-tab body and a continuation token per tab.
 *
 * Item shapes seen in the wild, all normalised to one video item:
 *   home      sectionListRenderer > itemSectionRenderer > shelfRenderer
 *             > horizontalListRenderer > lockupViewModel
 *   videos    richGridRenderer > richItemRenderer > lockupViewModel
 *   shorts    richGridRenderer > reelShelfRenderer > richItemRenderer
 * The lockup keeps the id in contentId, the label in
 * metadata.lockupMetadataViewModel and the author in metadataRows, where the
 * first row also carries a browseEndpoint we can turn back into a channel id.
 */

const axios = require('axios');
const logger = require('./logger');

const API_KEY = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
const API_ROOT = 'https://www.googleapis.com/youtubei/v1';
const CLIENT = {
    clientName: 'WEB',
    clientVersion: '2.20240726.00.00',
    hl: 'en',
    gl: 'US',
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 48;
const INNERTUBE_TIMEOUT_MS = 12000;
const DEADLINE_MS = 15000;

const cache = new Map();      // "key:tab" -> { channel, ts }
const inflight = new Map();   // "key:tab" -> Promise

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const HANDLE_RE = /^@[\w.-]{3,}$/;

// Canonical tab order for the UI. Anything else the user asks for is passed
// through to resolve_url as a path, so a /featured link still resolves.
const TAB_ORDER = ['home', 'videos', 'shorts', 'live', 'playlists'];
const TAB_PATHS = {
    home: '',
    videos: 'videos',
    shorts: 'shorts',
    live: 'streams',
    streams: 'streams',
    playlists: 'playlists',
    featured: 'featured',
    shows: 'shows',
    podcasts: 'podcasts',
    courses: 'courses',
    posts: 'posts',
};

const URL_RE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i;
const CHANNEL_PATH_RE = /^\/?(?:channel\/|c\/|user\/)?([\w-]+)/;

function isChannelId(v) {
    return typeof v === 'string' && CHANNEL_ID_RE.test(v);
}

function isHandle(v) {
    return typeof v === 'string' && HANDLE_RE.test(v);
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
        const label = textOf(pick(node, ['accessibility', 'accessibilityData', 'label']));
        if (label) return label;
        if (node.text !== undefined) return textOf(node.text);
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

function bestThumb(sources) {
    if (!Array.isArray(sources) || !sources.length) return '';
    let best = sources[0];
    for (const s of sources) {
        if (Number(s && s.width) > Number(best && best.width)) best = s;
    }
    return best && best.url ? String(best.url) : '';
}

/* The duration/live badges live under two different shapes: the web lockup
   nests them in contentImage.thumbnailViewModel.overlays, the TV tile in
   header.tileHeaderRenderer.thumbnailOverlays. Flatten both into one list. */
function overlayBadges(node) {
    const out = [];
    const addAll = list => {
        if (!Array.isArray(list)) return;
        for (const o of list) if (o && typeof o === 'object') out.push(o);
    };
    addAll(pick(node, ['contentImage', 'thumbnailViewModel', 'overlays']));
    addAll(node && node.thumbnailOverlays);
    addAll(node && node.overlays);
    addAll(pick(node, ['header', 'tileHeaderRenderer', 'thumbnailOverlays']));
    addAll(pick(node, ['thumbnail', 'thumbnailOverlays']));
    return out;
}

function durationOf(node) {
    for (const o of overlayBadges(node)) {
        for (const b of pick(o, ['thumbnailBottomOverlayViewModel', 'badges']) || []) {
            const r = b && b.thumbnailBadgeViewModel;
            const t = textOf(r && r.text);
            // the same badge slot also carries the LIVE marker
            if (t && /^\d/.test(t)) return t;
        }
        const r = o && o.thumbnailOverlayTimeStatusRenderer;
        if (r) {
            const t = textOf(r.text);
            if (t) return t;
        }
    }
    return textOf(node && node.lengthText);
}

function looksLive(node) {
    for (const o of overlayBadges(node)) {
        for (const b of pick(o, ['thumbnailBottomOverlayViewModel', 'badges']) || []) {
            const r = b && b.thumbnailBadgeViewModel;
            if (/live|watching/i.test(textOf(r && r.text))) return true;
            if (/live/i.test(String(r && r.badgeStyle || ''))) return true;
        }
        const r = o && o.thumbnailOverlayTimeStatusRenderer;
        if (r && /live/i.test(String(r.style || ''))) return true;
    }
    if (/LIVE|STREAM/i.test(String((node && node.contentType) || ''))) return true;
    const badges = (node && node.badges) || [];
    if (Array.isArray(badges)) {
        for (const b of badges) {
            if (/live/i.test(textOf(pick(b, ['liveBadgeRenderer', 'text']))
                || textOf(pick(b, ['metadataBadgeRenderer', 'label'])))) return true;
        }
    }
    return false;
}

function looksShort(node) {
    if (/SHORT/i.test(String((node && node.contentType) || ''))) return true;
    const url = pick(node, ['rendererContext', 'commandContext', 'onTap', 'innertubeCommand',
        'commandMetadata', 'webCommandMetadata', 'url'])
        || pick(node, ['onSelectCommand', 'commandMetadata', 'webCommandMetadata', 'url'])
        || pick(node, ['navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url'])
        || '';
    return /shorts|reel/i.test(String(url));
}

const VIDEO_ID_RE = /^[\w-]{11}$/;

/* The shorts grid does not use lockupViewModel: it hands back
   shortsLockupViewModel, whose video id is only in reelWatchEndpoint (and in
   the /shorts/<id> url), and whose title lives in overlayMetadata instead of
   a lockup metadata block. Fold it into the same item shape. */
function fromShortsLockup(node) {
    const url = pick(node, ['onTap', 'innertubeCommand', 'commandMetadata', 'webCommandMetadata', 'url']) || '';
    const id = pick(node, ['onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId'])
        || ((String(url).match(/\/shorts\/([\w-]{11})/) || [])[1])
        || '';
    if (!VIDEO_ID_RE.test(String(id))) return null;
    const title = textOf(pick(node, ['overlayMetadata', 'primaryText', 'content']));
    if (!title) return null;
    const secondary = textOf(pick(node, ['overlayMetadata', 'secondaryText', 'content']));
    return {
        id: String(id),
        title,
        author: '',
        authorId: '',
        duration: '',
        // the wrapper is doubly nested here: { thumbnailViewModel:
        // { thumbnailViewModel: { image: ... } } }
        thumb: bestThumb(pick(node, ['thumbnailViewModel', 'thumbnailViewModel', 'image', 'sources']))
            || bestThumb(pick(node, ['thumbnailViewModel', 'image', 'sources'])),
        live: false,
        short: true,
        published: '',
        views: /views?$/i.test(secondary) ? secondary : '',
    };
}

function idOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (VIDEO_ID_RE.test(String(node.videoId || ''))) return node.videoId;
    if (VIDEO_ID_RE.test(String(node.contentId || ''))) return node.contentId;
    const holders = [
        node.onSelectCommand,
        node.navigationEndpoint,
        pick(node, ['onSelectCommand', 'watchEndpoint']),
        pick(node, ['rendererContext', 'commandContext', 'onTap', 'innertubeCommand', 'watchEndpoint']),
        pick(node, ['onTap', 'innertubeCommand', 'watchEndpoint']),
    ];
    for (const h of holders) {
        if (!h || typeof h !== 'object') continue;
        if (VIDEO_ID_RE.test(String(h.videoId || ''))) return h.videoId;
        if (h.watchEndpoint && VIDEO_ID_RE.test(String(h.watchEndpoint.videoId || ''))) {
            return h.watchEndpoint.videoId;
        }
    }
    return null;
}

/* The author is the first metadata row. On a home shelf the first row is the
   author and carries a browseEndpoint we can turn back into a channel id; on
   the uploads grid the same slot is the view count instead. */
function metaRows(node) {
    const rows = pick(node, ['metadata', 'lockupMetadataViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows'])
        || pick(node, ['metadata', 'lockupMetadataViewModel', 'metadataRows'])
        || [];
    if (!Array.isArray(rows)) return [];
    return rows.map(r => {
        const parts = (r && r.metadataParts) || [];
        return parts.map(p => textOf(p && (p.text || p))).filter(Boolean);
    }).filter(parts => parts.length);
}

function authorOf(node) {
    const direct = textOf(node && node.ownerText)
        || textOf(node && node.shortBylineText)
        || textOf(node && node.longBylineText);
    if (direct) return direct.trim();

    const rows = metaRows(node);
    for (const parts of rows) {
        const first = parts[0];
        // a view count or an age is metadata, not an author
        if (/views?$|ago$|^[\d.,]+\s*[KMB]?$/i.test(first)) continue;
        if (first === '\u2022') continue;
        return first.trim();
    }
    return '';
}

function authorIdOf(node) {
    const rows = pick(node, ['metadata', 'lockupMetadataViewModel', 'metadata', 'contentMetadataViewModel', 'metadataRows'])
        || [];
    for (const row of Array.isArray(rows) ? rows : []) {
        for (const part of (row && row.metadataParts) || []) {
            const runs = (part && part.text && part.text.commandRuns) || [];
            for (const run of runs) {
                const bid = pick(run, ['onTap', 'innertubeCommand', 'browseEndpoint', 'browseId'])
                    || pick(run, ['onTap', 'innertubeCommand', 'url']);
                if (isChannelId(bid)) return bid;
            }
        }
    }
    const holders = [node.ownerText, node.shortBylineText, node.longBylineText];
    for (const t of holders) {
        for (const r of (t && t.runs) || []) {
            const bid = pick(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']);
            if (isChannelId(bid)) return bid;
        }
    }
    return '';
}

function viewsAndAge(node) {
    const rows = metaRows(node);
    let views = '';
    let published = textOf(node && node.publishedTimeText);
    for (const parts of rows) {
        for (const p of parts) {
            if (!views && /views?$/i.test(p)) views = p;
            if (!published && /\b(ago|hours?|days?|weeks?|months?|years?|назад|час|ден|недел|месяц)/i.test(p)) {
                published = p;
            }
        }
    }
    return { views, published };
}

function thumbFrom(node) {
    const candidates = [
        pick(node, ['contentImage', 'thumbnailViewModel', 'image', 'sources']),
        pick(node, ['contentImage', 'thumbnailViewModel', 'image', 'sources', 0]),
        pick(node, ['header', 'tileHeaderRenderer', 'thumbnail', 'thumbnails']),
        pick(node, ['thumbnail', 'thumbnails']),
        pick(node, ['richThumbnail', 'content', 'image', 'thumbnails']),
    ];
    for (const c of candidates) {
        const list = Array.isArray(c) ? c : (c && Array.isArray(c.sources) ? c.sources : null);
        const t = bestThumb(list) || (c && c.url ? String(c.url) : '');
        if (t) return t;
    }
    return '';
}

function normalizeItem(node) {
    const id = idOf(node);
    if (!id) return null;
    const { views, published } = viewsAndAge(node);
    return {
        id,
        title: textOf(pick(node, ['metadata', 'lockupMetadataViewModel', 'title']))
            || textOf(pick(node, ['metadata', 'tileMetadataRenderer', 'title']))
            || textOf(node && node.title)
            || textOf(node && node.headline)
            || '',
        author: authorOf(node),
        authorId: authorIdOf(node),
        duration: durationOf(node),
        thumb: thumbFrom(node),
        live: looksLive(node),
        short: looksShort(node),
        published,
        views,
    };
}

function normalizeItems(items) {
    const out = [];
    const seen = {};
    for (const raw of items || []) {
        if (!raw || typeof raw !== 'object') continue;
        // richItemRenderer > content > lockupViewModel is the uploads grid; the
        // home shelves hand us a bare lockup, and the TV client a bare tile
        const inner = raw.richItemRenderer ? (raw.richItemRenderer.content || raw.richItemRenderer) : null;
        const shorts = (inner && inner.shortsLockupViewModel) || raw.shortsLockupViewModel;
        const it = shorts
            ? fromShortsLockup(shorts)
            : normalizeItem((inner && inner.lockupViewModel)
                || (inner && inner.tileRenderer)
                || (inner && inner.gridVideoRenderer)
                || raw.lockupViewModel
                || raw.tileRenderer
                || raw.gridVideoRenderer
                || inner
                || raw);
        if (!it || seen[it.id] || !it.title) continue;
        seen[it.id] = true;
        out.push(it);
    }
    return out;
}

async function innertube(endpoint, body) {
    const url = `${API_ROOT}/${endpoint}?key=${API_KEY}`;
    const resp = await axios.post(url, { context: { client: CLIENT }, ...body }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: INNERTUBE_TIMEOUT_MS,
    });
    return resp.data;
}

/* Turn "@ted", "youtube.com/@ted/videos" or a plain channel id into the
   { browseId, params } pair InnerTube wants. resolve_url is the only endpoint
   that understands handles and urls, and it hands back the tab parameter, so
   those opaque blobs never get hardcoded here. */
async function resolveTarget(key, tab) {
    const raw = String(key || '').trim();
    if (!raw) throw new Error('missing channel');

    if (isChannelId(raw)) {
        if (!tab || tab === 'home') {
            // the home tab wants the params the channel answers with by default
            const data = await innertube('navigation/resolve_url', {
                url: `https://www.youtube.com/channel/${raw}`,
            });
            const ep = pick(data, ['endpoint', 'browseEndpoint']);
            return { browseId: (ep && ep.browseId) || raw, params: ep && ep.params };
        }
        const suffix = TAB_PATHS[tab] || tab;
        const data = await innertube('navigation/resolve_url', {
            url: `https://www.youtube.com/channel/${raw}/${suffix}`,
        });
        const ep = pick(data, ['endpoint', 'browseEndpoint']);
        return {
            browseId: (ep && ep.browseId) || raw,
            params: ep && ep.params,
        };
    }

    let path = raw;
    if (isHandle(path)) {
        path = `https://www.youtube.com/${path}`;
    } else if (URL_RE.test(path)) {
        // ok as is
    } else if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(path)) {
        path = `https://${path}`;
    } else if (path.startsWith('/')) {
        path = `https://www.youtube.com${path}`;
    } else if (path.startsWith('youtube.com/') || path.startsWith('youtu.be/')) {
        path = `https://${path}`;
    } else if (CHANNEL_PATH_RE.test(path)) {
        path = `https://www.youtube.com/${path}`;
    } else {
        throw new Error('not a channel id, handle or url');
    }

    if (tab && tab !== 'home' && !/\/(videos|streams|shorts|playlists|featured|shows|podcasts|courses|posts)\/?$/i.test(path)) {
        const suffix = TAB_PATHS[tab] || tab;
        path = `${path.replace(/\/+$/, '')}/${suffix}`;
    }

    const data = await innertube('navigation/resolve_url', { url: path });
    const ep = pick(data, ['endpoint', 'browseEndpoint']);
    const browseId = ep && ep.browseId;
    if (!browseId) throw new Error('channel not found');
    return { browseId, params: ep && ep.params };
}

/* The header arrives as a pageHeaderViewModel, a channelMetadataRenderer or a
   channelHeaderRenderer depending on the client and the tab. Read all three so
   a layout change costs a fallback instead of a blank panel. */
function readHeader(raw) {
    const out = {
        title: '',
        handle: '',
        subscriberText: '',
        videosText: '',
        description: '',
        avatar: '',
        banner: '',
    };

    const meta = pick(raw, ['metadata', 'channelMetadataRenderer']) || {};
    out.title = textOf(meta.title) || textOf(pick(raw, ['header', 'pageHeaderRenderer', 'pageTitle']));
    out.description = textOf(meta.description) || '';
    out.avatar = bestThumb(pick(meta, ['avatar', 'thumbnails']));
    out.handle = '';
    const vanity = textOf(meta.vanityChannelUrl) || textOf(meta.ownerUrls && meta.ownerUrls[0]);
    if (vanity) {
        const hm = vanity.match(/@[\w.-]+/);
        if (hm) out.handle = hm[0];
    }

    const phv = pick(raw, ['header', 'pageHeaderRenderer', 'content', 'pageHeaderViewModel']);
    if (phv) {
        out.title = out.title || textOf(pick(phv, ['title', 'dynamicTextViewModel', 'text', 'content']));
        out.avatar = out.avatar || bestThumb(pick(phv, ['image', 'decoratedAvatarViewModel', 'avatar',
            'avatarViewModel', 'image', 'sources']));
        out.banner = bestThumb(pick(phv, ['banner', 'imageBannerViewModel', 'image', 'sources']));
        out.description = out.description
            || textOf(pick(phv, ['description', 'descriptionPreviewViewModel', 'description', 'content']));

        const rows = pick(phv, ['metadata', 'contentMetadataViewModel', 'metadataRows']);
        const parts = [];
        for (const row of (Array.isArray(rows) ? rows : [])) {
            for (const p of (row && row.metadataParts) || []) {
                const t = textOf(p && (p.text || p)).trim();
                if (t) parts.push(t);
            }
        }
        const sub = parts.join(' \u2022 ');
        const hm = sub.match(/@[\w.-]+/);
        if (hm) out.handle = hm[0];
        const sm = sub.match(/([\d.,]+\s*[KMB]?\+?\s*(?:subscribers?|подписчиков?))/i);
        if (sm) out.subscriberText = sm[1].trim();
        const vm = sub.match(/([\d.,]+\s*[KMB]?\+?\s*(?:videos?|видео))/i);
        if (vm) out.videosText = vm[1].trim();
    }

    const tv = pick(raw, ['contents', 'tvBrowseRenderer', 'content', 'tvSurfaceContentRenderer', 'header', 'channelHeaderRenderer']);
    if (tv) {
        out.title = out.title || textOf(tv.title);
        out.avatar = out.avatar || bestThumb(pick(tv, ['avatar', 'thumbnails']));
        out.banner = out.banner || bestThumb(pick(tv, ['backgroundImage', 'thumbnails']));
        out.description = out.description
            || textOf(pick(tv, ['selectableDescription', 'selectableTextRenderer', 'compactDescription']));
        const sub = textOf(pick(tv, ['subtitle', 'lineRenderer', 'items'])) || textOf(tv.subtitle);
        const hm = sub.match(/@[^\s\u2022]+/);
        if (hm) out.handle = hm[0];
        const sm = sub.match(/([\d.,]+\s*[KMB]?\+?\s*(?:subscribers?|подписчиков?))/i);
        if (sm) out.subscriberText = sm[1].trim();
        const vm = sub.match(/([\d.,]+\s*[KMB]?\+?\s*(?:videos?|видео))/i);
        if (vm) out.videosText = vm[1].trim();
    }

    return out;
}

/* Read the selected tab's body. The home tab is a list of shelves with real
   titles; videos/shorts/live/playlists are a single richGridRenderer. */
function readTab(raw) {
    const tabs = pick(raw, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']) || [];
    let selected = null;
    let tabList = [];
    for (const t of tabs) {
        const tr = t && t.tabRenderer;
        if (!tr) continue;
        const title = textOf(tr.title);
        if (title) tabList.push({ title, selected: !!tr.selected });
        if (tr.selected) selected = tr;
    }
    // some responses carry the body without marking anything selected
    if (!selected && tabs.length) selected = pick(tabs, [0, 'tabRenderer']);

    const content = (selected && selected.content) || {};
    const shelves = [];

    const grid = content.richGridRenderer;
    if (grid) {
        const items = normalizeItems(grid.contents);
        if (items.length) shelves.push({ title: '', items, grid: true });
    }

    const section = content.sectionListRenderer;
    if (section) {
        for (const sec of section.contents || []) {
            // home: itemSectionRenderer wrapping a shelf
            const inner = (sec && sec.itemSectionRenderer && sec.itemSectionRenderer.contents) || [sec];
            for (const node of inner) {
                if (!node) continue;
                const sh = node.shelfRenderer;
                if (sh) {
                    const list = sh.content || {};
                    const items = list.horizontalListRenderer && list.horizontalListRenderer.items
                        || list.verticalListRenderer && list.verticalListRenderer.items
                        || list.horizontalCardListRenderer && list.horizontalCardListRenderer.items
                        || [];
                    const norm = normalizeItems(items);
                    if (norm.length) {
                        shelves.push({ title: textOf(sh.title).trim(), items: norm });
                    }
                    continue;
                }
                const reel = node.reelShelfRenderer;
                if (reel) {
                    const items = pick(reel, ['content', 'richGridRenderer', 'contents'])
                        || pick(reel, ['items']) || [];
                    const norm = normalizeItems(items);
                    if (norm.length) shelves.push({ title: textOf(reel.title).trim(), items: norm, shorts: true });
                }
            }
        }
    }

    return { shelves, tabs: tabList };
}

function findContinuation(raw) {
    let token = '';
    const walk = node => {
        if (token || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const n of node) walk(n);
            return;
        }
        const t = pick(node, ['continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token'])
            || pick(node, ['nextContinuationData', 'continuation'])
            || pick(node, ['continuationCommand', 'token']);
        if (typeof t === 'string' && t.length > 20) { token = t; return; }
        for (const key of Object.keys(node)) walk(node[key]);
    };
    walk(raw);
    return token || null;
}

function alertOf(raw) {
    for (const a of (raw && raw.alerts) || []) {
        const t = textOf(pick(a, ['alertRenderer', 'text']));
        if (t) return t;
    }
    return '';
}

async function fetchChannelPage(key, tab, continuation) {
    let target;
    if (continuation) {
        // a continuation belongs to a browse we already did, so the tab is
        // implied by the token
        const base = await resolveTarget(key, tab);
        target = { browseId: base.browseId, continuation };
    } else {
        target = await resolveTarget(key, tab);
    }

    const body = target.continuation
        ? { continuation: target.continuation }
        : { browseId: target.browseId, params: target.params };
    const raw = await innertube('browse', body);

    if (continuation) {
        // A continuation has no tabs or header: the items arrive in
        // onResponseReceivedActions > appendContinuationItemsAction.
        const pages = [];
        for (const action of raw.onResponseReceivedActions || []) {
            const items = pick(action, ['appendContinuationItemsAction', 'continuationItems']);
            if (Array.isArray(items)) pages.push(items);
        }
        const norm = normalizeItems(pages.length ? pages.flat() : []);
        const shelves = norm.length ? [{ title: '', items: norm, paged: true }] : [];
        return {
            shelves,
            videoCount: norm.length,
            continuation: findContinuation(raw),
        };
    }

    const header = readHeader(raw);
    const { shelves, tabs } = readTab(raw);
    const alert = alertOf(raw);

    if (!header.title && !shelves.length) {
        const err = new Error(alert || 'channel has no content');
        err.code = alert ? 'not_found' : 'empty';
        throw err;
    }

    return {
        id: (pick(raw, ['metadata', 'channelMetadataRenderer', 'externalId']) || target.browseId),
        requested: String(key || ''),
        tab: tab || 'home',
        title: header.title,
        handle: header.handle,
        avatar: header.avatar,
        banner: header.banner,
        description: header.description,
        subscriberText: header.subscriberText,
        videosText: header.videosText,
        tabs: tabs.length ? tabs : TAB_ORDER.map(t => ({ title: t, selected: t === 'home' })),
        shelves,
        videoCount: shelves.reduce((n, s) => n + s.items.length, 0),
        continuation: findContinuation(raw),
    };
}

async function fetchChannel(key, tab, continuation) {
    const normTab = (tab && TAB_PATHS[tab]) ? tab : 'home';
    const cacheKey = `${String(key || '').trim()}|${normTab}|${continuation || ''}`;
    if (!continuation) {
        const hit = cache.get(cacheKey);
        if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { ...hit.channel, cached: true };
    }
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const building = (async () => {
        const channel = await fetchChannelPage(key, normTab, continuation);
        if (!continuation) {
            if (cache.size > MAX_CACHE) cache.clear();
            cache.set(cacheKey, { channel, ts: Date.now() });
        }
        logger.info('channel', 'channel page built', {
            id: channel.id, title: channel.title, tab: channel.tab,
            videos: channel.videoCount, paged: !!continuation,
        });
        return channel;
    })();

    // The panel is opened by the user mid-playback, so an answer in a few
    // seconds beats a spinner that never resolves.
    const job = Promise.race([
        building,
        new Promise((resolve, reject) => setTimeout(() => {
            logger.warn('channel', 'deadline reached', { key: cacheKey });
            const err = new Error('channel lookup timed out');
            err.code = 'timeout';
            reject(err);
        }, DEADLINE_MS)),
    ]);

    inflight.set(cacheKey, job);
    try {
        return await job;
    } finally {
        inflight.delete(cacheKey);
    }
}

function handleChannelRequest(req, res) {
    const key = req.params.id;
    if (!key) {
        return res.status(400).json({ error: 'channel id, handle or url is required' });
    }
    const continuation = typeof req.query.continuation === 'string' && req.query.continuation.length > 20
        ? req.query.continuation
        : undefined;
    fetchChannel(key, req.query.tab, continuation).then(channel => {
        res.json(channel);
    }).catch(err => {
        const code = err && err.code;
        // InnerTube answers a missing channel with a 404, not an empty body,
        // so translate that instead of reporting an opaque upstream failure
        const upstream = err && (err.response || err.err) || null;
        const upstreamStatus = upstream && upstream.status;
        const notFound = upstreamStatus === 404;
        const status = (code === 'not_found' || notFound) ? 404
            : (code === 'timeout' ? 504 : 502);
        const message = notFound ? 'channel not found' : String((err && err.message) || err);
        logger.warn('channel', 'channel lookup failed', {
            key, tab: req.query.tab, paged: !!continuation,
            code: notFound ? 'not_found' : (code || 'error'),
            upstream: upstreamStatus || null,
            message: logger.truncateStderr(message),
        });
        res.status(status).json({
            error: message,
            code: notFound ? 'not_found' : (code || 'error'),
        });
    });
}

module.exports = { fetchChannel, handleChannelRequest, resolveTarget, normalizeItem };
