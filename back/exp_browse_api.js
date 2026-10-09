const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');
const historyStore = require('./history_store');
const subscriptionsFeed = require('./subscriptions_feed');

const settingsPath = path.join(__dirname, 'settings.json');

let settings;

if (!fs.existsSync(settingsPath)) {
    const defaultSettings = { 
        serverIp: 'localhost',  
        expBrowse: false        
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
    console.log("Created settings.json with default serverIp = localhost and expBrowse = false.");
    settings = defaultSettings;
} else {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

const serverIp = settings.serverIp || "localhost";

/* ---- identity for the personalized feed ----
   YouTube decides what "For you" means from the account that is making the request:
   watch history, subscriptions, likes, and what has been played on other devices.
   An anonymous request to the personalized feed endpoint quietly degrades into a
   generic trending list, which is exactly the "my preferences are ignored" symptom.

   An OAuth token alone is not enough for the browse feed - InnerTube keys the
   recommendation profile off the browser session cookies. So we accept them from
   three places, in priority order:
     1. an X-YT-Cookie header on the incoming request (a browser signed in to a
        YouTube session that is proxying through us),
     2. settings.json -> "ytCookie" (a pasted cookie header from a signed-in
        browser, the normal setup for a TV that has no YouTube session of its own),
     3. nothing, in which case the feed is simply anonymous and YouTube serves a
        generic list. That is a working state, not an error.
   The cookies are only ever sent to youtubei, never logged. */
function ytCookieHeader(reqCookie) {
    const candidates = [
        reqCookie,
        process.env.YT_COOKIE,
        (() => {
            try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).ytCookie; } catch (e) { return null; }
        })(),
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return '';
}

// Only the cookies that actually identify a session; dropping the rest keeps the
// request small and avoids leaking analytics cookies we have no use for.
const COOKIE_ALLOWLIST = /^(SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID|__Secure-3PSID|__Secure-1PAPISID|__Secure-3PAPISID|__Secure-1PSIDCC|__Secure-3PSIDCC|SIDCC|__Secure-1PSIDTS|__Secure-3PSIDTS|LOGIN_INFO|VISITOR_INFO1_LIVE|PREF|__Secure-1PSIDSS|__Secure-3PSIDSS|SESSDATA)$/;

function filterCookies(cookieHeader) {
    if (!cookieHeader) return '';
    const keep = [];
    for (const part of String(cookieHeader).split(';')) {
        const name = part.split('=')[0].trim();
        if (name && COOKIE_ALLOWLIST.test(name)) keep.push(part.trim());
    }
    return keep.join('; ');
}

/* The real personalized feed. FEtopics is YouTube's topic/trending board - it looks
   like a home screen but has nothing to do with the viewer, which is why the home
   page felt like it was ignoring the account entirely. */
const HOME_BROWSE_ID = 'FEwhat_to_watch';

/* The guide's "History" entry. YouTube serves this one from the account's real
   history, which needs a browser session this TV never has - the response comes
   back generic or empty. The journal in back/history_store.js is the substitute,
   so this id is answered locally instead of going upstream. */
const LOCAL_HISTORY_BROWSE_ID = 'FEhistory';

async function fetchBrowseData(browseId, authHeader = null, reqCookie = null, profileId = null, continuation = null) {
    const apiKey = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
    const apiUrl = `https://www.googleapis.com/youtubei/v1/browse?key=${apiKey}`;

    if (browseId == "home") {
        browseId = HOME_BROWSE_ID;
    }

    if (browseId === LOCAL_HISTORY_BROWSE_ID || browseId === 'FElibrary') {
        return localHistoryBrowse(profileId || 'default');
    }

    const postData = {
        context: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20250205.16.00',
                hl: 'en',
                gl: 'US',
            }
        },
    };

    // InnerTube continuation calls carry only {context, continuation} - no
    // browseId. The 2016 client sends exactly that when the user scrolls a
    // browse page to the end; rejecting it broke infinite scroll with a 400.
    if (continuation) {
        postData.continuation = continuation;
    } else {
        postData.browseId = browseId;
    }

    const headers = {
        'Content-Type': 'application/json'
    };

    if (authHeader) {
        headers['Authorization'] = `Bearer ${authHeader}`;
    }

    const cookie = filterCookies(ytCookieHeader(reqCookie));
    if (cookie) {
        headers['Cookie'] = cookie;
    }

    try {
        const t0 = Date.now();
        logger.info('browse', 'BROWSE_REQUEST', {
            browseId,
            auth: !!authHeader,
            personalized: !!cookie,
            clientName: postData.context.client.clientName,
            clientVersion: postData.context.client.clientVersion,
            url: apiUrl,
        });

        const response = await axios.post(apiUrl, postData, { headers });

        const responseBytes = JSON.stringify(response.data).length;
        logger.info('browse', 'BROWSE_RESPONSE', {
            browseId,
            status: response.status,
            auth: !!authHeader,
            bytes: responseBytes,
            durationMs: Date.now() - t0,
        });

        if (response.status !== 200) {
            console.error('Error: Received non-200 status from YouTube API:', response.status);
            logger.error('browse', 'BROWSE_ERROR', {
                browseId,
                status: response.status,
                reason: 'non-200 upstream status',
            });
            return { error: `YouTube API returned status code ${response.status}` };
        }

        let updatedData;

        if (browseId == "FEsubscriptions") {
            updatedData = convertSubscriptionsToV5(response.data, authHeader);
        } else {
            updatedData = convertToV5(response.data, browseId);
        }

        const summary = sectionSummaries(updatedData);
        logger.info('browse', 'BROWSE_ADAPTED', {
            browseId,
            auth: !!authHeader,
            shelves: summary.shelves,
            cards: summary.cards,
            kinds: summary.kinds.join(','),
        });

        const isHomeId = ["home", "FEtopics", "FEwhat_to_watch"].includes(browseId);

        if (isHomeId && summary.shelves === 0) {
            logger.warn('browse', 'BROWSE_HOME_EMPTY', {
                browseId,
                reason: 'no usable shelves returned',
                kinds: summary.kinds.join(','),
            });

            updatedData = await fallbackHomeShelves();

            const fallbackSummary = sectionSummaries(updatedData);
            logger.info('browse', 'BROWSE_FALLBACK_DONE', {
                browseId,
                shelves: fallbackSummary.shelves,
                cards: fallbackSummary.cards,
            });
        }

        // After the fallback decision, so the local journal still gets its say
        // when upstream home answered with a "personalize your feed" nudge.
        // Home only: a topic row must keep its own curation.
        if (isHomeId) updatedData = await personalizeHome(updatedData, profileId);

        // Full response dumps are debugging scaffolding. Unconditional they write
        // two copies of every browse payload per request, which on a public host
        // fills the disk within days. Off by default; the env var turns them back
        // on for a debugging session.
        if (process.env.YT_DUMP_BROWSE === '1') {
            const logsDir = path.join(__dirname, 'logs');
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir);
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logFilePath = path.join(logsDir, `modded-browse-response-${timestamp}.json`);
            const logFilePath2 = path.join(logsDir, `raw-browse-response-${timestamp}.json`);

            fs.writeFileSync(logFilePath, JSON.stringify(updatedData, null, 2));
            fs.writeFileSync(logFilePath2, JSON.stringify(response.data, null, 2));

            console.log('Updated response saved to log file:', logFilePath);
        }

        return updatedData;
    } catch (error) {
        console.error('Error fetching browse data:', error.message);

        const isHomeId = ["home", "FEtopics", "FEwhat_to_watch"].includes(browseId);

        if (isHomeId) {
            logger.error('browse', 'BROWSE_ERROR_FALLBACK', {
                browseId,
                reason: error.message,
            });

            try {
                const fallbackData = await fallbackHomeShelves();
                const fallbackSummary = sectionSummaries(fallbackData);
                logger.info('browse', 'BROWSE_FALLBACK_DONE', {
                    browseId,
                    shelves: fallbackSummary.shelves,
                    cards: fallbackSummary.cards,
                });
                return await personalizeHome(fallbackData, profileId);
            } catch (fallbackError) {
                logger.error('browse', 'BROWSE_FALLBACK_ERROR', {
                    browseId,
                    reason: fallbackError.message,
                });
            }
        }

        if (error.response) {
            console.error('Error Response:', error.response.data);
            logger.error('browse', 'BROWSE_ERROR', {
                browseId,
                status: error.response.status,
                reason: error.message,
            });
            return { error: `Error from YouTube API: ${error.response.data}` };
        } else if (error.request) {
            console.error('No response received:', error.request);
            logger.error('browse', 'BROWSE_ERROR', {
                browseId,
                reason: 'no response received',
            });
            return { error: 'No response received from YouTube API.' };
        } else {
            console.error('General error:', error.message);
            logger.error('browse', 'BROWSE_ERROR', {
                browseId,
                reason: error.message,
            });
            return { error: `Failed to fetch data from YouTube Browse API: ${error.message}` };
        }
    }
}

