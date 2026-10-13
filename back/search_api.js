const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mixResolver = require('./mix_resolver');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

/**
 * Legacy TV frontend (custom innerTubeVideoParser in app-prod.js) expects
 * flattened videoRenderer fields:
 *   videoId, title, lengthText, views, publishedTime,
 *   shortBylineText.name, browseId.browseId, navigationEndpoint
 * Modern TVHTML5 Innertube search returns lockupViewModel instead of tileRenderer.
 *
 * Channel hits are NOT videos: the client has a real channelTile (innerTubeChannelParser
 * in app-prod.js) that renders a round avatar and navigates to browseEndpoint. Folding a
 * channel into a videoRenderer gave it a watchEndpoint on the UC… id, so OK started the
 * player on a channel id and the thumbnail came out broken (ytimg /vi/ needs 11 chars).
 * Those lockups are converted to compactChannelRenderer instead.
 */

function textRuns(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (value.simpleText) return value.simpleText;
    if (value.content) return value.content;
    if (Array.isArray(value.runs)) {
        return value.runs.map(r => r.text || '').join('');
    }
    return '';
}

function extractBrowseIdFromMenu(lockup) {
    const items =
        lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand
            ?.showMenuCommand?.menu?.menuRenderer?.items || [];

    for (const item of items) {
        const browseId =
            item?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
        if (browseId) return browseId;
    }
    return null;
}

function extractLengthFromLockup(lockup) {
    const overlays =
        lockup?.contentImage?.thumbnailViewModel?.overlays || [];
    for (const overlay of overlays) {
        const badges =
            overlay?.thumbnailBottomOverlayViewModel?.badges ||
            overlay?.thumbnailOverlayTimeStatusRenderer && [overlay] ||
            [];
        for (const badge of badges) {
            const text =
                badge?.thumbnailBadgeViewModel?.text ||
                badge?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText;
            if (text) return text;
        }
    }
    return '';
}

function extractMetadataParts(lockup) {
    const rows =
        lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
            ?.metadataRows || [];

    let channel = '';
    let views = '';
    let publishedTime = '';

    if (rows[0]) {
        channel = textRuns(rows[0]?.metadataParts?.[0]?.text) || '';
    }

    if (rows[1]) {
        const parts = rows[1].metadataParts || [];
        for (const part of parts) {
            const text = textRuns(part.text);
            if (!text) continue;
            if (/view/i.test(text) || /\d/.test(text) && /K|M|B|тыс|млн/i.test(text)) {
                if (!views) views = text;
            } else if (/ago|день|дня|дней|час|недел|месяц|год|yesterday|hour|min/i.test(text)) {
                publishedTime = text;
            } else if (!views) {
                views = text;
            } else if (!publishedTime) {
                publishedTime = text;
            }
        }
    }

    // Fallback: subtitle from long-press menu
    if (!channel) {
        channel = textRuns(
            lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand
                ?.showMenuCommand?.subtitle
        );
    }

    return {
        channel: channel || 'Unknown Channel',
        views: views || '0 views',
        publishedTime: publishedTime || '',
    };
}

function isChannelId(id) {
    return typeof id === 'string' && /^UC[\w-]{22}$/.test(id);
}

/* A real videoId is exactly 11 chars. The modern search endpoint also returns
   auto-generated mixes as videoRenderer with playlist-shaped ids ("RDEM…",
   26 chars). Those are kept: mix_resolver resolves them to a playable radio
   queue, and the tiles below are decorated with the head track's thumbnail
   and a "Mix – …" title so the row looks the way search always looked.
   Anything else that is neither a video id nor a mix is dropped. */
function isVideoId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/* Mix tiles pass through as-is (the client opens them like videos and the
   backend plays the radio head); ids that are neither videos nor mixes are
   junk and get dropped. */
function keepVideoRenderer(videoRenderer) {
    if (!videoRenderer) return false;
    const id = videoRenderer.videoId;
    return isVideoId(id) || mixResolver.isMixId(id);
}

/* Mix tiles come back from the modern endpoint without a thumbnail (i.ytimg
   has nothing for an RD id) and without a title. YouTube search always showed
   the radio as "Mix – <seed track>" with the seed's artwork, so decorate the
   tile that way: resolve the queue once (shared cache with the watch flow)
   under a short budget - a mix without decoration is still clickable, it
   just looks bare until the cache warms. */
async function decorateMixTiles(items) {
    const mixes = [];
    for (const item of items) {
        const r = item && item.videoRenderer;
        if (r && mixResolver.isMixId(r.videoId) && (!r.title || !r.thumbnail)) {
            mixes.push(r);
        }
    }
    if (!mixes.length) return;

    await Promise.all(mixes.map(async r => {
        try {
            const { head } = await Promise.race([
                mixResolver.resolveMix(r.videoId),
                new Promise((_, rej) => setTimeout(() => rej(new Error('mix decorate timed out')), 2500)),
            ]);
            if (!r.title || !r.title.runs || !r.title.runs.length) {
                r.title = { runs: [{ text: head.title ? `Mix – ${head.title}` : 'Mix' }] };
            }
            if (head.thumb) {
                r.thumbnail = { thumbnails: [{ url: absoluteThumbUrl(head.thumb), width: 480, height: 360 }] };
            }
        } catch (err) { /* the row stays undecorated but playable */ }
    }));
}

