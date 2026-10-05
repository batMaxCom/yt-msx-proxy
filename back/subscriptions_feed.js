/*
 * Home page built from the viewer's own subscription list.
 *
 * YouTube's personalised feed is served off browser session cookies this TV never
 * has, so a bearer token alone gets the generic trending board. The subscription
 * list is the one piece of "what this person wants" that is available through a
 * real API, so it becomes the home page: one shelf per subscribed channel with
 * its latest uploads, newest first.
 *
 * Division of labour, because neither half does the other's job:
 *
 *   subscriptions.list (Data API v3) - authoritative. It is the only thing that
 *     knows what someone actually subscribed to, and it works off the OAuth
 *     token we hold rather than a cookie. 1 unit per 50 channels, paginated.
 *
 *   InnerTube browse (per channel)     - the videos. Data API v3 has no "latest
 *     uploads of a channel" method at all: playlistItems.list needs a playlist ID,
 *     and search.list is unordered by upload time and costs 100 units per call.
 *     Asking InnerTube for a channel's Videos tab is what the 2016 YouTube app
 *     itself did, and it costs no quota.
 *
 * Channels are fetched concurrently but with a small pool, because someone with
 * 300 subscriptions must not turn the home page into 300 simultaneous requests
 * against a page that also has to stay responsive.
 */

const axios = require('axios');

const logger = require('./logger');

const SUBSCRIPTIONS_URL = 'https://www.googleapis.com/youtube/v3/subscriptions';
const INNER_KEY = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
const BROWSE_URL = `https://www.googleapis.com/youtubei/v1/browse?key=${INNER_KEY}`;

const CLIENT = {
    clientName: 'TVHTML5',
    clientVersion: '7.20250205.16.00',
    hl: 'en',
    gl: 'US',
};

// A shelf of 6 is what fits on a TV row without the client scrolling.
const VIDEOS_PER_CHANNEL = 6;

// 200 rows is Data API's page maximum and covers far more channels than any
// single person watches; beyond that the feed stops being useful anyway.
const MAX_CHANNELS = 200;

// How many channels are asked for uploads at the same time.
const CONCURRENCY = 4;

// The Videos tab. UgxK is the "Videos" tab; E9gHENhE is its sorted-by-recent
// variant. Both are browse params, and the one below is what the TV app sends for
// a channel page.
const CHANNEL_VIDEOS_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

const CHANNEL_RE = /^UC[\w-]{22}$/;

function textOf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((r) => (r && r.text) || '').join('');
    if (node.content && typeof node.content === 'string') return node.content;
    return '';
}

function thumbnailsFor(videoId, fallback) {
    const base = `https://i.ytimg.com/vi/${videoId}`;
    return [
        { url: `${base}/mqdefault.jpg`, width: 320, height: 180 },
        { url: `${base}/hqdefault.jpg`, width: 480, height: 360 },
        { url: `${base}/maxresdefault.jpg`, width: 1920, height: 1080 },
    ].concat(fallback && fallback.length ? fallback : []);
}

/*
 * The whole subscription list, oldest keyset-free paging until done. A failure
 * part way through returns what was collected so far: a home page with 40 of 300
 * channels beats an error page.
 */
async function listSubscriptions(accessToken, limit) {
    const cap = Math.max(1, Math.min(Number(limit) || MAX_CHANNELS, MAX_CHANNELS));
    const channels = [];
    let pageToken = '';
    let pages = 0;

    while (channels.length < cap && pages < 10) {
        pages += 1;
        const params = {
            part: 'snippet',
            mine: true,
            maxResults: Math.min(50, cap - channels.length),
            order: 'alphabetical',
        };
        if (pageToken) params.pageToken = pageToken;

        let data;
        try {
            const response = await axios.get(SUBSCRIPTIONS_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params,
                timeout: 20000,
            });
            data = response.data || {};
        } catch (err) {
            logger.warn('subscriptions', 'list failed, serving partial list', {
                status: err.response ? err.response.status : undefined,
                collected: channels.length,
                message: logger.truncateStderr(String(err.message || err)),
            });
            break;
        }

        for (const item of data.items || []) {
            const sn = item.snippet || {};
            const id = item.snippet && item.snippet.resourceId ? item.snippet.resourceId.channelId : '';
            const channelId = typeof id === 'string' && CHANNEL_RE.test(id) ? id : '';
            // A row without a usable channel id cannot be browsed, so it is
            // dropped rather than turned into an empty shelf.
            if (!channelId) continue;
            channels.push({
                channel_id: channelId,
                title: String(sn.title || '').slice(0, 160),
                avatar: sn.thumbnails && sn.thumbnails.default ? String(sn.thumbnails.default.url).slice(0, 600) : '',
                subscribed_at: sn.publishedAt || '',
            });
        }

        pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
        if (!pageToken) break;
    }

    return { channels, pages };
}