const FALLBACK_SHELVES = [
    ['Trending', 'trending videos'],
    ['Popular', 'popular videos'],
    ['Music', 'music videos'],
    ['Gaming', 'gaming videos'],
    ['News', 'breaking news'],
];

function textOf(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (value.simpleText) return value.simpleText;
    if (value.content) return value.content;
    if (Array.isArray(value.runs)) return value.runs.map(r => r.text || '').join('');
    return '';
}

function thumbnailsFor(videoId) {
    return [
        { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90 },
        { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
        { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
        { url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
        { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1920, height: 1080 }
    ];
}

function lockupMetadataParts(lockup) {
    const rows = lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
    let channel = '';
    let views = '';
    let published = '';

    if (rows[0]) {
        channel = textOf(rows[0]?.metadataParts?.[0]?.text) || '';
    }

    if (rows[1]) {
        for (const part of rows[1].metadataParts || []) {
            const t = textOf(part.text);
            if (!t) continue;
            if (/view/i.test(t)) {
                if (!views) views = t;
            } else if (/ago|yesterday|hour|week|day|month|year|недел|час|день|год/i.test(t)) {
                published = t;
            } else if (!views) {
                views = t;
            }
        }
    }

    if (!channel) {
        channel = textOf(lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand?.showMenuCommand?.subtitle) || 'Unknown Channel';
    }

    return { channel, views: views || '0 views', published: published || '' };
}

function lockupLength(lockup) {
    for (const overlay of lockup?.contentImage?.thumbnailViewModel?.overlays || []) {
        for (const badge of overlay?.thumbnailBottomOverlayViewModel?.badges || []) {
            const t = badge?.thumbnailBadgeViewModel?.text;
            if (t) return t;
        }
        const ts = overlay?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText;
        if (ts) return ts;
    }
    return '';
}

function lockupBrowseId(lockup) {
    for (const item of lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand?.showMenuCommand?.menu?.menuRenderer?.items || []) {
        const bid = item?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
        if (bid) return bid;
    }
    return null;
}

function lockupToGridVideoRenderer(lockup) {
    if (!lockup) return null;

    const cmd = lockup?.rendererContext?.commandContext?.onTap?.innertubeCommand;
    const watchVideoId = cmd?.watchEndpoint?.videoId;
    const videoId = watchVideoId || (lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? lockup.contentId : null);
    if (!videoId) return null;

    const title = textOf(lockup?.metadata?.lockupMetadataViewModel?.title) ||
        textOf(lockup?.rendererContext?.commandContext?.onLongPress?.innertubeCommand?.showMenuCommand?.title) ||
        'Untitled';

    const { channel, views, published } = lockupMetadataParts(lockup);
    const lengthText = lockupLength(lockup) || '0:00';
    const browseId = lockupBrowseId(lockup) || `UC_unknown_${videoId}`;

    const watchEndpoint = cmd?.watchEndpoint || { videoId };

    return {
        videoId,
        thumbnail: { thumbnails: thumbnailsFor(videoId) },
        title: { runs: [{ text: title }] },
        publishedTimeText: { runs: [{ text: published }] },
        viewCountText: { runs: [{ text: views }] },
        lengthText: {
            runs: [{ text: lengthText }],
            accessibility: { accessibilityData: { label: lengthText } }
        },
        navigationEndpoint: {
            clickTrackingParams: cmd?.clickTrackingParams || '',
            watchEndpoint: {
                videoId,
                params: watchEndpoint.params || '',
                playerParams: watchEndpoint.playerParams || ''
            }
        },
        shortBylineText: {
            runs: [{
                text: channel,
                navigationEndpoint: {
                    clickTrackingParams: cmd?.clickTrackingParams || '',
                    browseEndpoint: {
                        browseId,
                        canonicalBaseUrl: `/channel/${browseId}`
                    }
                }
            }]
        }
    };
}

function videoRendererToGridVideoRenderer(vr) {
    if (!vr || !vr.videoId) return null;

    const runsText = v => (Array.isArray(v?.runs) ? v.runs.map(r => r.text || '').join('') : (v?.simpleText || ''));

    const titleRuns = Array.isArray(vr.title?.runs) ? vr.title.runs : [{ text: vr.title?.simpleText || 'Untitled' }];
    const bylineRuns = vr.ownerText?.runs || vr.shortBylineText?.runs || [{ text: 'Unknown Channel' }];
    const lengthText = runsText(vr.lengthText) || '0:00';

    return {
        videoId: vr.videoId,
        thumbnail: vr.thumbnail || { thumbnails: thumbnailsFor(vr.videoId) },
        title: titleRuns,
        publishedTimeText: vr.publishedTimeText || { runs: [{ text: runsText(vr.publishedTimeText) }] },
        viewCountText: vr.viewCountText || { runs: [{ text: runsText(vr.viewCountText) }] },
        lengthText: {
            runs: [{ text: lengthText }],
            accessibility: { accessibilityData: { label: lengthText } }
        },
        navigationEndpoint: vr.navigationEndpoint || { watchEndpoint: { videoId: vr.videoId } },
        shortBylineText: { runs: bylineRuns }
    };
}

function searchItemToGridVideoRenderer(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.adSlotRenderer) return null;
    if (item.lockupViewModel) return lockupToGridVideoRenderer(item.lockupViewModel);
    if (item.videoRenderer) return videoRendererToGridVideoRenderer(item.videoRenderer);
    return null;
}

function sectionSummaries(data) {
    const contents = data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents;
    const result = { shelves: 0, cards: 0, kinds: [] };
    if (!Array.isArray(contents)) return result;

    for (const item of contents) {
        if (!item || typeof item !== 'object') continue;
        const kind = Object.keys(item)[0] || '';
        result.kinds.push(kind);

        const renderer = item.shelfRenderer || item.pivotShelfRenderer;
        if (!renderer) continue;
        result.shelves += 1;

        const list = renderer.content?.horizontalListRenderer?.items ||
            renderer.content?.pivotHorizontalListRenderer?.items ||
            renderer.content?.tvSubscriptionsListRenderer?.items ||
            renderer.content?.fakeSubsListRenderer?.items;
        if (Array.isArray(list)) {
            result.cards += list.length;
        }
    }
    return result;
}

async function searchShelves(query) {
    const apiUrl = 'https://www.googleapis.com/youtubei/v1/search?key=AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
    const postData = {
        query,
        context: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20250205.16.00',
                hl: 'en',
                gl: 'US',
            }
        }
    };

    const response = await axios.post(apiUrl, postData, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
    });

    if (response.status !== 200) {
        logger.error('browse', 'BROWSE_FALLBACK_QUERY_ERROR', { query, status: response.status });
        return [];
    }

    const sections = response.data?.contents?.sectionListRenderer?.contents || [];
    const items = [];

    for (const section of sections) {
        const list = section?.shelfRenderer?.content?.horizontalListRenderer?.items;
        if (Array.isArray(list)) items.push(...list);
    }

    const cards = [];
    for (const item of items) {
        const card = searchItemToGridVideoRenderer(item);
        if (card) cards.push({ gridVideoRenderer: card });
        if (cards.length >= 12) break;
    }

    logger.info('browse', 'BROWSE_FALLBACK_QUERY_DONE', {
        query,
        cards: cards.length,
    });

    return cards;
}