function absoluteThumbUrl(url) {
    if (typeof url !== 'string') return '';
    // search sometimes hands back protocol-relative "//yt3.ggpht.com/..." URLs, which
    // resolve against our own origin and never reach image proxy
    return url.startsWith('//') ? `https:${url}` : url;
}

function extractChannelAvatar(lockup) {
    const sources = lockup?.contentImage?.thumbnailViewModel?.image?.sources || [];
    if (sources.length) {
        return sources
            .filter(s => s && s.url)
            .map(s => ({
                url: absoluteThumbUrl(s.url),
                width: s.width || 0,
                height: s.height || 0,
            }));
    }
    const menuThumbs =
        lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand
            ?.showMenuCommand?.thumbnail?.thumbnails || [];
    return menuThumbs
        .filter(t => t && t.url)
        .map(t => ({
            url: absoluteThumbUrl(t.url),
            width: t.width || 0,
            height: t.height || 0,
        }));
}

function extractChannelText(lockup) {
    const rows =
        lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
            ?.metadataRows || [];
    const partsOf = row => (row?.metadataParts || []).map(p => textRuns(p.text)).filter(Boolean);

    const handle = partsOf(rows[0]).find(t => t.startsWith('@')) || partsOf(rows[0])[0] || '';
    const rest = [...partsOf(rows[1]), ...partsOf(rows[2])];
    const subscribers =
        rest.find(t => /subscriber|подписчик/i.test(t)) || rest.find(t => /\d/.test(t)) || '';

    return { handle, subscribers };
}

function lockupToChannelRenderer(lockup) {
    const onTap = lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const browseId = onTap?.browseEndpoint?.browseId || lockup?.contentId;
    if (!isChannelId(browseId)) return null;

    // the tile has no thumbnail fallback in the client parser: without it the row
    // renders an empty circle, so drop the hit rather than show a blank one
    const thumbnails = extractChannelAvatar(lockup);
    if (!thumbnails.length) return null;

    const title = textRuns(lockup?.metadata?.lockupMetadataViewModel?.title) || 'Channel';
    const { handle, subscribers } = extractChannelText(lockup);

    return {
        compactChannelRenderer: {
            channelId: browseId,
            title,
            handle,
            subscriberCountText: subscribers,
            thumbnail: { thumbnails },
            navigationEndpoint: {
                clickTrackingParams: onTap?.clickTrackingParams || '',
                browseEndpoint: {
                    browseId,
                    params: onTap?.browseEndpoint?.params || '',
                },
            },
        },
    };
}