/*
 * YouTube has moved channel uploads off gridVideoRenderer and onto
 * tileRenderer, which is a different animal: the id is `contentId`, every
 * string lives under `metadata.tileMetadataRenderer`, and the duration is an
 * overlay rather than lengthText. Normalising a tile into the shape
 * videoToGrid already reads keeps a single grid builder instead of teaching it
 * two layouts that will both be renamed eventually.
 */
function tileToVideo(tile) {
    const meta = (tile.metadata && tile.metadata.tileMetadataRenderer) || {};
    const lines = [];
    for (const line of meta.lines || []) {
        const items = (line.lineRenderer && line.lineRenderer.items) || [];
        const parts = [];
        for (const item of items) {
            const li = item.lineItemRenderer || {};
            const badge = li.badge && li.badge.metadataBadgeRenderer;
            const text = textOf(li.text);
            // The 4K badge and the separating bullet carry nothing the row shows.
            if (badge && badge.label) continue;
            if (!text || text === '•') continue;
            parts.push(text);
        }
        lines.push(parts.join(' '));
    }

    const header = (tile.header && tile.header.tileHeaderRenderer) || {};
    let duration = '';
    for (const overlay of header.thumbnailOverlays || []) {
        const status = overlay.thumbnailOverlayTimeStatusRenderer;
        if (status) {
            duration = textOf(status.text).trim();
            if (duration) break;
        }
    }

    // Line 1 is a mix of views and age, so pull each back out by shape instead
    // of trusting a fixed slot - the badges between them come and go.
    const secondary = lines[1] || '';
    const views = (secondary.match(/[\d][\d.,]*\s*[KMB]?\s*views?/i) || [''])[0];
    const published = (secondary.match(/(?:\d[\d,.]*\s*)?[a-z]+\s+ago\b/i) || [''])[0];

    const video = {
        videoId: String(tile.contentId || ''),
        title: meta.title || '',
        shortBylineText: { runs: [{ text: lines[0] || '' }] },
    };
    if (header.thumbnail) video.thumbnail = header.thumbnail;
    if (duration) {
        video.thumbnailOverlays = [{
            thumbnailOverlayTimeStatusRenderer: { text: { simpleText: duration } },
        }];
    }
    if (views) video.shortViewCountText = { simpleText: views };
    if (published) video.publishedTimeText = { simpleText: published };
    return video;
}

/* Pull the upload rows out of whatever shape InnerTube used this time. */
function collectVideoRenderers(data) {
    const found = [];
    const seen = new Set();

    const push = (v) => {
        if (!v || typeof v.videoId !== 'string') return;
        if (!/^[\w-]{11}$/.test(v.videoId)) return;
        if (seen.has(v.videoId)) return;
        seen.add(v.videoId);
        found.push(v);
    };

    const contents = data && data.contents;
    if (!contents) return found;

    // The Videos tab puts a grid of videos under one of these. Rather than
    // hardcoding today's exact chain, walk the tree for the renderer types we
    // know how to read - a structural search survives YouTube renaming a wrapper
    // where an exact path would just start returning empty.
    const walk = (node, depth) => {
        if (!node || depth > 12 || found.length >= VIDEOS_PER_CHANNEL * 3) return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }
        if (typeof node !== 'object') return;

        const r = node.videoRenderer || node.gridVideoRenderer || node.reelItemRenderer;
        if (r) push(r);

        const tile = node.tileRenderer;
        // A channel page also tiles its playlists and Shorts shelves, which have
        // no duration to show, so let contentType decide instead of taking the
        // first tile that happens to carry an id.
        if (tile && tile.contentType === 'TILE_CONTENT_TYPE_VIDEO') {
            push(tileToVideo(tile));
        }

        for (const key of Object.keys(node)) {
            if (key === 'trackingParams') continue;
            walk(node[key], depth + 1);
        }
    };

    walk(contents, 0);
    return found;
}