/* ---- the local History tab ----
   Same envelope the home feed uses, so the 2016 renderer needs no special case:
   a sectionListRenderer of shelves, each a horizontalListRenderer of
   gridVideoRenderer cards. Records come from the local journal (see
   back/history_store.js) grouped into the same buckets the YouTube history page
   uses. Metadata the journal does not carry is left empty rather than invented -
   /api/video-meta fills the real title once the video is opened. */

function relativeWatchText(watchedAt) {
    const ms = Date.now() - watchedAt;
    if (!(ms >= 0)) return '';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
    const weeks = Math.floor(days / 7);
    if (days < 30) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years > 1 ? 's' : ''} ago`;
}

function clockText(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function watchTimeText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    if (hours > 0) return `Watched ${hours}h ${minutes}m`;
    if (minutes > 0) return `Watched ${minutes} minute${minutes > 1 ? 's' : ''}`;
    return 'Watched';
}

function historyBucket(watchedAt) {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (watchedAt >= startToday) return 'Today';
    if (watchedAt >= startToday - 24 * 60 * 60 * 1000) return 'Yesterday';
    return 'Earlier';
}

function historyCard(rec) {
    const videoId = rec.video_id;
    const title = rec.title || videoId;
    const channel = rec.channel || 'Unknown channel';
    const length = clockText(rec.duration);
    const when = relativeWatchText(rec.watched_at);

    return {
        gridVideoRenderer: {
            videoId,
            thumbnail: { thumbnails: thumbnailsFor(videoId) },
            title: { runs: [{ text: title }] },
            viewCountText: { runs: [{ text: watchTimeText(rec.watch_seconds) }] },
            publishedTimeText: { runs: [{ text: when }] },
            lengthText: {
                runs: [{ text: length }],
                accessibility: { accessibilityData: { label: length } }
            },
            navigationEndpoint: {
                clickTrackingParams: '',
                watchEndpoint: { videoId, params: '', playerParams: '' }
            },
            shortBylineText: {
                runs: [{
                    text: channel,
                    navigationEndpoint: {
                        clickTrackingParams: '',
                        browseEndpoint: rec.channel_id
                            ? { browseId: rec.channel_id, canonicalBaseUrl: `/channel/${rec.channel_id}` }
                            : undefined
                    }
                }]
            }
        }
    };
}

function browseEnvelope(shelves) {
    return {
        contents: {
            tvBrowseRenderer: {
                content: {
                    tvSurfaceContentRenderer: {
                        content: { sectionListRenderer: { contents: shelves } }
                    }
                }
            }
        }
    };
}

async function localHistoryBrowse(profileId) {
    if (!historyStore.ENABLED) return [];
    const items = await historyStore.listHistory(profileId, 300);
    const buckets = new Map();
    for (const rec of items) {
        const key = historyBucket(rec.watched_at);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(historyCard(rec));
    }

    const shelves = [];
    for (const label of ['Today', 'Yesterday', 'Earlier']) {
        const cards = buckets.get(label);
        if (!cards || !cards.length) continue;
        shelves.push({
            shelfRenderer: {
                title: { runs: [{ text: label }] },
                content: {
                    horizontalListRenderer: {
                        items: cards,
                        collapsedItemCount: cards.length,
                        visibleItemCount: cards.length
                    }
                }
            }
        });
    }

    if (shelves.length === 0) {
        logger.info('browse', 'HISTORY_EMPTY', { profileId });
    } else {
        logger.info('browse', 'HISTORY_BROWSE', {
            profileId,
            shelves: shelves.length,
            items: items.length,
        });
    }

    return browseEnvelope(shelves);
}

/* ---- home re-ranking from the local journal ----
   YouTube's own recommendation profile is keyed off browser session cookies that
   this client does not have, so a bearer token alone gets the generic
   "what to watch" list. The journal is the only signal about the viewer we
   actually own, so videos they watched recently are put in front of the feed and
   shelves they watch a lot are moved up. Anything without a journal is left
   untouched, which keeps the anonymous experience byte-identical. */

function channelIdOfCard(card) {
    const g = card?.gridVideoRenderer;
    const byline = g?.shortBylineText?.runs?.[0];
    const browseId = byline?.navigationEndpoint?.browseEndpoint?.browseId;
    if (browseId && /^UC[\w-]{22}$/.test(browseId)) return browseId;
    const title = g?.title?.runs?.[0]?.text || '';
    return title || null;
}

function personalizeHomeShelves(data, affinityChannels, watched) {
    const contents = data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents;
    if (!Array.isArray(contents) || !contents.length) return 0;

    const scoreOf = new Map();
    for (const row of affinityChannels) {
        if (row.channel_id) scoreOf.set(row.channel_id, row.score);
    }

    // A channel name we only know from the journal still counts for re-ordering.
    const nameScore = new Map();
    for (const row of affinityChannels) {
        if (row.channel && !row.channel_id) nameScore.set(row.channel.toLowerCase(), row.score);
    }

    const rank = shelf => {
        let best = 0;
        const items = shelf?.content?.horizontalListRenderer?.items || [];
        for (const card of items) {
            const g = card?.gridVideoRenderer;
            if (!g) continue;
            const byline = (g.shortBylineText?.runs?.[0]?.text || '').toLowerCase();
            let score = scoreOf.get(channelIdOfCard(card)) || 0;
            if (!score && byline) score = nameScore.get(byline) || 0;
            if (score > best) best = score;
        }
        return best;
    };

    // Already in the feed is good: it means YouTube agrees, we do not duplicate.
    const presentIds = new Set();
    for (const shelf of contents) {
        const items = shelf?.content?.horizontalListRenderer?.items || [];
        for (const card of items) {
            const id = card?.gridVideoRenderer?.videoId;
            if (id) presentIds.add(id);
        }
    }

    const extra = watched
        .filter(rec => !presentIds.has(rec.video_id))
        .slice(0, 12)
        .map(historyCard);

    let changed = 0;
    if (extra.length > 0) {
        contents.unshift({
            shelfRenderer: {
                title: { runs: [{ text: 'Because you watched' }] },
                content: {
                    horizontalListRenderer: {
                        items: extra,
                        collapsedItemCount: extra.length,
                        visibleItemCount: extra.length
                    }
                }
            }
        });
        changed += extra.length;
    }

    if (scoreOf.size > 0 || nameScore.size > 0) {
        const ordered = contents
            .map((shelf, i) => ({ shelf, i, score: rank(shelf) }))
            .sort((a, b) => (b.score - a.score) || (a.i - b.i))
            .map(x => x.shelf);
        let moved = 0;
        for (let i = 0; i < ordered.length; i++) {
            if (ordered[i] !== contents[i]) moved += 1;
        }
        if (moved > 0) {
            contents.length = 0;
            contents.push(...ordered);
            changed += moved;
        }
    }

    return changed;
}

/* Applies the journal to a home feed. Without a profile - or with an empty
   journal - the feed is returned exactly as it came in. */
async function personalizeHome(data, profileId) {
    if (!historyStore.ENABLED) return data;
    if (!profileId) return data;
    try {
        const [channels, watched] = await Promise.all([
            historyStore.affinity(profileId, { limit: 20 }),
            historyStore.topVideos(profileId, { limit: 12 }),
        ]);
        if (channels.length === 0 && watched.length === 0) return data;
        const changed = personalizeHomeShelves(data, channels, watched);
        const after = sectionSummaries(data);
        logger.info('browse', 'HOME_PERSONALIZED', {
            profileId,
            channels: channels.length,
            watched: watched.length,
            changed,
            shelves: after.shelves,
            cards: after.cards,
        });
        return data;
    } catch (error) {
        // Personalization is an addition: a failure here must not cost the
        // viewer their feed.
        logger.warn('browse', 'HOME_PERSONALIZE_FAILED', {
            profileId,
            reason: error.message,
        });
        return data;
    }
}

async function fallbackHomeShelves() {
    const results = await Promise.all(FALLBACK_SHELVES.map(async ([label, query]) => {
        try {
            const cards = await searchShelves(query);
            if (cards.length === 0) {
                logger.warn('browse', 'BROWSE_FALLBACK_EMPTY', { query });
                return null;
            }
            return {
                shelfRenderer: {
                    content: {
                        horizontalListRenderer: {
                            items: cards,
                            collapsedItemCount: cards.length,
                            visibleItemCount: cards.length
                        }
                    },
                    title: { runs: [{ text: label }] }
                }
            };
        } catch (error) {
            logger.error('browse', 'BROWSE_FALLBACK_QUERY_ERROR', {
                query,
                reason: error.message,
            });
            return null;
        }
    }));

    const shelves = results.filter(Boolean);

    logger.info('browse', 'BROWSE_FALLBACK_DONE', {
        shelves: shelves.length,
    });

    return {
        contents: {
            tvBrowseRenderer: {
                content: {
                    tvSurfaceContentRenderer: {
                        content: {
                            sectionListRenderer: {
                                contents: shelves
                            }
                        }
                    }
                }
            }
        }
    };
}

async function fetchBrowseContinuationsForSubs(continuationCode, authHeader = null) {
    const apiKey = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
    const apiUrl = `https://www.googleapis.com/youtubei/v1/browse?key=${apiKey}`;

    const postData = {
        context: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20250205.16.00',
                hl: 'en',
                gl: 'US',
            }
        },
        continuation: continuationCode
    };

    const headers = {
        'Content-Type': 'application/json'
    };

    if (authHeader) {
        headers['Authorization'] = `Bearer ${authHeader}`;
    }

    try {
        console.log('Sending continuation request to YouTube Browse API with payload:', postData);

        const response = await axios.post(apiUrl, postData, { headers });

        console.log('Received response from YouTube Browse API:', response.data);

        if (response.status !== 200) {
            console.error('Error: Received non-200 status from YouTube API:', response.status);
            return { error: `YouTube API returned status code ${response.status}` };
        }

        let updatedData;

        // Update the data for subscriptions
        updatedData = response.data;

        // Save logs for the continuation data
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFilePath = path.join(logsDir, `modded-continuation-response-${timestamp}.json`);
        const logFilePath2 = path.join(logsDir, `raw-continuation-response-${timestamp}.json`);

        fs.writeFileSync(logFilePath, JSON.stringify(updatedData, null, 2));
        fs.writeFileSync(logFilePath2, JSON.stringify(response.data, null, 2));

        console.log('Updated continuation response saved to log file:', logFilePath);

        return updatedData;
    } catch (error) {
        console.error('Error fetching continuation data:', error.message);

        if (error.response) {
            console.error('Error Response:', error.response.data);
            return { error: `Error from YouTube API: ${error.response.data}` };
        } else if (error.request) {
            console.error('No response received:', error.request);
            return { error: 'No response received from YouTube API.' };
        } else {
            console.error('General error:', error.message);
            return { error: `Failed to fetch continuation data from YouTube Browse API: ${error.message}` };
        }
    }
}