function lockupToVideoRenderer(lockup) {
    if (!lockup || (lockup.contentType && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST')) {
        // Still allow if contentId looks like a video id
        if (!lockup?.contentId) return null;
    }

    const watchEndpoint =
        lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint;
    const videoId = lockup.contentId || watchEndpoint?.videoId;
    if (!videoId) return null;

    const title =
        textRuns(lockup?.metadata?.lockupMetadataViewModel?.title) ||
        textRuns(
            lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand
                ?.showMenuCommand?.title
        ) ||
        'Untitled';

    const { channel, views, publishedTime } = extractMetadataParts(lockup);
    const lengthText = extractLengthFromLockup(lockup);
    const browseId = extractBrowseIdFromMenu(lockup) || `UC_unknown_${videoId}`;

    const clickTrackingParams =
        lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand?.clickTrackingParams ||
        '';

    return {
        title,
        description: '',
        shortBylineText: {
            name: channel,
            id: browseId,
        },
        browseId: {
            browseId,
        },
        views,
        publishedTime,
        lengthText: lengthText || '',
        videoId,
        navigationEndpoint: {
            clickTrackingParams,
            watchEndpoint: {
                videoId,
                params: watchEndpoint?.params || '',
                playerParams: watchEndpoint?.playerParams || '',
                watchEndpointSupportedOnesieConfig:
                    watchEndpoint?.watchEndpointSupportedOnesieConfig || {},
            },
        },
    };
}

/* Modern search returns playlists as lockups instead of the legacy
   compactPlaylistRenderer the 2016 client knows; rebuild that renderer so the
   third ("Плейлисты") shelf paints a real playlist tile instead of dropping the
   hit. innerTubePlaylistParser reads playlistId, title, shortBylineText,
   thumbnailRenderer.playlistVideoThumbnailRenderer and videoCount, and can fall
   back to a generated thumbnail/navigation from playlistId alone. */
function lockupToPlaylistRenderer(lockup) {
    if (!lockup) return null;

    const onTap = lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const playlistId =
        lockup.contentId ||
        onTap?.watchEndpoint?.playlistId ||
        onTap?.watchPlaylistEndpoint?.playlistId ||
        '';
    if (typeof playlistId !== 'string' || playlistId.length <= 11) return null;

    const title = textRuns(lockup?.metadata?.lockupMetadataViewModel?.title) || 'Playlist';
    const { channel } = extractMetadataParts(lockup);
    const channelId = extractBrowseIdFromMenu(lockup) || '';

    const thumbnails = thumbSourcesFromLockup(lockup).map(s => ({
        url: absoluteThumbUrl(s.url),
        width: s.width || 0,
        height: s.height || 0,
    }));

    const rows =
        lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
            ?.metadataRows || [];
    const parts = rows
        .flatMap(row => (row?.metadataParts || []).map(p => textRuns(p.text)))
        .filter(Boolean);
    const videoCount = parts.find(t => /video|видео/i.test(t)) || '';

    const renderer = {
        playlistId,
        title: { runs: [{ text: title }] },
        shortBylineText: {
            runs: [
                {
                    text: channel || '',
                    navigationEndpoint: channelId
                        ? { browseEndpoint: { browseId: channelId } }
                        : undefined,
                },
            ],
        },
        navigationEndpoint: {
            clickTrackingParams: onTap?.clickTrackingParams || '',
            watchPlaylistEndpoint: { playlistId },
        },
    };
    if (thumbnails.length) {
        renderer.thumbnailRenderer = {
            playlistVideoThumbnailRenderer: { thumbnail: { thumbnails } },
        };
    }
    if (videoCount) {
        renderer.videoCountShortText = { simpleText: videoCount };
        renderer.thumbnailOverlays = [
            { thumbnailOverlayBottomPanelRenderer: { text: { simpleText: videoCount } } },
        ];
    }

    return { compactPlaylistRenderer: renderer };
}

function tileToVideoRenderer(tileRenderer) {
    if (!tileRenderer) return null;

    const videoId = tileRenderer?.onSelectCommand?.watchEndpoint?.videoId;
    if (!videoId) return null;

    const metadata = tileRenderer.metadata?.tileMetadataRenderer || {};
    const title = metadata.title?.simpleText || 'Untitled';

    const channel =
        metadata?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.runs?.[0]
            ?.text ||
        metadata?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.simpleText ||
        'Unknown Channel';

    const secondLineItems = metadata?.lines?.[1]?.lineRenderer?.items || [];
    let views = '0 views';
    let publishedTime = '';
    for (const item of secondLineItems) {
        const text =
            item?.lineItemRenderer?.text?.simpleText ||
            item?.lineItemRenderer?.text?.runs?.[0]?.text ||
            '';
        if (/view/i.test(text)) views = text;
        else if (/ago/i.test(text)) publishedTime = text;
    }

    const lengthOverlay = (tileRenderer?.header?.tileHeaderRenderer?.thumbnailOverlays || [])
        .find(o => o.thumbnailOverlayTimeStatusRenderer?.text);
    const lengthText =
        lengthOverlay?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '';

    const browseId =
        tileRenderer?.onLongPressCommand?.showMenuCommand?.menu?.menuRenderer?.items
            ?.find(item => item.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint)
            ?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId ||
        `UC_unknown_${videoId}`;

    const watchEndpoint = tileRenderer.onSelectCommand.watchEndpoint;

    return {
        title,
        description: metadata.description?.simpleText || '',
        shortBylineText: { name: channel, id: browseId },
        browseId: { browseId },
        views,
        publishedTime,
        lengthText,
        videoId,
        navigationEndpoint: {
            clickTrackingParams: watchEndpoint.clickTrackingParams || '',
            watchEndpoint: {
                videoId,
                params: watchEndpoint.params || '',
                playerParams: watchEndpoint.playerParams || '',
                watchEndpointSupportedOnesieConfig:
                    watchEndpoint.watchEndpointSupportedOnesieConfig || {},
            },
        },
    };
}

function convertSearchItem(item) {
    if (!item || typeof item !== 'object') return null;

    if (item.lockupViewModel) {
        const lockup = item.lockupViewModel;
        if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL' || isChannelId(lockup.contentId)) {
            return lockupToChannelRenderer(lockup);
        }
        if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
            return lockupToPlaylistRenderer(lockup);
        }
        // everything else (videos, music, shorts) flattens to a videoRenderer the
        // client recognises; mixes keep their RD… id so the backend can resolve
        // them to a playable radio queue
        const videoRenderer = lockupToVideoRenderer(lockup);
        if (!videoRenderer) return null;
        return keepVideoRenderer(videoRenderer) ? { videoRenderer } : null;
    }

    if (item.tileRenderer) {
        const videoRenderer = tileToVideoRenderer(item.tileRenderer);
        if (!videoRenderer) return null;
        return keepVideoRenderer(videoRenderer) ? { videoRenderer } : null;
    }

    // Already legacy-compatible
    if (item.videoRenderer) return keepVideoRenderer(item.videoRenderer) ? item : null;
    if (item.compactChannelRenderer) return item;

    return null;
}

