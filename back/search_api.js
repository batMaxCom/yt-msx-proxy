const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

function lockupToVideoRenderer(lockup) {
    if (!lockup || lockup.contentType && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
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
        const videoRenderer = lockupToVideoRenderer(item.lockupViewModel);
        return videoRenderer ? { videoRenderer } : null;
    }

    if (item.tileRenderer) {
        const videoRenderer = tileToVideoRenderer(item.tileRenderer);
        return videoRenderer ? { videoRenderer } : null;
    }

    // Already legacy-compatible
    if (item.videoRenderer) return item;

    return null;
}

function adaptSearchResponse(data) {
    if (!data || !data.contents || !data.contents.sectionListRenderer) {
        return data;
    }

    const sections = data.contents.sectionListRenderer.contents || [];
    let convertedCount = 0;
    let skippedCount = 0;

    sections.forEach(section => {
        const items = section?.shelfRenderer?.content?.horizontalListRenderer?.items;
        if (!Array.isArray(items)) return;

        // Filter ads and convert modern renderers
        const nextItems = [];
        for (const item of items) {
            if (item && item.adSlotRenderer) {
                skippedCount += 1;
                continue;
            }
            const converted = convertSearchItem(item);
            if (converted) {
                nextItems.push(converted);
                convertedCount += 1;
            } else {
                skippedCount += 1;
            }
        }

        section.shelfRenderer.content.horizontalListRenderer.items = nextItems;

        // Ensure shelf title exists (old UI may expect it)
        if (!section.shelfRenderer.title) {
            const headerText =
                section.shelfRenderer.headerRenderer?.shelfHeaderRenderer?.avatarLockup
                    ?.avatarLockupRenderer?.title?.runs?.[0]?.text || 'Search results';
            section.shelfRenderer.title = { runs: [{ text: headerText }] };
        }
    });

    console.log(
        `[SEARCH ADAPTER] converted=${convertedCount} skipped=${skippedCount} estimatedResults=${data.estimatedResults}`
    );

    return data;
}

async function handleSearchRequest(req, res) {
    const { query, context } = req.body;

    console.log('[REQUEST] POST /api/search');
    console.log('[REQUEST] query:', query);
    console.log('[REQUEST] hasContext:', !!context);

    if (!query) {
        return res.status(400).json({
            error: 'Missing query in the request body.',
            expectedFormat: 'POST JSON body: { "query": "<search_term>", "context": { ... } }',
        });
    }

    // Keep using the same Innertube key already present in the project (TVHTML5 client).
    const apiKey = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';
    const apiUrl = 'https://www.googleapis.com/youtubei/v1/search';

    const postData = {
        query,
        context: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20250205.16.00',
                hl: (context && context.client && context.client.hl) || 'en',
                gl: (context && context.client && context.client.gl) || 'US',
            },
        },
    };

    const authToken = req.headers['authorization']?.split(' ')[1];
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
        console.log('[UPSTREAM] POST', apiUrl);
        const response = await axios.post(apiUrl, postData, {
            headers,
            params: { key: apiKey },
        });

        console.log('[UPSTREAM RESPONSE] status:', response.status);
        console.log('[UPSTREAM RESPONSE] content-type:', response.headers['content-type']);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
            path.join(logsDir, `response-raw-${timestamp}.json`),
            JSON.stringify(response.data, null, 2)
        );

        const processedResponse = adaptSearchResponse(response.data);

        fs.writeFileSync(
            path.join(logsDir, `response-adapted-${timestamp}.json`),
            JSON.stringify(processedResponse, null, 2)
        );

        const itemCount =
            processedResponse?.contents?.sectionListRenderer?.contents?.[0]?.shelfRenderer
                ?.content?.horizontalListRenderer?.items?.length || 0;
        console.log('[RESPONSE] adapted search items:', itemCount);

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

module.exports = { handleSearchRequest, adaptSearchResponse };