function convertToV5(data, browseId) {
    console.log('Received Data:', data);

    const sectionListRendererContents = data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents;

    console.log('sectionListRenderer.contents:', sectionListRendererContents);

    
    // the first result on this causes issues

    if (browseId === "home" || browseId === "FEtopics" || browseId === "FElibrary") {
        if (Array.isArray(sectionListRendererContents) && sectionListRendererContents.length > 0) {
            console.log('Removing the first shelfRenderer due to issues...');
            sectionListRendererContents.shift(); 
        }
    }

    if (Array.isArray(sectionListRendererContents)) {
        sectionListRendererContents.forEach((item, index) => {
            console.log(`Processing Item ${index}:`, item);

            try {
                if (item && item.shelfRenderer) {

                    const headerText = item.shelfRenderer.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title?.runs?.[0]?.text || "Trending";

                    item.shelfRenderer.title = item.shelfRenderer.title || {
                        runs: [
                            {
                                text: headerText 
                            }
                        ]
                    };

                    const horizontalList = item.shelfRenderer.content?.horizontalListRenderer?.items;

                    if (Array.isArray(horizontalList)) {
                        horizontalList.forEach((videoItem, videoIndex) => {
                            if (videoItem.tileRenderer) {

                                const videoId = videoItem.tileRenderer.onSelectCommand?.watchEndpoint?.videoId || "";

                                /* Music shelves mix two different things. A music video
                                   is a tileRenderer with a watchEndpoint and is playable.
                                   An album, playlist or mix has only a browseEndpoint
                                   (browseId VL.../RD..., pageType MUSIC_PAGE_TYPE_*),
                                   so videoId comes out empty and the tile we would
                                   build is permanently dead: no thumbnail, no watch
                                   target. Drop those instead of rendering a placeholder. */
                                if (!videoId) {
                                    console.log(`Dropping non-video tile in Item ${index}, Video ${videoIndex}: ${videoItem.tileRenderer.contentType || 'no contentType'}`);
                                    delete videoItem.tileRenderer;
                                    return;
                                }

                                const thumbnail = {
                                    thumbnails: [
                                        { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90 },
                                        { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
                                        { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg?sqp=-oaymwEXCLwDEPoBSFryq4qpAwkIARUAAIhCGAE=&rs=AOn4CLAkg3xb3N0myg-Owh_bJrW1rAXJTg`, width: 444, height: 250 },
                                        { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
                                        { url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
                                        { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1920, height: 1080 }
                                    ]
                                };

const metadata = videoItem.tileRenderer.metadata?.tileMetadataRenderer || {};

                                /* TILE_STYLE_YTLR_CAROUSEL tiles carry no metadata block at all -
                                   their title and byline live in the spotlight that the tile
                                   paints when focused. Reading only `metadata` left every one
                                   of them titled "Untitled Video". */
                                const spotlight = videoItem.tileRenderer.onFocusCommand
                                    ?.commandExecutorCommand?.commands
                                    ?.map(c => c.updateCarouselHeaderCommand?.spotlight?.entityMetadataRenderer)
                                    ?.find(Boolean) || {};
                                const spotlightTexts = (spotlight.bylines || [])
                                    .flatMap(b => (b.lineRenderer?.items || []).map(i => i.lineItemRenderer?.text))
                                    .filter(Boolean);
                                const spotlightPlain = spotlightTexts
                                    .map(t => t.simpleText || t.runs?.map(r => r.text || '').join('') || '')
                                    .filter(Boolean);

                                const titleText = metadata.title?.simpleText
                                    || spotlight.title?.runs?.map(r => r.text || '').join('')
                                    || videoId;

                                const viewCountText = (
                                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('views'))?.lineItemRenderer?.text?.simpleText ||
                                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.accessibility?.accessibilityData?.label?.includes('views'))?.lineItemRenderer?.text?.accessibility?.accessibilityData?.label ||
                                    spotlightPlain.find(t => /views/i.test(t)) ||
                                    "0 views"
                                );
                                
                               
                                const publishedTimeText = (
                                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('ago'))?.lineItemRenderer?.text?.simpleText ||
                                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.accessibility?.accessibilityData?.label?.includes('ago'))?.lineItemRenderer?.text?.accessibility?.accessibilityData?.label ||
                                    "Unknown"
                                );
                                
                                const lengthText = (
                                    videoItem.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText ||
                                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('min'))?.lineItemRenderer?.text?.simpleText ||
                                    "0:00"
                                );
                                
                                let channelName = "Unknown Channel";
                                if (metadata.lines && metadata.lines[0] && metadata.lines[0].lineRenderer && metadata.lines[0].lineRenderer.items) {
                                    const channelInfo = metadata.lines[0].lineRenderer.items.find(item => item.lineItemRenderer?.text?.runs);
                                    
                                    if (channelInfo && channelInfo.lineItemRenderer.text.runs[0]?.text) {
                                        channelName = channelInfo.lineItemRenderer.text.runs[0].text; // Extracting the channel name
                                    }
                                } else {
                                    /* byline 0 is the artist/channel, byline 1 the view
                                       count - take whichever is left. */
                                    const spotByline = spotlightPlain.find(t => !/views|ago|song|episode/i.test(t));
                                    if (spotByline) {
                                        channelName = spotByline;
                                    }
                                }

                                const navigationEndpoint = {
                                    clickTrackingParams: "CCsQlDUYACITCMGSzriaguECFddATAgdB1AO4jILZy10b3BpYy10cnZaD0ZFd2hhdF90b193YXRjaA==",
                                    watchEndpoint: {
                                        videoId: videoId,
                                        params: "6gILT3hvT1NvaG1hYWfqAgt1a3BxYlNYdFZMVeoCC1RjTUJGU0dWaTFj6gILb3IyR1FmZmpuYWvqAgtDLW8wUmdpWFFmQeoCC1VtaFhoVG1QMGEw6gILZm95dWZENTJhb2fqAgtDa3pqRzRoNko0UeoCCzk3dDdYal9pQnYw6gILeHF1bXBYazNCYk3qAgtvSjJINURPVmxKZ-oCC3lhYndacEFmOFFz6gILbVBYRGwtSFJqbGvqAgs5Qk5WRzZNZHFaMPoCCFRyZW5kaW5n"
                                    }
                                };

                                const shortBylineText = {
                                    runs: [
                                        {
                                            text: channelName, 
                                            navigationEndpoint: {
                                                clickTrackingParams: "CCsQlDUYACITCMGSzriaguECFddATAgdB1AO4g==",
                                                browseEndpoint: {
                                                    browseId: "UCUK0HBIBWgM2c4vsPhkYY4w", 
                                                    canonicalBaseUrl: "/user/theslowmoguys"
                                                }
                                            }
                                        }
                                    ]
                                };

                                videoItem.gridVideoRenderer = {
                                    videoId: videoId,
                                    thumbnail: thumbnail,
                                    title: { runs: [{ text: titleText }] },
                                    viewCountText: { runs: [{ text: viewCountText }] },
                                    publishedTimeText: { runs: [{ text: publishedTimeText }] },
                                    lengthText: {
                                        runs: [{ text: lengthText }],
                                        accessibility: { accessibilityData: { label: lengthText } }
                                    },
                                    navigationEndpoint: navigationEndpoint,
                                    shortBylineText: shortBylineText
                                };

                                delete videoItem.gridVideoRenderer.tvhtml5Style;

                                delete videoItem.tileRenderer; 

                                console.log(`Converted tileRenderer to gridVideoRenderer in Item ${index}, Video ${videoIndex}, VideoId: ${videoId}`);
                            }
                        });

                        /* Tiles we dropped above were left key-less, and a shelf whose
                           every tile was an album/playlist would otherwise render as an
                           empty row with a header. Purge both. */
                        item.shelfRenderer.content.horizontalListRenderer.items =
                            horizontalList.filter(v => v && Object.keys(v).length > 0);

                        if (item.shelfRenderer.content.horizontalListRenderer.items.length === 0) {
                            item.shelfRenderer.__drop = true;
                            console.log(`Shelf ${index} (${headerText}) has no playable videos, dropping it`);
                        }
                    }

                    console.log(`Processed shelfRenderer for Item ${index}: ${headerText}`);
                } else {
                    console.warn(`Item ${index} is undefined or malformed.`);
                }
            } catch (err) {
                console.error(`Error processing item ${index}:`, err);
            }
        });

        for (let i = sectionListRendererContents.length - 1; i >= 0; i--) {
            if (sectionListRendererContents[i]?.shelfRenderer?.__drop) {
                sectionListRendererContents[i].shelfRenderer = undefined;
                delete sectionListRendererContents[i].shelfRenderer;
                sectionListRendererContents.splice(i, 1);
            }
        }
    } else {
        console.warn('sectionListRenderer.contents is missing or not an array');
    }

    return data; 
}

async function convertSubscriptionsToV5(data, authHeader) {
    // Client contract (assets/app-prod.js): d.Ia feeds the browse response to
    // findSectionListRenderer, which returns the FIRST sectionListRenderer in
    // the tree — the one inside the selected tab, not a sibling. So the rebuilt
    // channel shelf must be PREPENDED to that tab's section list: d.VI then sees
    // items[0].gridChannelRenderer and swaps horizontalListRenderer for
    // fakeSubsListRenderer ("subs-horizontal-list", round avatars).
    // listSubscriptions returns { channels, pages } — a bare Array.isArray()
    // check on it is always false (regression that silently disabled this rail).
    if (authHeader) {
        try {
            const listed = await subscriptionsFeed.listSubscriptions(authHeader, 40);
            const subscribed = listed && Array.isArray(listed.channels) ? listed.channels : [];
            if (subscribed.length > 0) {
                const subsShelf = {
                    shelfRenderer: {
                        title: { runs: [{ text: "Subscriptions" }] },
                        content: {
                            horizontalListRenderer: {
                                items: subscribed.map(function (ch) {
                                    return {
                                        gridChannelRenderer: {
                                            channelId: ch.channel_id,
                                            title: { runs: [{ text: ch.title || "Unknown Channel" }] },
                                            thumbnail: { thumbnails: [{ url: ch.avatar || "", width: 88, height: 88 }] },
                                            navigationEndpoint: {
                                                clickTrackingParams: "",
                                                browseEndpoint: { browseId: ch.channel_id, params: "" }
                                            }
                                        }
                                    };
                                })
                            }
                        }
                    }
                };

                const tabs = data?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections?.[0]?.tvSecondaryNavSectionRenderer?.tabs;
                const tab = Array.isArray(tabs) && (tabs.find(t => t?.tabRenderer?.selected) || tabs[0]);
                const sectionList = tab?.tabRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer;
                if (sectionList) {
                    sectionList.contents = [subsShelf].concat(Array.isArray(sectionList.contents) ? sectionList.contents : []);
                    return data;
                }
                logger.warn('browse', 'SUBS_SHELF_NO_TAB', { note: 'sectionListRenderer not found, legacy conversion kept' });
            }
        } catch (err) {
            logger.error('browse', 'SUBS_SHELF_REBUILD_FAILED', {
                message: logger.truncateStderr(String((err && err.message) || err)),
            });
        }
    }

    const tabs = data?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections?.[0]?.tvSecondaryNavSectionRenderer?.tabs;

    if (!Array.isArray(tabs) || tabs.length === 0) {
        console.warn('No subscription tabs found.');
        return data;
    }

    const subscriptionTab = tabs.find(tab => tab.tabRenderer?.selected);

    if (!subscriptionTab) {
        console.warn('No selected subscription tab found.');
        return data;
    }

    console.log('Processing Subscription Tab:', subscriptionTab);

    const gridItems = subscriptionTab.tabRenderer?.content?.tvSurfaceContentRenderer?.content?.gridRenderer?.items;

    if (!Array.isArray(gridItems)) {
        console.warn('No grid items found in subscription tab.');
        return data;
    }

    let transformedItems = [];

    gridItems.forEach((videoItem, index) => {
        if (videoItem.tileRenderer) {
            try {
                const videoId = videoItem.tileRenderer.onSelectCommand?.watchEndpoint?.videoId || "";

                const thumbnail = {
                    thumbnails: [
                        { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90 },
                        { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
                        { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
                        { url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
                        { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1920, height: 1080 }
                    ]
                };

                const metadata = videoItem.tileRenderer.metadata?.tileMetadataRenderer || {};
                const titleText = metadata.title?.simpleText || "Untitled Video";
                const viewCountText = metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('views'))?.lineItemRenderer?.text?.simpleText || "0 views";
                const publishedTimeText = metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('ago'))?.lineItemRenderer?.text?.simpleText || "Unknown";

                const lengthText = (
                    videoItem.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText ||
                    metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('min'))?.lineItemRenderer?.text?.simpleText ||
                    "0:00"
                );

                let channelName = "Unknown Channel";
                if (metadata.lines?.[0]?.lineRenderer?.items) {
                    const channelInfo = metadata.lines[0].lineRenderer.items.find(item => item.lineItemRenderer?.text?.runs);
                    if (channelInfo) {
                        channelName = channelInfo.lineItemRenderer.text.runs[0]?.text || channelName;
                    }
                }

                let newVideoItem = {
                    gridVideoRenderer: {
                        videoId: videoId,
                        thumbnail: thumbnail,
                        title: { runs: [{ text: titleText }] },
                        viewCountText: { runs: [{ text: viewCountText }] },
                        publishedTimeText: { runs: [{ text: publishedTimeText }] },
                        lengthText: {
                            runs: [{ text: lengthText }],
                            accessibility: { accessibilityData: { label: lengthText } }
                        },
                        shortBylineText: { runs: [{ text: channelName }] }
                    }
                };

                transformedItems.push(newVideoItem);

                console.log(`Converted tileRenderer to gridVideoRenderer for Subscription Item ${index}, VideoId: ${videoId}`);
            } catch (err) {
                console.error(`Error processing subscription item ${index}:`, err);
            }
        }
    });

    // Extract the first shelf
    const originalContents = data.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer?.contents || [];
    const firstShelf = originalContents.length > 0 ? originalContents[0] : null;
    const remainingShelves = originalContents.slice(1); // Extract all shelves except the first

    // Create new subscription shelf
    const subscriptionShelf = {
        shelfRenderer: {
            content: {
                horizontalListRenderer: {
                    items: transformedItems,
                    trackingParams: "CFEQxjkiEwjkouGq6cSLAxWKm-QGHXTxMlA=", // Example tracking params
                    continuations: [
                        {
                            nextContinuationData: {
                                continuation: "4qmFsgLdAxIIRkV0b3BpY3Ma0AM2Z1BZQWtkMk9FSkhUQzFyYldGMmNIaEpjMFJYYlc5TFlVRnZXbVZZVW1aalIwWnVXbFk1ZW1KdFJuZGpNbWgyWkVZNWVWcFhaSEJpTWpWb1lrSkpabGw2WkVOYWFteHlXVEo0TVZwSGRGZFpNSEI0WlZSc1dWcEZhR3RUYldzelZESjBWMDlXVmtOaGVHOXhRVUZDYkdKblFVSldWazFCUVZaV1ZFRkJSVUZTYTFZellVZEdNRmd6VW5aWU0yUm9aRWRPYjBGQlJVSkNkMEZCUVZGQlFVRlJSVUV5Y3paTU5uZDVSRUZSY1VGQlVXOVJRMmR6UzBOalRFZ3ljMWxLUVhkcVIwRm1TUzFCUVc5T2QybzBTME5PVDFWd04zVXpPVnAyU21SQmIwNTNhalJMUTA5RFREQnlOak54T0RaWFFXZHZUM2RxTkV4RFMzSm9jSE5tUWpSa1R6UXdkMFZMUkhOSkxVTjNhblo1VFVoUWF6VTNVVGhsV1VKRFp6TkRVR2R2U1RNMGNtNXFaVzFXT1ZwSlowVm5SVUZIWjFGSlFVSkJRa2RuVVVsQlFrRkRSMmRSU1VGQ1FVUkhaMUZKUVVKQlJVZG5VVWxCUWtGRw==",
                                clickTrackingParams: "CFIQybcCIhMI5KLhqunEiwMVipvkBh108TJQ"
                            }
                        }
                    ],
                    collapsedItemCount: 3,
                    visibleItemCount: 3
                }
            },
            title: {
                runs: [{ text: "All" }]
            },
        }
    };

    // Create additional shelves for the next 5 tabs (excluding the first tab)
    const additionalShelves = await Promise.all(
        tabs.slice(1, 6).map(async (tab, index) => {
            const tabTitle = tab.tabRenderer?.title || `Tab ${index + 1}`;
            const continuation = tab.tabRenderer?.content?.tvSurfaceContentRenderer?.continuation?.reloadContinuationData?.continuation || "";
            let newItems = [];

            if (continuation) {
                // Fetch continuation data
                const continuationData = await fetchBrowseContinuationsForSubs(continuation, authHeader);
                // Extract the grid items from continuation data
                const gridItems = continuationData?.continuationContents?.tvSurfaceContentContinuation?.content?.gridRenderer?.items || [];
                
                console.log(gridItems)

                newItems = gridItems.map((videoItem, videoIndex) => {
                    if (videoItem.tileRenderer) {
                        try {
                            const videoId = videoItem.tileRenderer.onSelectCommand?.watchEndpoint?.videoId || "";
    
                            const thumbnail = {
                                thumbnails: [
                                    { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90 },
                                    { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 },
                                    { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
                                    { url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`, width: 640, height: 480 },
                                    { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, width: 1920, height: 1080 }
                                ]
                            };
    
                            const metadata = videoItem.tileRenderer.metadata?.tileMetadataRenderer || {};
                            const titleText = metadata.title?.simpleText || "Untitled Video";

                            const viewCountText = metadata.lines[0].lineRenderer.items[0].lineItemRenderer.text.simpleText;
                           
                            console.log("subs views " + viewCountText)

                            const publishedTimeText = metadata.lines[0].lineRenderer.items[2].lineItemRenderer.text.simpleText;

                            console.log("publishedTimeText for subs " + publishedTimeText)

                            const lengthText = (
                                videoItem.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText ||
                                metadata.lines?.[1]?.lineRenderer?.items?.find(item => item.lineItemRenderer?.text?.simpleText?.includes('min'))?.lineItemRenderer?.text?.simpleText ||
                                "0:00"
                            );


                            let channelName = "Unknown Channel";
                            if (videoItem.tileRenderer?.onLongPressCommand?.showMenuCommand?.subtitle?.simpleText) {
                                channelName = videoItem.tileRenderer.onLongPressCommand.showMenuCommand.subtitle.simpleText.split('•')[0].trim() || channelName;
                            }
                
    
                            // Return transformed video item
                            return {
                                gridVideoRenderer: {
                                    videoId: videoId,
                                    thumbnail: thumbnail,
                                    title: { runs: [{ text: titleText }] },
                                    viewCountText: { runs: [{ text: viewCountText }] },
                                    publishedTimeText: { runs: [{ text: publishedTimeText }] },
                                    lengthText: {
                                        runs: [{ text: lengthText }],
                                        accessibility: { accessibilityData: { label: lengthText } }
                                    },
                                    shortBylineText: { runs: [{ text: channelName }] }
                                }
                            };
    
                        } catch (err) {
                            console.error(`Error processing continuation item ${videoIndex}:`, err);
                            return null;  // return null in case of error, we will filter it out later
                        }
                    }
                    return null;
                }).filter(item => item !== null); // Filter out any null values
    
            }
    

            return {
                shelfRenderer: {
                    content: {
                        horizontalListRenderer: {
                            items: newItems,
                            trackingParams: "CFEQxjkiEwjkouGq6cSLAxWKm-QGHXTxMlA=", // Example tracking params
                            continuations: continuation ? [
                                {
                                    nextContinuationData: {
                                        continuation: continuation,
                                        clickTrackingParams: "CFIQybcCIhMI5KLhqunEiwMVipvkBh108TJQ"
                                    }
                                }
                            ] : [],
                            collapsedItemCount: 3,
                            visibleItemCount: 3
                        }
                    },
                    title: {
                        runs: [{ text: tabTitle }]
                    },
                }
            };
        })
    );

    // Construct the final transformed data structure
    const transformedData = {
        contents: {
            tvBrowseRenderer: {
                content: {
                    tvSurfaceContentRenderer: {
                        content: {
                            sectionListRenderer: {
                                contents: [
                                    firstShelf, // Keep the first shelf unchanged
                                    subscriptionShelf, // Add the transformed subscription shelf
                                    ...remainingShelves, // Append the rest of the shelves
                                    ...additionalShelves // Add the additional shelves
                                ].filter(Boolean) // Remove any null values
                            }
                        }
                    }
                }
            }
        }
    };

    return transformedData;
}


module.exports = { fetchBrowseData, browseEnvelope };