function searchShelf(title, items) {
    return {
        shelfRenderer: {
            title: { runs: [{ text: title }] },
            content: { horizontalListRenderer: { items } },
        },
    };
}

/* TVHTML5 answers a search with ONE flat horizontal list that mixes videos,
   channels, playlists and ads side by side, and the 2016 client paints exactly
   the section it is handed. Regroup every hit into the three shelves the
   patched search view stacks (see the search view patch in app-prod.js):
   videos first, channels next, playlists last. Ads and junk are dropped. */
function adaptSearchResponse(data) {
    if (!data || !data.contents || !data.contents.sectionListRenderer) {
        return Promise.resolve(data);
    }

    const sections = data.contents.sectionListRenderer.contents || [];
    let convertedCount = 0;
    let skippedCount = 0;

    const videos = [];
    const channels = [];
    const others = [];
    const decorated = [];
    const seen = new Set();

    const consider = item => {
        if (!item || typeof item !== 'object') return;
        if (item.adSlotRenderer) {
            skippedCount += 1;
            return;
        }
        const converted = convertSearchItem(item);
        if (!converted) {
            skippedCount += 1;
            return;
        }
        const key = itemKey(converted);
        if (key) {
            if (seen.has(key)) return;
            seen.add(key);
        }
        convertedCount += 1;
        if (converted.compactChannelRenderer) channels.push(converted);
        else if (converted.compactPlaylistRenderer) others.push(converted);
        else videos.push(converted);
        decorated.push(converted);
    };

    for (const section of sections) {
        const items = section?.shelfRenderer?.content?.horizontalListRenderer?.items;
        if (Array.isArray(items)) items.forEach(consider);
        const clusters = section?.clusterShelfRenderer?.clusters;
        if (Array.isArray(clusters)) {
            for (const cluster of clusters) {
                const citems = cluster?.clusterRenderer?.items;
                if (Array.isArray(citems)) citems.forEach(consider);
            }
        }
    }

    const rebuilt = [];
    if (videos.length) rebuilt.push(searchShelf('Видео', videos));
    if (channels.length) rebuilt.push(searchShelf('Каналы', channels));
    if (others.length) rebuilt.push(searchShelf('Плейлисты', others));
    if (rebuilt.length) data.contents.sectionListRenderer.contents = rebuilt;

    console.log(
        `[SEARCH ADAPTER] converted=${convertedCount} skipped=${skippedCount} videos=${videos.length} channels=${channels.length} others=${others.length} estimatedResults=${data.estimatedResults}`
    );

    // Mix tiles (kept above) need head-track artwork and a "Mix – …" title;
    // bounded so a cold mix cache cannot stretch the search answer.
    return decorateMixTiles(decorated).then(() => data).catch(() => data);
}

// Keep using the same Innertube key already present in the project (TVHTML5 client).
const INNERTUBE_API_KEY = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
const INNERTUBE_ROOT = 'https://www.googleapis.com/youtubei/v1';
const INNERTUBE_TIMEOUT_MS = 20000;
// YouTube sometimes takes 15+ seconds on a search. The user is waiting on the
// whole walk, so a slow tail is not worth waiting for: the first page is already
// a usable row, and the next keystroke will ask again.
const INNERTUBE_TAIL_TIMEOUT_MS = 8000;

function innertubeClient(hl, gl) {
    return {
        client: {
            clientName: 'TVHTML5',
            clientVersion: '7.20250205.16.00',
            hl: hl || 'en',
            gl: gl || 'US',
        },
    };
}

async function innertubeRequest(endpoint, body, authToken, timeoutMs) {
    const url = `${INNERTUBE_ROOT}/${endpoint}?key=${INNERTUBE_API_KEY}`;
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    console.log('[UPSTREAM] POST', url);
    const response = await axios.post(url, body, {
        headers,
        timeout: timeoutMs || INNERTUBE_TIMEOUT_MS,
    });
    console.log('[UPSTREAM RESPONSE] status:', response.status);
    console.log('[UPSTREAM RESPONSE] content-type:', response.headers['content-type']);
    return response.data;
}

/* How many pages to fold into the FIRST answer. The client follows the
   continuation itself once the selection reaches the end of the row, so the
   honest default is a single fast page and SEARCH_PAGES exists for a cold or
   hostile upstream where pre-folding three pages (~60 hits) beats waiting for
   the walk. */