function videoToGrid(video, channel) {
    const id = video.videoId;
    const title = textOf(video.title).slice(0, 300) || 'Untitled';
    const bylines = [];
    const runs = video.shortBylineText && video.shortBylineText.runs;
    if (Array.isArray(runs)) bylines.push(...runs);
    const shortRuns = video.shortBylineText && video.shortBylineText.simpleText
        ? [{ text: video.shortBylineText.simpleText }]
        : [];
    const bylineRaw = shortRuns.length ? shortRuns[0] : bylines[0];
    const byline = textOf(bylineRaw) || channel.title || '';

    let lengthText = textOf(video.lengthText).trim();
    if (!lengthText && video.thumbnailOverlays) {
        for (const overlay of video.thumbnailOverlays || []) {
            const status = overlay.thumbnailOverlayTimeStatusRenderer;
            if (status) {
                lengthText = textOf(status.text).trim();
                if (lengthText) break;
            }
        }
    }

    // "SHORTS" is not a duration and is worse than no label at all.
    if (/^shorts?$/i.test(lengthText)) lengthText = '';

    const viewCountText = textOf(video.viewCountText) || textOf(video.shortViewCountText) || '';
    const published = textOf(video.publishedTimeText) || textOf(video.publishedTime) || '';

    const renderer = {
        videoId: id,
        thumbnail: { thumbnails: thumbnailsFor(id, video.thumbnail && video.thumbnail.thumbnails) },
        title: { runs: [{ text: title }] },
        shortBylineText: { runs: [{ text: byline }] },
    };
    if (viewCountText) renderer.viewCountText = { runs: [{ text: viewCountText }] };
    if (published) renderer.publishedTimeText = { runs: [{ text: published }] };
    if (lengthText) {
        renderer.lengthText = {
            runs: [{ text: lengthText }],
            accessibility: { accessibilityData: { label: lengthText } },
        };
    }
    if (channel.channel_id) renderer.navigationEndpoint = {
        watchEndpoint: { videoId: id },
        browseEndpoint: { browseId: 'UC' + channel.channel_id.slice(2) },
    };
    return { gridVideoRenderer: renderer };
}

/* Latest uploads for one channel. Never throws: a channel that fails is simply
 * left out, because one dead channel must not cost the viewer the whole page. */
async function fetchChannelVideos(accessToken, channel) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    try {
        const response = await axios.post(BROWSE_URL, {
            context: { client: { ...CLIENT } },
            browseId: channel.channel_id,
            params: CHANNEL_VIDEOS_PARAMS,
        }, { headers, timeout: 20000 });

        if (response.status !== 200) return null;
        const videos = collectVideoRenderers(response.data || {});
        if (!videos.length) return null;
        return {
            channel,
            items: videos.slice(0, VIDEOS_PER_CHANNEL).map((v) => videoToGrid(v, channel)),
        };
    } catch (err) {
        logger.warn('subscriptions', 'channel browse failed, shelf omitted', {
            channel_id: channel.channel_id,
            status: err.response ? err.response.status : undefined,
            message: logger.truncateStderr(String(err.message || err)),
        });
        return null;
    }
}

/*
 * Run tasks with a fixed number in flight. Written by hand rather than with
 * Promise.all over the whole list: 300 subscriptions all requested at once is
 * 300 sockets, which is how the home page takes the process down.
 */
async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;

    const runner = async () => {
        for (;;) {
            const i = next;
            next += 1;
            if (i >= items.length) return;
            try {
                results[i] = await worker(items[i], i);
            } catch (err) {
                results[i] = null;
            }
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(runner());
    await Promise.all(workers);
    return results;
}

function shelfFor(channel, items) {
    return {
        shelfRenderer: {
            title: { runs: [{ text: channel.title || channel.channel_id }], simpleText: channel.title || channel.channel_id },
            endpoint: { browseEndpoint: { browseId: 'UC' + channel.channel_id.slice(2) } },
            content: {
                horizontalListRenderer: {
                    items,
                    collapsedItemCount: items.length,
                    visibleItemCount: items.length,
                },
            },
        },
    };
}

/*
 * The whole home feed. `sub` is only used for logging: the token is passed in by
 * the caller, which has already established whose it is.
 */
async function subscriptionsHome(accessToken, opts) {
    const options = opts || {};
    const maxChannels = Math.max(1, Math.min(Number(options.maxChannels) || 24, MAX_CHANNELS));

    const t0 = Date.now();
    const { channels, pages } = await listSubscriptions(accessToken, maxChannels);

    if (!channels.length) {
        logger.info('subscriptions', 'HOME_EMPTY', { durationMs: Date.now() - t0 });
        return { envelopes: [], channels: 0, shelves: 0, pages };
    }

    const fetched = await pool(channels, CONCURRENCY, (channel) => fetchChannelVideos(accessToken, channel));
    const shelves = [];
    for (const row of fetched) {
        if (row && row.items.length) shelves.push(shelfFor(row.channel, row.items));
    }

    logger.info('subscriptions', 'HOME_BUILT', {
        channels: channels.length,
        shelves: shelves.length,
        pages,
        durationMs: Date.now() - t0,
    });

    return { envelopes: shelves, channels: channels.length, shelves: shelves.length, pages };
}

module.exports = {
    subscriptionsHome,
    listSubscriptions,
    fetchChannelVideos,
    // exported for tests
    collectVideoRenderers,
    tileToVideo,
    videoToGrid,
    shelfFor,
    pool,
    MAX_CHANNELS,
    VIDEOS_PER_CHANNEL,
    CHANNEL_VIDEOS_PARAMS,
};