const SEARCH_PAGES = Math.max(1, Math.min(6, parseInt(process.env.SEARCH_PAGES, 10) || 1));
/* Upstream normally answers in about a second, but it throttles and then takes
   fifteen. Depth is a nicety, a fast row is not negotiable, so the walk gives up
   on time and the answer goes out with whatever arrived. */
const SEARCH_DEADLINE_MS = Math.max(0, parseInt(process.env.SEARCH_DEADLINE_MS, 10) || 6000);
const SEARCH_CACHE_TTL_MS = 60000;
const SEARCH_CACHE_MAX = 40;
const searchCache = new Map();
const searchInflight = new Map();

function searchListOf(data) {
    return data?.contents?.sectionListRenderer?.contents?.[0]?.shelfRenderer?.content
        ?.horizontalListRenderer;
}

function itemKey(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.videoRenderer) return 'v:' + item.videoRenderer.videoId;
    if (item.compactChannelRenderer) return 'c:' + item.compactChannelRenderer.channelId;
    if (item.compactPlaylistRenderer) return 'p:' + item.compactPlaylistRenderer.playlistId;
    // the first page is still raw here, and its lockups have to hash to the same
    // key the converted ones do or the dedupe below sees an empty set
    if (item.lockupViewModel) {
        const lockup = item.lockupViewModel;
        if (isChannelId(lockup.contentId)) return 'c:' + lockup.contentId;
        if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') return 'p:' + lockup.contentId;
        if (lockup.contentId) return 'v:' + lockup.contentId;
    }
    return '';
}

/* Append the continuation pages into the first answer, so the row the client
   gets is a single long list instead of a seven-tile stub. The tiles it paints
   are a recycled pool - the model behind them holds every item we send and the
   app's own carousel walks it, scrolls it and opens videos from it - so the
   depth has to arrive in this one response. */
function appendPagedItems(data, extraRawItems) {
    const list = searchListOf(data);
    if (!list || !Array.isArray(list.items) || !extraRawItems.length) return 0;

    const seen = new Set();
    for (const item of list.items) {
        const key = itemKey(item);
        if (key) seen.add(key);
    }

    let added = 0;
    for (const raw of extraRawItems) {
        if (!raw || typeof raw !== 'object' || raw.adSlotRenderer) continue;
        const converted = convertSearchItem(raw);
        if (!converted) continue;
        const key = itemKey(converted);
        if (key) {
            if (seen.has(key)) continue;     // pages overlap by a hit or two
            seen.add(key);
        }
        list.items.push(converted);
        added += 1;
    }
    return added;
}

async function fetchDeepSearch(query, client, authToken, maxPages) {
    const first = await innertubeRequest('search', { context: client, query }, authToken);
    // snapshot the untouched first answer: the cache hands this same object out
    // on every later hit and adaptSearchResponse rewrites its items in place
    const rawJson = JSON.stringify(first, null, 2);
    // the token the row can keep walking with, whatever the walk ends up doing
    let nextData = nextContinuationDataOf(first);
    if (maxPages <= 1) return { data: first, added: 0, pages: 1, rawJson, nextData };

    const collected = [];
    let token = nextData?.continuation || null;
    let pages = 1;
    const deadline = Date.now() + SEARCH_DEADLINE_MS;

    while (token && pages < maxPages) {
        if (Date.now() >= deadline) {
            console.log(`[SEARCH PAGE] deadline reached after ${pages} page(s)`);
            break;
        }
        let data;
        try {
            data = await innertubeRequest(
                'search',
                { context: client, continuation: token },
                authToken,
                INNERTUBE_TAIL_TIMEOUT_MS
            );
        } catch (error) {
            // a broken or slow tail page must not cost the user the pages we
            // already have, so stop here and answer with what arrived
            console.error('[SEARCH PAGE ERROR]', error.message);
            break;
        }
        const items = rawItemsOfContinuationResponse(data);
        pages += 1;
        if (items.length) collected.push(...items);
        const next = nextContinuationDataOf(data);
        // the token only advances when the page actually held items, otherwise the
        // next request would come back empty and the row would stall for good
        token = items.length ? next?.continuation || null : null;
        if (token) nextData = next;
    }

    return { data: first, added: appendPagedItems(first, collected), pages, rawJson, nextData };
}

/* What the app asks for once the selection walks off the end of the row: a bare
   { continuation } POST to the same /search, answered with continuationContents.
   Ne.zY reads horizontalListContinuation first, so that is the shape to hand back
   even though upstream wraps the page in a sectionList. */
async function handleSearchContinuationRequest(req, res, client, authToken) {
    const continuation = typeof req.body.continuation === 'string' ? req.body.continuation : '';

    const raw = await innertubeRequest('search', { context: client, continuation }, authToken);

    const seen = new Set();
    const items = [];
    for (const node of rawItemsOfContinuationResponse(raw)) {
        if (!node || typeof node !== 'object' || node.adSlotRenderer) continue;
        const converted = convertSearchItem(node);
        if (!converted) continue;
        // the continuation feeds the video row only; channels live in their own
        // shelf and would pollute the row if appended here
        if (converted.compactChannelRenderer) continue;
        const key = itemKey(converted);
        if (key) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        items.push(converted);
    }

    // mix rows can arrive on page 2+ as well: give them head artwork too
    await decorateMixTiles(items).catch(() => {});

    const nextData = nextContinuationDataOf(raw);
    const payload = {
        continuationContents: {
            horizontalListContinuation: {
                items,
                continuations: items.length && nextData ? [{ nextContinuationData: nextData }] : [],
            },
        },
    };
    if (raw?.trackingParams) payload.trackingParams = raw.trackingParams;

    console.log(
        `[SEARCH CONT] items=${items.length} next=${nextData ? 'yes' : 'no'} for ${continuation.slice(0, 12)}...`
    );

    res.json(payload);
}

async function handleSearchRequest(req, res) {
    const { query, continuation, context } = req.body || {};

    console.log('[REQUEST] POST /api/search');
    console.log('[REQUEST] query:', query);
    console.log('[REQUEST] continuation:', continuation ? 'yes' : 'no');
    console.log('[REQUEST] hasContext:', !!context);

    if (!query && !continuation) {
        return res.status(400).json({
            error: 'Missing query or continuation in the request body.',
            expectedFormat:
                'POST JSON body: { "query": "<search_term>", "context": { ... } } or { "continuation": "<token>" }',
        });
    }

    const client = innertubeClient(
        context && context.client && context.client.hl,
        context && context.client && context.client.gl
    );
    const authToken = req.headers['authorization']?.split(' ')[1];

    // the row asked for more hits: no cache, no walk, just the next page in the
    // shape the collection continuer can push into the model it already has
    if (continuation) {
        try {
            return await handleSearchContinuationRequest(req, res, client, authToken);
        } catch (error) {
            console.error('[SEARCH CONT ERROR]', error.message);
            return res.status(500).json({
                error: 'Failed to fetch continuation from YouTube API.',
                details: error.message,
                upstreamStatus: error.response?.status || null,
            });
        }
    }

    const cacheKey = `${query.toLowerCase()}|${client.client.hl}|${client.client.gl}`;

    try {
        // instant search fires on every keystroke, so the same query arrives
        // repeatedly: one upstream walk, everybody else gets the answer
        const cached = searchCache.get(cacheKey);
        let deep = cached && Date.now() - cached.ts < SEARCH_CACHE_TTL_MS ? cached.page : null;

        if (!deep) {
            if (searchInflight.has(cacheKey)) {
                deep = await searchInflight.get(cacheKey);
            } else {
                const building = fetchDeepSearch(query, client, authToken, SEARCH_PAGES)
                    .then(page => {
                        // Map iterates in insertion order, so this drops the oldest
                        while (searchCache.size >= SEARCH_CACHE_MAX) {
                            searchCache.delete(searchCache.keys().next().value);
                        }
                        searchCache.set(cacheKey, { page, ts: Date.now() });
                        return page;
                    })
                    .finally(() => searchInflight.delete(cacheKey));
                searchInflight.set(cacheKey, building);
                deep = await building;
            }
        } else {
            deep = { ...deep, cached: true };
        }

        const data = deep.data;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
            path.join(logsDir, `response-raw-${timestamp}.json`),
            deep.rawJson
        );

        const processedResponse = await adaptSearchResponse(data);

        // the row can only walk further if the answer hands it a token, and the
        // first page's token is the one that leads to page two
        const continuable = attachSearchContinuation(processedResponse, deep.nextData);

        fs.writeFileSync(
            path.join(logsDir, `response-adapted-${timestamp}.json`),
            JSON.stringify(processedResponse, null, 2)
        );

        const itemCount =
            processedResponse?.contents?.sectionListRenderer?.contents?.[0]?.shelfRenderer
                ?.content?.horizontalListRenderer?.items?.length || 0;
        console.log(
            `[RESPONSE] adapted search items: ${itemCount} (pages=${deep.pages} paged=${deep.added} cached=${!!deep.cached} continuable=${continuable})`
        );

        res.json(processedResponse);
    } catch (error) {
        console.error('[SEARCH ERROR]', error.message);
        if (error.response) {
            console.error('[SEARCH ERROR] upstream status:', error.response.status);
            console.error('[SEARCH ERROR] upstream body:', error.response.data);
        }
        res.status(500).json({
            error: 'Failed to fetch data from YouTube API.',
            details: error.message,
            upstreamStatus: error.response?.status || null,
        });
    }
}

/* ---- paging for the search row ----
   The client asks /search once per query and never follows the continuation
   itself, so the depth of the row has to be resolved server side. The token for
   the very same row does travel inside that first response, and it is served by
   /search as well - /browse answers 400 "Request contains an invalid argument"
   for it. /api/search/page is the manual counterpart of that walk: it takes a
   query OR a continuation and answers with flat items (the shape
   /api/related and /api/channel already use) plus the next token. */

/* The row only keeps growing while the answer carries a continuation: the app's
   collection continuer posts the token back to /search and pushes whatever comes
   into the very same model the tiles are painted from. So hand the token over in
   the shape the client reads - nextContinuationData, with the clickTrackingParams
   that belong to it, because those travel back on the continuation request. */
function nextContinuationDataOf(raw) {
    const list = searchListOf(raw);
    if (list && Array.isArray(list.continuations)) {
        for (const entry of list.continuations) {
            const data = entry?.nextContinuationData;
            if (typeof data?.continuation === 'string' && data.continuation.length > 20) {
                return data;
            }
        }
    }
    if (list && Array.isArray(list.items)) {
        // the row's own tail token is always the right one, so take it first
        for (let i = list.items.length - 1; i >= 0; i -= 1) {
            const endpoint = list.items[i]?.continuationItemRenderer?.continuationEndpoint;
            const token = endpoint?.continuationCommand?.token;
            if (typeof token === 'string' && token.length > 20) {
                return { continuation: token, clickTrackingParams: endpoint.clickTrackingParams };
            }
        }
    }

    /* TV search regularly parks the row's continuation in a second shelf of the
       same answer instead of at the tail of the first one, and that token is the
       one that keeps handing out hits for this very search - so fall back to
       whatever token the answer carries. Skipping it is what leaves the row at
       twenty items for most queries. */
    let found = null;
    const walk = node => {
        if (found || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const n of node) walk(n);
            return;
        }
        const next = node.nextContinuationData;
        const endpoint = node.continuationItemRenderer?.continuationEndpoint || node.continuationEndpoint;
        const direct =
            endpoint?.continuationCommand?.token || next?.continuation || node.continuationCommand?.token;
        if (typeof direct === 'string' && direct.length > 20) {
            found = {
                continuation: direct,
                clickTrackingParams:
                    next?.clickTrackingParams ||
                    endpoint?.clickTrackingParams ||
                    node.clickTrackingParams,
            };
            return;
        }
        for (const key of Object.keys(node)) walk(node[key]);
    };
    walk(raw);
    return found;
}

function findContinuation(raw) {
    return nextContinuationDataOf(raw)?.continuation || null;
}

/* Put the token where the row's model looks for it. The client reads it off the
   itemList itself (contents[..].shelfRenderer.content.horizontalListRenderer) and
   only then sets up its collection continuer, so an answer without it can never
   grow no matter how many pages upstream is willing to hand out. */
function attachSearchContinuation(data, nextData) {
    // after the regroup the video row sits first, but fall back to the first
    // non-empty list so the token is never dropped
    const sections = data?.contents?.sectionListRenderer?.contents || [];
    const videoSection = sections.find(
        s =>
            Array.isArray(s?.shelfRenderer?.content?.horizontalListRenderer?.items) &&
            s.shelfRenderer.content.horizontalListRenderer.items.length
    );
    const list = videoSection?.shelfRenderer?.content?.horizontalListRenderer || searchListOf(data);
    if (!list || !Array.isArray(list.items) || !list.items.length || !nextData) return false;
    list.continuations = [{ nextContinuationData: nextData }];
    return true;
}

function thumbSourcesFromLockup(lockup) {
    const sources = lockup?.contentImage?.thumbnailViewModel?.image?.sources || [];
    if (sources.length) return sources.filter(s => s && s.url);
    const menuThumbs =
        lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand?.showMenuCommand
            ?.thumbnail?.thumbnails || [];
    return menuThumbs.filter(t => t && t.url);
}

// widest last: ytimg serves the big ones, the row only ever paints 303px
function pickThumb(sources) {
    if (!sources || !sources.length) return '';
    let best = sources[0];
    for (const s of sources) {
        if ((s.width || 0) > (best.width || 0)) best = s;
    }
    return absoluteThumbUrl(best.url);
}

function flatItemFromNode(node) {
    if (!node || typeof node !== 'object') return null;

    if (node.lockupViewModel) {
        const lockup = node.lockupViewModel;
        if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_CHANNEL' || isChannelId(lockup.contentId)) {
            return null;   // the client draws those as its own round channel tile
        }
        const id =
            lockup.contentId ||
            lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId;
        if (!id) return null;
        const { channel, views, publishedTime } = extractMetadataParts(lockup);
        const lengthText = extractLengthFromLockup(lockup);
        return {
            id,
            title: textRuns(lockup?.metadata?.lockupMetadataViewModel?.title) || 'Untitled',
            author: channel,
            authorId: extractBrowseIdFromMenu(lockup) || '',
            views,
            published: publishedTime,
            duration: lengthText,
            thumb: pickThumb(thumbSourcesFromLockup(lockup)),
            live: /live/i.test(lengthText) || /^\s*watching/i.test(views),
        };
    }

    if (node.tileRenderer) {
        const renderer = tileToVideoRenderer(node.tileRenderer);
        if (!renderer) return null;
        const sources = node.tileRenderer?.thumbnail?.thumbnails || [];
        return {
            id: renderer.videoId,
            title: renderer.title,
            author: renderer.shortBylineText.name,
            authorId: renderer.shortBylineText.id,
            views: renderer.views,
            published: renderer.publishedTime,
            duration: renderer.lengthText,
            thumb: pickThumb(sources),
            live: /live/i.test(renderer.lengthText || ''),
        };
    }

    if (node.videoRenderer) {
        const v = node.videoRenderer;
        return {
            id: v.videoId,
            title: v.title || '',
            author: v.shortBylineText?.name || '',
            authorId: v.shortBylineText?.id || v.browseId?.browseId || '',
            views: v.views || '',
            published: v.publishedTime || '',
            duration: v.lengthText || '',
            thumb: pickThumb(v.thumbnail?.thumbnails),
            live: /live/i.test(v.lengthText || ''),
        };
    }

    return null;
}

function flatItemsFrom(rawItems) {
    const out = [];
    for (const node of rawItems || []) {
        if (!node || typeof node !== 'object') continue;
        if (node.adSlotRenderer) continue;
        const flat = flatItemFromNode(node);
        if (flat && flat.id) out.push(flat);
    }
    return out;
}

function rawItemsOfSearchResponse(data) {
    const shelves = data?.contents?.sectionListRenderer?.contents || [];
    const pages = [];
    for (const section of shelves) {
        const list =
            section?.shelfRenderer?.content?.horizontalListRenderer?.items ||
            section?.shelfRenderer?.content?.verticalListRenderer?.items;
        if (Array.isArray(list)) pages.push(list);
    }
    return pages.length ? pages.flat() : [];
}

function rawItemsOfContinuationResponse(data) {
    const pages = [];
    // a search continuation comes back from /search itself, shaped like the first
    // answer but under continuationContents
    const sectionList = data?.continuationContents?.sectionListContinuation?.contents || [];
    for (const section of sectionList) {
        const list =
            section?.shelfRenderer?.content?.horizontalListRenderer?.items ||
            section?.shelfRenderer?.content?.verticalListRenderer?.items;
        if (Array.isArray(list)) pages.push(list);
    }
    // browse-style continuations put them into the reload/append actions instead
    for (const action of data?.onResponseReceivedActions || []) {
        const items =
            action?.appendContinuationItemsAction?.continuationItems ||
            action?.reloadContinuationItemsCommand?.continuationItems;
        if (Array.isArray(items)) pages.push(items);
    }
    for (const endpoint of data?.onResponseReceivedEndpoints || []) {
        const items =
            endpoint?.appendContinuationItemsAction?.continuationItems ||
            endpoint?.reloadContinuationItemsCommand?.continuationItems;
        if (Array.isArray(items)) pages.push(items);
    }
    return pages.length ? pages.flat() : [];
}

async function handleSearchPageRequest(req, res) {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const continuation = typeof body.continuation === 'string' ? body.continuation : '';
    const context = body.context || {};
    const authToken = req.headers['authorization']?.split(' ')[1];

    if (!query && !continuation) {
        return res.status(400).json({
            error: 'Missing query or continuation in the request body.',
            expectedFormat:
                'POST JSON body: { "query": "<search_term>" } or { "continuation": "<token>" }',
        });
    }

    const client = innertubeClient(
        context.client && context.client.hl,
        context.client && context.client.gl
    );

    try {
        // Both halves go to /search: TVHTML5 hands its own search continuation back
        // to the same endpoint (/browse answers 400 on it), page two arrives under
        // continuationContents instead of contents.
        const data = await innertubeRequest(
            'search',
            continuation ? { context: client, continuation } : { context: client, query },
            authToken
        );

        const items = flatItemsFrom(
            continuation ? rawItemsOfContinuationResponse(data) : rawItemsOfSearchResponse(data)
        );
        const next = findContinuation(data);

        console.log(
            `[SEARCH PAGE] ${continuation ? 'continuation' : 'query=' + query} items=${items.length} next=${next ? 'yes' : 'no'}`
        );

        res.json({
            ok: true,
            query,
            items,
            continuation: next,
            estimatedResults: data?.estimatedResults || null,
        });
    } catch (error) {
        console.error('[SEARCH PAGE ERROR]', error.message);
        res.status(500).json({
            error: 'Failed to fetch data from YouTube API.',
            details: error.message,
            upstreamStatus: error.response?.status || null,
        });
    }
}

module.exports = { handleSearchRequest, handleSearchPageRequest, adaptSearchResponse, convertSearchItem };
