const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const youtubeDl = require('youtube-dl-exec');
const logger = require('./logger');
const { rewriteString } = require('./image_proxy');

const settingsPath = path.join(__dirname, 'settings.json');
const bundledYtDlpPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'youtube-dl-exec',
    'bin',
    'yt-dlp'
);

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

let bundledYtDlpVersion = 'unknown';
try {
    bundledYtDlpVersion = execFileSync(bundledYtDlpPath, ['--version'], {
        encoding: 'utf8',
    }).trim();
    console.log(`[yt-dlp] binary: ${bundledYtDlpPath}`);
    console.log(`[yt-dlp] version: ${bundledYtDlpVersion}`);
} catch (err) {
    console.warn('[yt-dlp] failed to read bundled binary version:', err.message);
}

const streamMap = new Map();       // streamId -> { url, expiresAt, videoId, itag }
const refreshLocks = new Map();    // streamId -> Promise<entry> (single-flight refresh)
const hlsMap = new Map();          // videoId -> { video:{url,expiresAt}, audio:{url,expiresAt}, expiresAt, videoId }

// ---- streaming proxy mode ----
// /api/stream is a pure relay: the server receives bytes from YouTube and
// proxies them to the client. No full-file downloads, no on-disk caching.

function parseExpireSeconds(url) {
    try {
        const m = /[?&]expire=(\d+)/.exec(String(url));
        if (m) return parseInt(m[1], 10);
    } catch (e) { /* ignore */ }
    return 0;
}

function buildYtDlpFlags() {
    const ytdlpFlags = {
        dumpSingleJson: true,
        noWarnings: true,
        quiet: true,
        noCheckCertificates: true,
        socketTimeout: 20,
        retries: 3,
        extractorArgs: 'youtube:player_client=tv_embedded,android_embedded',
    };
    if (settings.ytDlpCookies && fs.existsSync(settings.ytDlpCookies)) {
        ytdlpFlags.cookies = settings.ytDlpCookies;
    } else if (settings.ytDlpCookiesFromBrowser) {
        ytdlpFlags.cookiesFromBrowser = settings.ytDlpCookiesFromBrowser;
    }
    return ytdlpFlags;
}

async function runYtDlp(videoId) {
    const ytdlpFlags = buildYtDlpFlags();
    const maxAttempts = typeof settings.ytDlpMaxAttempts === 'number' ? settings.ytDlpMaxAttempts : 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await youtubeDl(videoId, ytdlpFlags);
        } catch (err) {
            lastErr = err;
            const message = err.stderr || err.message || String(err);
            logger.warn('video-info', 'yt-dlp attempt failed', {
                video_id: videoId,
                attempt,
                max: maxAttempts,
                message: logger.truncateStderr(message),
            });
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            }
        }
    }
    throw lastErr;
}

// ---- yt-dlp metadata cache: never hammer YouTube with duplicate lookups ----
const gviCache = new Map();      // videoId -> { output, fetchedAt }
const gviInflight = new Map();   // videoId -> Promise (single-flight)
const GVI_TTL_MS = 20 * 60 * 1000; // 20 min

async function getVideoInfoCached(videoId) {
    const hit = gviCache.get(videoId);
    if (hit && Date.now() - hit.fetchedAt < GVI_TTL_MS) {
        return hit.output;
    }
    if (gviInflight.has(videoId)) return gviInflight.get(videoId);
    const p = runYtDlp(videoId)
        .then(output => {
            gviCache.set(videoId, { output, fetchedAt: Date.now() });
            gviInflight.delete(videoId);
            return output;
        })
        .catch(err => {
            gviInflight.delete(videoId);
            throw err;
        });
    gviInflight.set(videoId, p);
    return p;
}

async function refreshStreamUrl(streamId) {
    if (refreshLocks.has(streamId)) return refreshLocks.get(streamId);
    const promise = (async () => {
        const entry = streamMap.get(streamId);
        if (!entry) throw new Error('Stream entry missing');
        const output = await getVideoInfoCached(entry.videoId);
        storeStreamUrls(entry.videoId, output.formats || []);
        const fresh = streamMap.get(streamId);
        if (!fresh) throw new Error('Format disappeared after refresh');
        return fresh;
    })();
    refreshLocks.set(streamId, promise);
    try {
        return await promise;
    } finally {
        refreshLocks.delete(streamId);
    }
}

function isTransientStreamError(err) {
    if (!err) return false;
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'EPIPE', 'ECONNREFUSED'];
    if (transientCodes.includes(err.code)) return true;
    const message = String(err.message || '');
    return /socket disconnected|secure TLS|sow outage|Client network socket|maximum redirects/i.test(message);
}

function storeStreamUrls(videoId, formats) {
    if (!Array.isArray(formats)) return;
    formats.forEach(format => {
        if (format.url && format.format_id) {
            const expireSec = parseExpireSeconds(format.url);
            const expiresAt = expireSec ? expireSec * 1000 : Date.now() + 6 * 60 * 60 * 1000;
            streamMap.set(`${videoId}_${format.format_id}`, {
                url: format.url,
                expiresAt,
                videoId,
                itag: String(format.format_id),
            });
        }
    });
}

function proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, attemptsLeft, delayMs, allowUrlRefresh) {
    if (req.destroyed || req.aborted || res.writableEnded) return;
    if (allowUrlRefresh === undefined) allowUrlRefresh = true;

    const entry = streamMap.get(streamId);
    const entryMeta = entry
        ? { video_id: entry.videoId, itag: entry.itag }
        : { video_id: streamId, itag: undefined };
    const rangeHeader = req.headers['range'] || '';

    axios({
        method: 'GET',
        url: targetUrl,
        headers: proxyHeaders,
        responseType: 'stream',
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: typeof settings.streamHeaderTimeoutMs === 'number' ? settings.streamHeaderTimeoutMs : 20000,
    })
        .then(upstream => {
            const status = upstream.status;

            if (allowUrlRefresh && (status === 403 || status === 416)) {
                try { upstream.data && upstream.data.destroy(); } catch (e) { /* ignore */ }
                logger.warn('stream', 'STREAM_URL_EXPIRED', {
                    event: 'STREAM_URL_EXPIRED',
                    video_id: entryMeta.video_id,
                    itag: entryMeta.itag,
                    range: rangeHeader,
                    status,
                    reason: 'upstream_' + status,
                });
                refreshStreamUrl(streamId)
                    .then(fresh => {
                        logger.info('stream', 'STREAM_URL_REFRESH', {
                            event: 'STREAM_URL_REFRESH',
                            video_id: fresh.videoId,
                            itag: fresh.itag,
                            status: 'ok',
                        });
                        logger.info('stream', 'STREAM_RETRY', {
                            event: 'STREAM_RETRY',
                            video_id: fresh.videoId,
                            itag: fresh.itag,
                            range: rangeHeader,
                            retry: true,
                            attempts_left: attemptsLeft,
                        });
                        proxyStreamWithRetry(req, res, streamId, fresh.url, proxyHeaders, attemptsLeft, delayMs, false);
                    })
                    .catch(err => {
                        logger.error('stream', 'STREAM_URL_REFRESH', {
                            event: 'STREAM_URL_REFRESH',
                            video_id: entryMeta.video_id,
                            itag: entryMeta.itag,
                            status: 'fail',
                            reason: String(err.message || err).slice(0, 200),
                        });
                        logger.error('stream', 'STREAM_FAILED', {
                            event: 'STREAM_FAILED',
                            video_id: entryMeta.video_id,
                            itag: entryMeta.itag,
                            range: rangeHeader,
                            status,
                            retry: false,
                            reason: 'url_refresh_failed',
                        });
                        if (!res.headersSent && !res.writableEnded) {
                            res.status(status === 416 ? 416 : 502)
                                .send(status === 416 ? 'Range not satisfiable' : 'Stream URL refresh failed');
                        }
                    });
                return;
            }

            res.status(status);

            const headersToCopy = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
            headersToCopy.forEach(header => {
                if (upstream.headers[header]) {
                    res.setHeader(header, upstream.headers[header]);
                }
            });

            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (!res.getHeader('Accept-Ranges')) {
                res.setHeader('Accept-Ranges', 'bytes');
            }

            if (status >= 300) {
                logger.warn('stream', status === 403 || status === 416 ? 'STREAM_FAILED' : 'Upstream non-2xx', {
                    event: 'STREAM_FAILED',
                    stream_id: streamId,
                    video_id: entryMeta.video_id,
                    itag: entryMeta.itag,
                    upstream_status: status,
                    range: rangeHeader,
                    retry: false,
                    reason: 'upstream_final_' + status,
                    upstream_content_type: upstream.headers['content-type'] || '',
                    upstream_content_length: upstream.headers['content-length'] || '',
                    allowed_refresh: allowUrlRefresh,
                });
            }

            upstream.data.on('error', err => {
                logger.error('stream', 'Stream pipe error', { stream_id: streamId, message: err.message });
                console.error(`Error streaming ${streamId}:`, err.message);
                res.destroy(err);
            });

            req.on('close', () => {
                if (!res.writableEnded) {
                    upstream.data.destroy();
                }
            });

            // Body idle watchdog: a streamed response that goes quiet for too
            // long (typical behind a flaky VPN) is treated as transient. If we
            // have not committed headers yet, retry upstream; otherwise break
            // the client connection so the player's own bounded XHR timeout
            // (and retry) can take over instead of hanging forever.
            let idleTimer = null;
            const idleTimeoutMs = typeof settings.streamIdleTimeoutMs === 'number' ? settings.streamIdleTimeoutMs : 15000;
            const armIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs);
            };
            const onIdleTimeout = () => {
                clearTimeout(idleTimer);
                logger.warn('stream', 'STREAM_RETRY', {
                    event: 'STREAM_RETRY',
                    stream_id: streamId,
                    video_id: entryMeta.video_id,
                    itag: entryMeta.itag,
                    range: rangeHeader,
                    retry: true,
                    attempts_left: Math.max(0, attemptsLeft - 1),
                    reason: 'upstream_idle_timeout',
                });
                try { upstream.data.destroy(); } catch (e) { /* ignore */ }
                if (!res.headersSent && attemptsLeft > 1) {
                    proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, attemptsLeft - 1, delayMs, allowUrlRefresh);
                } else {
                    try { req.destroy(); } catch (e) { /* ignore */ }
                    try { if (!res.writableEnded) res.destroy(); } catch (e) { /* ignore */ }
                }
            };
            upstream.data.on('data', armIdle);
            armIdle();

            upstream.data.pipe(res);
        })
        .catch(err => {
            if (isTransientStreamError(err) && attemptsLeft > 1) {
                logger.warn('stream', 'STREAM_RETRY', {
                    event: 'STREAM_RETRY',
                    stream_id: streamId,
                    video_id: entryMeta.video_id,
                    itag: entryMeta.itag,
                    range: rangeHeader,
                    retry: true,
                    attempts_left: attemptsLeft - 1,
                    reason: typeof err.code === 'string' ? err.code : 'transient',
                });
                setTimeout(() => {
                    proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, attemptsLeft - 1, delayMs, allowUrlRefresh);
                }, delayMs);
                return;
            }
            logger.error('stream', 'STREAM_ERROR', {
                event: 'STREAM_ERROR',
                stream_id: streamId,
                video_id: entryMeta.video_id,
                itag: entryMeta.itag,
                range: rangeHeader,
                message: String(err.message).slice(0, 400),
                code: err.code || undefined,
            });
            logger.error('stream', 'STREAM_FAILED', {
                event: 'STREAM_FAILED',
                stream_id: streamId,
                video_id: entryMeta.video_id,
                itag: entryMeta.itag,
                range: rangeHeader,
                status: null,
                retry: false,
                reason: String(err.code || err.message || 'error').slice(0, 80),
            });
            console.error(`Stream proxy error for ${streamId}:`, err.message);
            if (!res.headersSent && !res.writableEnded) {
                res.status(502).send('Failed to proxy stream');
            }
        });
}

function proxyStreamWithError(res, status, message, meta) {
    if (!res.headersSent && !res.writableEnded) {
        res.status(status).send(message);
    }
    if (meta) {
        logger.error('stream', 'STREAM_FAILED', {
            event: 'STREAM_FAILED',
            status,
            retry: false,
            reason: message,
            video_id: meta.video_id,
            itag: meta.itag,
            range: meta.range,
        });
    }
}

function vintLength(firstByte) {
    if (firstByte === 0) return -1;
    let len = 1;
    let mask = 0x80;
    while ((firstByte & mask) === 0) {
        mask >>= 1;
        len++;
    }
    return len;
}

function lastClusterStartOnOrBefore(buf, scanEnd) {
    let found = -1;
    const limit = Math.min(scanEnd, buf.length - 8);
    for (let i = 0; i <= limit; i++) {
        if (buf[i] !== 0x1f || buf[i + 1] !== 0x43 || buf[i + 2] !== 0xb6 || buf[i + 3] !== 0x75) continue;
        // YouTube's muxer often encodes the Cluster size as a 3-byte VINT
        // (marker at bit 5), so only the "non-zero VINT marker" part of the
        // byte is guaranteed. WebM's spec requires the Cluster's first child
        // to be the Timestamp element (0xE7) — validate it to reject
        // coincidental byte patterns inside media data.
        const vlen = vintLength(buf[i + 4]);
        if (vlen < 1) continue;
        const tsByte = i + 4 + vlen;
        if (tsByte >= buf.length) continue;
        if (buf[tsByte] !== 0xe7) continue;
        found = i;
    }
    return found;
}

const SEEK_ALIGN_WINDOW = 2 * 1024 * 1024;

function collectRangeBuf(targetUrl, proxyHeaders, start, end) {
    return axios({
        method: 'GET',
        url: targetUrl,
        headers: Object.assign({}, proxyHeaders, { Range: `bytes=${start}-${end}` }),
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 60000,
    });
}

async function proxyAlignedSeek(req, res, streamId, targetUrl, proxyHeaders, rangeHeader) {
    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!rangeMatch) {
        return proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, 3, 700);
    }

    let rangeStart = parseInt(rangeMatch[1], 10);
    let rangeEnd = rangeMatch[2] === '' ? rangeStart + SEEK_ALIGN_WINDOW - 1 : parseInt(rangeMatch[2], 10);

    if (rangeStart > rangeEnd) {
        return proxyStreamWithError(res, 416, 'Range not satisfiable');
    }

    // Range starting at the beginning of the file is already cluster-aligned
    // (it begins with the init segment), so just stream it through.
    if (rangeStart === 0) {
        return proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, 3, 700);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const upstreamStart = Math.max(0, rangeStart - SEEK_ALIGN_WINDOW);

        let up;
        try {
            up = await collectRangeBuf(targetUrl, proxyHeaders, upstreamStart, rangeEnd);
        } catch (err) {
            if (isTransientStreamError(err) && attempt < maxAttempts) {
                logger.warn('stream', 'Aligned seek upstream network error, retrying', {
                    stream_id: streamId,
                    message: String(err.message).slice(0, 300),
                    attempts_left: maxAttempts - attempt,
                });
                await new Promise(resolve => setTimeout(resolve, 700 * attempt));
                continue;
            }
            logger.error('stream', 'Aligned seek upstream error', {
                stream_id: streamId,
                message: String(err.message).slice(0, 300),
                code: err.code || undefined,
            });
            return proxyStreamWithError(res, 502, 'Failed to proxy stream');
        }

        const upstreamContentType = String(up.headers['content-type'] || 'video/webm').toLowerCase();
        const upstreamTotalMatch = /^bytes\s+(\d+)-(\d+)\/(\d+)/.exec(String(up.headers['content-range'] || ''));
        const fileTotal = upstreamTotalMatch ? parseInt(upstreamTotalMatch[3], 10) : null;

        if (up.status === 416) {
            const totalMatch = /\/(\d+)\s*$/.exec(String(up.headers['content-range'] || ''));
            if (totalMatch && attempt < maxAttempts) {
                const fileTotal416 = parseInt(totalMatch[1], 10);
                rangeEnd = Math.max(rangeStart, fileTotal416 - 1);
                await new Promise(resolve => setTimeout(resolve, 300));
                continue;
            }
            return proxyStreamWithError(res, 416, 'Range not satisfiable');
        }

        const raw = Buffer.isBuffer(up.data) ? up.data : Buffer.from(up.data || []);

        // YouTube throttling frequently answers range requests with a short
        // HTML/plain error page instead of the video bytes. Treat that as a
        // transient failure so the retry loop can recover.
        if (/text\/html|text\/plain|application\/json/.test(upstreamContentType) && raw.length < 65536 && attempt < maxAttempts) {
            logger.warn('stream', 'Upstream returned error page in aligned seek, retrying', {
                stream_id: streamId,
                upstream_status: up.status,
                content_type: upstreamContentType,
                bytes: raw.length,
            });
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            continue;
        }

        let effectiveStart = rangeStart;
        const inBufferOffset = rangeStart - upstreamStart;
        if (inBufferOffset > 0 && inBufferOffset < raw.length) {
            const scanEnd = inBufferOffset;
            const clusterIndex = lastClusterStartOnOrBefore(raw, scanEnd);
            if (clusterIndex >= 0) {
                effectiveStart = upstreamStart + clusterIndex;
            }
        }

        // A valid WebM mid-file region always contains Cluster elements within
        // a 2 MB window (YouTube clusters are ~200-500 KB apart). When YouTube
        // throttling answers with a garbage body that still claims
        // video/webm, the scan finds nothing — treat that as transient and
        // retry instead of poisoning the MSE decoder with corrupt bytes.
        if (effectiveStart === rangeStart && attempt < maxAttempts) {
            logger.warn('stream', 'No cluster boundary found in seek window, retrying', {
                stream_id: streamId,
                range: rangeHeader,
                bytes: raw.length,
                upstream_status: up.status,
            });
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            continue;
        }

        const payloadEnd = Math.min(rangeEnd, fileTotal !== null ? fileTotal - 1 : rangeEnd);
        const payloadStartOffset = effectiveStart - upstreamStart;
        if (payloadEnd < effectiveStart || payloadStartOffset >= raw.length) {
            return proxyStreamWithError(res, 416, 'Range not satisfiable');
        }
        const payload = raw.slice(payloadStartOffset, payloadEnd - upstreamStart + 1);
        if (payload.length === 0) {
            return proxyStreamWithError(res, 416, 'Range not satisfiable');
        }

        const servedEnd = effectiveStart + payload.length - 1;
        res.status(206);
        res.setHeader('Content-Type', upstreamContentType);
        res.setHeader('Content-Length', payload.length);
        res.setHeader('Content-Range', `bytes ${effectiveStart}-${servedEnd}/${fileTotal !== null ? fileTotal : servedEnd + 1}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        logger.info('stream', 'Aligned seek range served', {
            stream_id: streamId,
            range: rangeHeader,
            served_from: effectiveStart,
            served_to: servedEnd,
            cluster_adjusted: effectiveStart !== rangeStart,
        });
        res.send(payload);
        return;
    }

    return proxyStreamWithError(res, 502, 'Failed to proxy stream');
}

function handleStreamRequest(req, res) {
    const streamId = req.params.stream_id;
    const entry = streamMap.get(streamId);
    const rangeHeader = req.headers['range'] || '';

    if (!entry) {
        logger.error('stream', 'STREAM_FAILED', {
            event: 'STREAM_FAILED',
            stream_id: streamId,
            status: 404,
            retry: false,
            reason: 'stream_not_cached',
            range: rangeHeader,
        });
        console.error(`Stream not found for id: ${streamId}`);
        return res.status(404).send('Stream not found');
    }

    logger.info('stream', 'STREAM_REQUEST', {
        event: 'STREAM_REQUEST',
        video_id: entry.videoId,
        itag: entry.itag,
        range: rangeHeader || '',
        has_range: !!rangeHeader,
        seek: req.query.seek === '1' ? '1' : undefined,
    });

    if (rangeHeader) {
        logger.info('stream', 'STREAM_RANGE', {
            event: 'STREAM_RANGE',
            video_id: entry.videoId,
            itag: entry.itag,
            range: rangeHeader,
            seek: req.query.seek === '1' ? '1' : undefined,
        });
    }

    const proxyHeaders = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; 2016YouTubeTV/1.0)',
    };

    if (rangeHeader) {
        proxyHeaders['Range'] = rangeHeader;
    }

    // Pure relay: always proxy live from YouTube. No disk cache.
    const startProxy = (targetUrl, allowRefresh) => {
        // Cluster-aligned middleware: when the player requests a mid-file byte
        // range right after a seek (&seek=1), serve the bytes starting at the
        // nearest WebM cluster boundary at/before the requested offset so the
        // raw data is parseable when appended to MSE (arbitrary offsets corrupt
        // the decoder and trigger "An error occurred").
        if (req.query.seek === '1' && rangeHeader) {
            proxyAlignedSeek(req, res, streamId, targetUrl, proxyHeaders, rangeHeader)
                .catch(err => {
                    logger.error('stream', 'Aligned seek handler error', {
                        stream_id: streamId,
                        message: String(err.message).slice(0, 300),
                    });
                    proxyStreamWithError(res, 502, 'Failed to proxy stream', {
                        video_id: entry.videoId,
                        itag: entry.itag,
                        range: rangeHeader,
                    });
                });
            return;
        }

        proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, 3, 700, allowRefresh);
    };

    if (Date.now() >= entry.expiresAt - 60000) {
        logger.warn('stream', 'STREAM_URL_EXPIRED', {
            event: 'STREAM_URL_EXPIRED',
            video_id: entry.videoId,
            itag: entry.itag,
            range: rangeHeader,
            status: null,
            reason: 'locally_expired',
        });
        refreshStreamUrl(streamId)
            .then(fresh => {
                logger.info('stream', 'STREAM_URL_REFRESH', {
                    event: 'STREAM_URL_REFRESH',
                    video_id: fresh.videoId,
                    itag: fresh.itag,
                    status: 'ok',
                });
                startProxy(fresh.url, true);
            })
            .catch(err => {
                logger.warn('stream', 'STREAM_URL_REFRESH', {
                    event: 'STREAM_URL_REFRESH',
                    video_id: entry.videoId,
                    itag: entry.itag,
                    status: 'fail',
                    reason: String(err.message || err).slice(0, 200),
                });
                // Fall back to the stale URL; a 403/416 upstream will still be
                // caught by the reactive refresh inside proxyStreamWithRetry.
                startProxy(entry.url, true);
            });
        return;
    }

    startProxy(entry.url, true);
}


function handleGetVideoInfo(req, res) {
    const videoId = req.query.video_id;
    const prettyPrint = req.query.prettyprint === 'true';
    const unurlencode = req.query.unurlencode === 'true';

    // Disable WebM progressive workaround (unused; kept for parity with old rows).
    const disableWebM = false;
    if (!videoId) {
        return res.status(400).send('Video ID is required');
    }

    console.log('[REQUEST] GET /get_video_info');
    console.log('[REQUEST] video_id:', videoId);
    console.log('[yt-dlp] using version:', bundledYtDlpVersion);
    console.log('[UPSTREAM] yt-dlp', videoId, buildYtDlpFlags());

    getVideoInfoCached(videoId)
        .then(output => {
            //console.log('Video Info:', output);

            const logsDir = path.join(__dirname, 'logs');
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir);
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logFilePath = path.join(logsDir, `video-info-${timestamp}.json`);

            fs.writeFileSync(logFilePath, JSON.stringify(output, null, 2));

            const videoIdFromOutput = output.id;
            const videoTitle = output.title;
            const videoDuration = output.duration;

            console.log('Video ID:', videoIdFromOutput);
            console.log('Video Title:', videoTitle);
            console.log('Video Duration:', videoDuration);

            logger.info('video-info', 'yt-dlp metadata ok', {
                video_id: videoIdFromOutput,
                title: videoTitle,
                duration: videoDuration,
                formats_total: output.formats ? output.formats.length : 0,
            });

            const adaptiveFmts = [];
            const fmtListArr = [];
            const urlEncodedFmtStreamMapArr = [];

            if (output.formats && Array.isArray(output.formats)) {
                output.formats.forEach(format => {
                    if (format.format_id && /^sb/.test(format.format_id)) return;

                    // HLS (m3u8) formats are handled separately via /api/hls proxy
                    // (synthesized master playlist). Keep them out of /api/stream adaptive_fmts.
                    if (format.protocol === 'm3u8_native' && format.url && format.url.includes('m3u8')) {
                        return;
                    }

                    if (disableWebM && (format.ext === 'webm' || format.acodec === 'vp9' || format.acodec === 'vp8')) return;

                    if (format.url && format.format_id) {
                        let mimeType;
                        if (format.vcodec && format.vcodec !== "none" && format.acodec && format.acodec !== "none") {
                            mimeType = `video/${format.ext || 'mp4'}; codecs="${format.vcodec},${format.acodec}"`;
                        } else if (format.vcodec && format.vcodec !== "none") {
                            mimeType = `video/${format.ext || 'mp4'}; codecs="${format.vcodec}"`;
                        } else if (format.acodec && format.acodec !== "none") {
                            mimeType = `audio/${format.ext || 'mp4'}; codecs="${format.acodec}"`;
                        } else {
                            mimeType = `application/octet-stream`;
                        }

                        if (mimeType === 'application/octet-stream') {
                            logger.warn('video-info', 'Skipping unplayable format', {
                                video_id: videoIdFromOutput,
                                format_id: format.format_id,
                                mime: 'application/octet-stream',
                            });
                            console.log('Skipping unplayable format:', format.format_id);
                            return;
                        }

                        storeStreamUrls(videoIdFromOutput, [format]);

                        const baseMime = mimeType.split(';')[0].trim();
                        const streamUrl = `/api/stream/${videoIdFromOutput}_${format.format_id}?mime=${encodeURIComponent(baseMime)}&itag=${format.format_id}&size=${format.width ? format.width + 'x' + format.height : '0x0'}`;

                        if (format.format_id !== '18') {

                            if (format.url.includes('manifest')) {
                                logger.warn('video-info', 'Skipping manifest URL', {
                                    video_id: videoIdFromOutput,
                                    format_id: format.format_id,
                                });
                                console.log('Skipping manifest URL:', format.url);
                                return;
                            }

                            const urlParams = new URLSearchParams();
                            urlParams.append('url', streamUrl);
                            urlParams.append('itag', format.format_id);
                            urlParams.append('clen', format.filesize || 'unknown');
                            urlParams.append('lmt', format.lastModified || 'unknown');
                            urlParams.append('dur', format.duration || 'unknown');
                            urlParams.append('fps', format.fps || 'unknown');
                            urlParams.append('size', `${format.width || 0}x${format.height || 0}`);
                            urlParams.append('bitrate', format.tbr || 'unknown');
                            urlParams.append('type', mimeType);

                            adaptiveFmts.push(urlParams.toString());

                            const width = format.width || "unknown";
                            const height = format.height || "unknown";

                            if (width === "unknown" || height === "unknown") {
                                logger.warn('video-info', 'Skipping format with unknown width or height', {
                                    video_id: videoIdFromOutput,
                                    format_id: format.format_id,
                                });
                                console.log('Skipping format with unknown width or height:', format);
                                return;
                            }

                            if (format.format_id) {
                                const fmtString = `${format.format_id}/${width}x${height}`;
                                fmtListArr.push(fmtString);
                            } else {
                                logger.warn('video-info', 'Skipping format with missing format_id', {
                                    video_id: videoIdFromOutput,
                                    format_id: format.format_id,
                                });
                                console.log('Skipping format with missing format_id:', format);
                            }
                        }

                        if (format.format_id === '18') {
                            const fmtString = `itag=${format.itag}&type=${mimeType}&url=${encodeURIComponent(streamUrl)}&quality=${format.quality || 'unknown'}`;
                            urlEncodedFmtStreamMapArr.push(fmtString);

                            const progParams = new URLSearchParams();
                            progParams.append('url', streamUrl);
                            progParams.append('itag', format.format_id);
                            progParams.append('clen', format.filesize || 'unknown');
                            progParams.append('lmt', format.lastModified || 'unknown');
                            progParams.append('dur', format.duration || 'unknown');
                            progParams.append('fps', format.fps || 'unknown');
                            progParams.append('size', `${format.width || 0}x${format.height || 0}`);
                            progParams.append('bitrate', format.tbr || 'unknown');
                            progParams.append('type', mimeType);
                            adaptiveFmts.push(progParams.toString());
                        }
                    } else {
                        logger.warn('video-info', 'Skipping format with missing URL or format_id', {
                            video_id: videoIdFromOutput,
                            format_id: format.format_id,
                        });
                        console.log('Skipping format with missing URL or format_id:', format);
                    }
                });
            }

            logger.info('video-info', 'Formats ready', {
                video_id: videoIdFromOutput,
                adaptive_count: adaptiveFmts.length,
                progressive_count: urlEncodedFmtStreamMapArr.length,
                fmt_list_count: fmtListArr.length,
            });

            let hlsUrl = '';
            const hlsEntry = buildHlsEntry(videoIdFromOutput, output.formats);
            if (hlsEntry) {
                hlsMap.set(videoIdFromOutput, hlsEntry);
                hlsUrl = hlsPathFor(videoIdFromOutput, req);
                const hlsParams = new URLSearchParams();
                hlsParams.append('url', hlsUrl);
                hlsParams.append('mime', 'application/x-mpegURL');
                hlsParams.append('itag', 'hls');
                hlsParams.append('clen', 'unknown');
                hlsParams.append('lmt', 'unknown');
                hlsParams.append('dur', videoDuration || 'unknown');
                hlsParams.append('fps', 'unknown');
                hlsParams.append('size', '640x360');
                hlsParams.append('bitrate', 'unknown');
                hlsParams.append('type', 'application/x-mpegURL');
                adaptiveFmts.push(hlsParams.toString());
                logger.info('video-info', 'HLS available', {
                    video_id: videoIdFromOutput,
                    hls: hlsUrl,
                });
            } else {
                logger.warn('video-info', 'HLS unavailable (need both video and audio HLS variants)', {
                    video_id: videoIdFromOutput,
                    formats: output.formats ? output.formats.length : 0,
                });
            }

            if (adaptiveFmts.length === 0 && urlEncodedFmtStreamMapArr.length === 0) {
                logger.error('video-info', 'No playable formats found', { video_id: videoIdFromOutput });
                console.log('No playable formats found');
                return res.status(404).send('No playable formats found');
            }


            const fmtList = encodeURIComponent(fmtListArr.join(','));
            const adaptiveFmtsResponse = adaptiveFmts.join(',');
            const urlEncodedFmtStreamMapResponse = urlEncodedFmtStreamMapArr.join(',');
            //console.log('Constructed adaptive_fmts:', adaptiveFmtsResponse);
            //console.log('Constructed fmt_list:', fmtList);

            const videoInfo = `baseUrl=https%3A%2F%2F${encodeURIComponent(serverIp)}%3A8090
        iv_module=https%3A%2F%2Fs.ytimg.com%2Fyts%2Fswfbin%2Fplayer-vflq9bo_X%2Fiv_module.swf
        account_playback_token=QUFFLUhqbUNlSEVkMTBaWWVFcjgtNC1KZ3VIRzA0X2I2d3xBQ3Jtc0tsYklEbEFDemhBNlJJOS01TkFZQzJNUmVrVERqeDhaV1pqQmJEOFZ3V3pSWjNNRnhiZnd5NnJWejJONzM3dFh0MG9PT0U2Q3gzVnVKS194cEphNkVPeFE3azlSSFhabmh0QkpITW90b2FEMnpvVGZPQQ%3D%3D
        cbr=Chrome
        iv3_module=1
        iv_load_policy=1
        cosver=5.1
        probe_url=https%3A%2F%2Fr3---sn-p5qlsu7r.googlevideo.com%2Fvideogoodput%3Fid%3Do-AAdvekeNvhTnc7BLnVx3s1tYNVrOiCABO6a6dAvgVFLF%26source%3Dgoodput%26range%3D0-99999%26expire%3D1426349446%26ip%3D207.241.226.230%26ms%3Dpm%26mm%3D35%26pl%3D24%26sparams%3Did%2Csource%2Crange%2Cexpire%2Cip%2Cms%2Cmm%2Cpl%26signature%3D16006AFBAD95DD923171C54EAD9B46BC38E9EB.423F08645F93F89A254D8AF80FB0F006623DD7F3%26key%3Dcms1
        rvs=iurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FYxjyTznqNUY%252Fhqdefault.webp%26title%3D%25D7%2591%25D7%2595%25D7%2590%25D7%2595%2B%25D7%259C%25D7%25A8%25D7%2590%25D7%2595%25D7%25AA%2B%25D7%2590%25D7%25AA%2B%25D7%2597%25D7%25A0%25D7%2595%25D7%259A%2B%25D7%2593%25D7%2590%25D7%2595%25D7%259D%2B%25D7%25A2%25D7%2595%25D7%25A9%25D7%2594%2B%25D7%259E%25D7%259E%25D7%25A0%25D7%2599%2B%25D7%25A6%25D7%2597%25D7%2595%25D7%25A7%2B%252B%2B%25D7%25A9%25D7%2597%25D7%2596%25D7%2595%25D7%25A8%2B%25D7%25A9%25D7%259C%2B%25D7%25A7%25D7%25A8%25D7%2591%2B%25D7%259B%25D7%25A4%25D7%25A8%2B%25D7%259B%25D7%25A0%25D7%2590%26endscreen_autoplay_session_data%3Dplaynext%253D0%2526feature%253Drelated-auto%2526autonav%253D1%26id%3DYxjyTznqNUY%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D2101%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FYxjyTznqNUY%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252F_4RGlOLFSSU%252Fhqdefault.webp%26title%3D%25D7%2591%25D7%25A0%25D7%2598%2B%25D7%259C%25D7%25A0%25D7%2597%25D7%2595%25D7%259D%2B%25D7%2591%25D7%25A8%25D7%25A0%25D7%25A2%253A%2B%25D7%2590%25D7%2595%25D7%259C%25D7%2599%2B%25D7%2590%25D7%25AA%25D7%2594%2B%25D7%2594%25D7%25A7%25D7%2595%25D7%25A7%25D7%2595%253F%26id%3D_4RGlOLFSSU%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D667%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252F_4RGlOLFSSU%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FNi0mKluwQ_o%252Fhqdefault.webp%26title%3D%25D7%25A8%25D7%2599%25D7%25A0%25D7%2595%2B%25D7%25A6%25D7%25A8%25D7%2595%25D7%25A8%2B%25D7%259E%25D7%2595%25D7%25A8%25D7%2599%25D7%2593%2B%25D7%2590%25D7%25AA%2B%25D7%2599%25D7%25A0%25D7%2595%25D7%259F%2B%25D7%259E%25D7%2592%25D7%259C%2B%25D7%259E%25D7%25A9%25D7%2599%25D7%2593%25D7%2595%25D7%25A8%2B%25D7%2591%25D7%2592%25D7%259C%25D7%2599%2B%25D7%25A6%25D7%2594%2522%25D7%259C%26id%3DNi0mKluwQ_o%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D423%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FNi0mKluwQ_o%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FYwi1amZ29pg%252Fhqdefault.webp%26title%3D%25D7%2591%25D7%25A0%25D7%2598%2B%25D7%2591%25D7%25A2%25D7%25A8%25D7%2595%25D7%25A5%2B10%253A%2B%25D7%2594%25D7%25AA%25D7%25A7%25D7%25A9%25D7%2595%25D7%25A8%25D7%25AA%2B%25D7%259E%25D7%2595%25D7%25A4%25D7%25AA%25D7%25A2%25D7%25AA%2B%25D7%2591%25D7%259B%25D7%259C%2B%25D7%25A4%25D7%25A2%25D7%259D%2B%25D7%25A9%25D7%2594%25D7%25A2%25D7%259D%2B%25D7%2592%25D7%2595%25D7%25A0%25D7%2591%2B%25D7%2590%25D7%25AA%2B%25D7%2594%25D7%2591%25D7%2597%25D7%2599%25D7%25A8%25D7%2595%25D7%25AA%26id%3DYwi1amZ29pg%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D1075%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FYwi1amZ29pg%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FfslrzJcnrz4%252Fhqdefault.webp%26title%3D%25D7%2590%25D7%2599%25D7%2599%25D7%259C%25D7%25AA%2B%25D7%25A9%25D7%25A7%25D7%2593%2B%25D7%2591%25D7%25A2%25D7%2599%25D7%259E%25D7%2595%25D7%25AA%2B%25D7%25A1%25D7%2595%25D7%25A2%25D7%25A8%2B%25D7%259E%25D7%2595%25D7%259C%2B%25D7%2590%25D7%2597%25D7%259E%25D7%2593%2B%25D7%2598%25D7%2599%25D7%2591%25D7%2599%2B%25D7%2591%25D7%25A2%25D7%25A8%25D7%2595%25D7%25A5%2B2%26id%3DfslrzJcnrz4%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D418%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FfslrzJcnrz4%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FGMYp7vXBiEo%252Fhqdefault.webp%26title%3D%25D7%2594%25D7%2594%25D7%2599%25D7%25A4%25D7%25A1%25D7%2598%25D7%25A8%2B%25D7%2591%25D7%2598%25D7%2599%25D7%25A4%25D7%2595%25D7%259C%26id%3DGMYp7vXBiEo%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D205%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FGMYp7vXBiEo%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FbhJ9Za9VhNM%252Fhqdefault.webp%26title%3D%25D7%2591%25D7%25A0%25D7%2598%2B%25D7%2591%25D7%25A2%25D7%25A8%25D7%2595%25D7%25A5%2B2%253A%2B%2522%25D7%2590%25D7%25A0%25D7%2599%2B%25D7%25A0%25D7%2590%25D7%259C%25D7%25A5%2B%25D7%259C%25D7%2594%25D7%25A1%25D7%2591%25D7%2599%25D7%25A8%2B%25D7%259C%25D7%2597%25D7%2591%25D7%25A8%25D7%2599%2B%25D7%25A7%25D7%2595%25D7%25A0%25D7%2592%25D7%25A8%25D7%25A1%2B%25D7%259C%25D7%259E%25D7%2594%2B%25D7%2594%25D7%25A9%25D7%259E%25D7%2590%25D7%259C%2B%25D7%2594%25D7%2599%25D7%25A9%25D7%25A8%25D7%2590%25D7%259C%25D7%2599%2B%25D7%25AA%25D7%2595%25D7%25A7%25D7%25A3%2B%25D7%2590%25D7%2595%25D7%25AA%25D7%25A0%25D7%2595%2522%26id%3DbhJ9Za9VhNM%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D167%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FbhJ9Za9VhNM%252Fmqdefault.webp%2Cauthor%3Daviran15%26session_data%3Dfeature%253Dendscreen%26title%3D%25D7%2591%25D7%2595%25D7%2591%25D7%2594%2B%25D7%25A9%25D7%259C%2B%25D7%259E%25D7%2593%25D7%2599%25D7%25A0%25D7%2594%2B-%2B%25D7%259E%25D7%25A2%25D7%25A8%25D7%259B%25D7%2595%25D7%259F%2B%25D7%2590%25D7%2599%25D7%2599%25D7%259C%25D7%25AA%2B%25D7%25A9%25D7%25A7%25D7%2593%26length_seconds%3D98%26id%3Du7_1FOgPnQs%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252F_ihrEicKwOo%252Fhqdefault.webp%26title%3D%25D7%2594%25D7%2599%25D7%2592%2527%25D7%25A8%25D7%2594%2B%25D7%25A4%25D7%25A8%25D7%25A7%2B3%253A%2B%25D7%2594%25D7%25AA%25D7%25A1%25D7%259B%25D7%2595%25D7%259C%26id%3D_ihrEicKwOo%26author%3Dcapture_il%26length_seconds%3D1190%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252F_ihrEicKwOo%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FRYwEE7ZklCo%252Fhqdefault.webp%26title%3D%25D7%2594%25D7%2599%25D7%2592%2527%25D7%25A8%25D7%2594%2B%25D7%25A4%25D7%25A8%25D7%25A7%2B5%2B%25D7%2595%25D7%2590%25D7%2597%25D7%25A8%25D7%2595%25D7%259F%253A%2B%25D7%2594%25D7%25A4%25D7%25A6%25D7%25A6%25D7%2594%2B%25D7%2594%25D7%259E%25D7%25AA%25D7%25A7%25D7%25AA%25D7%25A7%25D7%25AA%26id%3DRYwEE7ZklCo%26author%3Dcapture_il%26length_seconds%3D986%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FRYwEE7ZklCo%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FVEvzFOMzgWM%252Fhqdefault.webp%26title%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2594%25D7%2594%25D7%2599%25D7%25A4%25D7%25A1%25D7%2598%25D7%25A8%2B-%2B%25D7%259E%25D7%25A4%25D7%25A1%25D7%2599%25D7%25A7%25D7%2599%25D7%259D%2B%25D7%259C%25D7%2594%25D7%25AA%25D7%25A0%25D7%25A6%25D7%259C%26id%3DVEvzFOMzgWM%26author%3DEli%2BSinger%26length_seconds%3D167%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FVEvzFOMzgWM%252Fmqdefault.webp%2Ciurlhq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FiPJk7UbHGlU%252Fhqdefault.webp%26title%3D%25D7%259E%25D7%25A0%25D7%25A9%25D7%25A7%25D7%2599%2B%25D7%2594%25D7%259E%25D7%2596%25D7%2595%25D7%2596%25D7%2595%25D7%25AA%2B%25D7%2594%25D7%2595%25D7%259C%25D7%259B%25D7%2599%25D7%259D%2B%25D7%259C%25D7%25A0%25D7%25A6%25D7%2597%26id%3DiPJk7UbHGlU%26author%3D%25D7%25A0%25D7%25A4%25D7%25AA%25D7%259C%25D7%2599%2B%25D7%2591%25D7%25A0%25D7%2598%2B%257C%2BNaftali%2BBennett%26length_seconds%3D141%26session_data%3Dfeature%253Dendscreen%26iurlmq_webp%3D%252F%252Fi.ytimg.com%252Fvi_webp%252FiPJk7UbHGlU%252Fmqdefault.webp
        of=DI8ulxjA44_i6rKc8TzAhw
        iv_invideo_url=https%3A%2F%2Fwww.youtube.com%2Fannotations_invideo%3Fcap_hist%3D1%26cta%3D2%26playlist_id%3DPLSH1V8Iv8_1VZzhTkvVHYdz8KUPeBGfN9%26video_id%3D0ggR11jYS3A
        length_seconds=${encodeURIComponent(videoDuration)}
        has_cc=False
        enablecsi=1
        pltype=contentugc
        dashmpd=https%3A%2F%2Fmanifest.googlevideo.com%2Fapi%2Fmanifest%2Fdash%2Frequiressl%2Fyes%2Fsparams%2Fas%252Cid%252Cip%252Cipbits%252Citag%252Cmm%252Cms%252Cmv%252Cpl%252Cplayback_host%252Crequiressl%252Csource%252Cexpire%2Fmm%2F31%2Fexpire%2F1426367447%2Fid%2Fo-ACX1zI2XgFa9Ua6DBBBDhejjcyuqZGGcBBuxoqx7yZEe%2Fipbits%2F0%2Ffexp%2F907263%252C927622%252C931372%252C933236%252C934954%252C937432%252C9405703%252C9406736%252C9407103%252C9407444%252C941440%252C943917%252C948124%252C951511%252C951703%252C952302%252C952612%252C952901%252C955301%252C957201%252C959701%252C963100%2Fupn%2FlzQl8NX90vo%2Fmt%2F1426345559%2Fsignature%2F83B28AA4F045410275E6A998720437E4349EF203.900B9BF39796F93CF795F626B9BD3FDD4B3723BA%2Fmv%2Fu%2Fip%2F207.241.226.230%2Fkey%2Fyt5%2Fitag%2F0%2Fpl%2F23%2Fsver%2F3%2Fplayback_host%2Fr10---sn-nwj7kned.googlevideo.com%2Fas%2Ffmp4_audio_clear%252Cwebm_audio_clear%252Cfmp4_sd_hd_clear%252Cwebm_sd_hd_clear%252Cwebm2_sd_hd_clear%2Fsource%2Fyoutube%2Fms%2Fau
        timestamp=1426345846
        avg_rating=4.5801980198
        vid=0ggR11jYS3A
        plid=AAURQQWJOzsm_uzM
        watermark=%2Chttps%3A%2F%2Fs.ytimg.com%2Fyts%2Fimg%2Fwatermark%2Fyoutube_watermark-vflHX6b6E.png%2Chttps%3A%2F%2Fs.ytimg.com%2Fyts%2Fimg%2Fwatermark%2Fyoutube_hd_watermark-vflAzLcD6.png
        ytfocEnabled=1
        video_id=${encodeURIComponent(videoId)}
        atc=a%3D3%26b%3DYLfP9dWvt5WXPMSq9vEpZTP_ePU%26c%3D1426345847%26d%3D1%26e%3D0ggR11jYS3A%26c3a%3D18%26hh%3DlThS1p2buueLl16Okg75F2RkKXM
        thumbnail_url=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fdefault.jpg
        iurlhq=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fhqdefault.jpg
        ldpj=0
        allow_embed=1
        iurlsd_webp=https%3A%2F%2Fi.ytimg.com%2Fvi_webp%2F0ggR11jYS3A%2Fsddefault.webp
        cos=Windows
        eventid=dk8EVYDiOemq-APyioDoDA
        allow_ratings=1
        iurlmq_webp=https%3A%2F%2Fi.ytimg.com%2Fvi_webp%2F0ggR11jYS3A%2Fmqdefault.webp
        watch_xlb=https%3A%2F%2Fs.ytimg.com%2Fyts%2Fxlbbin%2Fwatch-strings-iw_IL-vflTB6g9h.xlb
        iurlhq_webp=https%3A%2F%2Fi.ytimg.com%2Fvi_webp%2F0ggR11jYS3A%2Fhqdefault.webp
        muted=0
        c=web
        fexp=907263%2C927622%2C931372%2C933236%2C934954%2C937432%2C9405703%2C9406736%2C9407103%2C9407444%2C941440%2C943917%2C948124%2C951511%2C951703%2C952302%2C952612%2C952901%2C955301%2C957201%2C959701%2C963100
        status=ok
        iurlmaxres=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fmaxresdefault.jpg
        loudness=-20.4790000916
        fmt_list=${encodeURIComponent(fmtList)}
        aid=P-r-BXKOXj0
        ptk=youtube_none
        vq=auto
        iurl=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fhqdefault.jpg
        author=%D7%A0%D7%A4%D7%AA%D7%9C%D7%99+%D7%91%D7%A0%D7%98+%7C+Naftali+Bennett
        storyboard_spec=https://i.ytimg.com/sb/OxoOSohmaag/storyboard3_L0/default.jpg?sqp=-oaymwENSDfyq4qpAwVwAcABBqLzl_8DBgjvjc-oBg==&sigh=rs$AOn4CLCM4gaqvsBmP9olCrnqXWONsDTRCQ
        url_encoded_fmt_stream_map=${encodeURIComponent(urlEncodedFmtStreamMapResponse)}
        adaptive_fmts=${encodeURIComponent(adaptiveFmtsResponse)}
        hls_url=${encodeURIComponent(hlsUrl)}
        remarketing_url=https%3A%2F%2Fgoogleads.g.doubleclick.net%2Fpagead%2Fviewthroughconversion%2F962985656%2F%3Flabel%3Dfollowon_view%26cname%3D1%26foc_id%3D4x7LYSzgGH-TMKc9J8pwgQ%26backend%3Dplayer_vars%26cver%3DHTML5%26ptype%3Dno_rmkt%26aid%3DP989_XaxlmI
        idpj=-2
        cbrver=41.0.2272.89
        iurlsd=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fsddefault.jpg
        title=${encodeURIComponent(videoTitle)}
        iurlmaxres_webp=https%3A%2F%2Fi.ytimg.com%2Fvi_webp%2F0ggR11jYS3A%2Fmaxresdefault.webp
        csi_page_type=embed
        video_verticals=%5B16%2C+35%5D
        cl=88507848
        no_get_video_log=0
        iv_allow_in_place_switch=1
        iurl_webp=https%3A%2F%2Fi.ytimg.com%2Fvi_webp%2F0ggR11jYS3A%2Fhqdefault.webp
        uid=4x7LYSzgGH-TMKc9J8pwgQ
        view_count=71358
        iurlmq=https%3A%2F%2Fi.ytimg.com%2Fvi%2F0ggR11jYS3A%2Fmqdefault.jpg
        token=sSPRzi9D_lUlZc6YQ3eQUyy2ufFAoMasmxX1Ps4S1zA%3D
        tmi=1
        keywords=%D7%A0%D7%A4%D7%AA%D7%9C%D7%99+%D7%91%D7%A0%D7%98
        use_cipher_signature=False
        `;

            const properties = videoInfo.trim().split("\n");

            const encodedProperties = properties.map(prop => {
                const [key, value] = prop.split('=');
                const decodedValue = decodeURIComponent(value || '');
                return `${key}=${decodedValue !== value ? value : encodeURIComponent(value || '')}`;
            });

            const encodedResponse = encodedProperties.join('&').replace(/\s+/g, '');

            const rewrittenResponse = rewriteString(encodedResponse, {
                serverIp,
                port: 8090,
                origin: `http://${serverIp}:8090`,
            });

            res.send(rewrittenResponse);
        })

        .catch(err => {
            const message = err.stderr || err.message || String(err);
            logger.error('video-info', 'yt-dlp failed', {
                video_id: videoId,
                message: logger.truncateStderr(message),
            });
            console.error('[get_video_info] yt-dlp failed:', message);
            console.error(
                '[get_video_info] tip: update bundled binary with ' +
                '`npx youtube-dl-exec` reinstall / download latest yt-dlp into ' +
                'node_modules/youtube-dl-exec/bin/, or set ytDlpCookies in settings.json'
            );
            // Do not forward to unrelated telemetry URLs. Fail clearly.
            res.status(502).send(
                `Failed to fetch video info via yt-dlp (${bundledYtDlpVersion}): ${message}`
            );
        });
}

function hlsPathFor(videoId, req) {
    const host = (req && req.headers && req.headers.host) || `${serverIp}:8090`;
    return `http://${host}/api/hls/${videoId}?mime=application/x-mpegURL&itag=hls`;
}

function buildHlsEntry(videoId, formats) {
    if (!Array.isArray(formats)) return null;
    const candidates = formats.filter(
        f => f.protocol === 'm3u8_native' && f.url && f.url.includes('m3u8')
    );
    const videoCandidates = candidates.filter(f => f.vcodec && f.vcodec !== 'none');
    const audioCandidates = candidates.filter(f => !f.vcodec || f.vcodec === 'none');

    let videoChosen = null;
    const heightPref = [360, 240, 480, 144, 720];
    for (const h of heightPref) {
        videoChosen =
            videoCandidates.find(f => (f.height || 0) === h && String(f.vcodec || '').toLowerCase().includes('avc')) ||
            videoCandidates.find(f => (f.height || 0) === h);
        if (videoChosen) break;
    }
    if (!videoChosen) videoChosen = videoCandidates[0];
    const audioChosen = audioCandidates.find(f => String(f.format_id || '').includes('aac')) || audioCandidates[0];

    if (!videoChosen || !audioChosen) return null;

    const videoExp = parseExpireSeconds(videoChosen.url);
    const audioExp = parseExpireSeconds(audioChosen.url);

    // All usable video renditions (deduped by height, AVC preferred) so the
    // client can offer a quality picker. Heights ascend for stable ordering.
    const byHeight = new Map(); // height -> candidate
    for (const f of videoCandidates) {
        const h = f.height || 0;
        if (!h) continue;
        const prev = byHeight.get(h);
        if (!prev) { byHeight.set(h, f); continue; }
        const prevAvc = String(prev.vcodec || '').toLowerCase().includes('avc');
        const curAvc = String(f.vcodec || '').toLowerCase().includes('avc');
        if (!prevAvc && curAvc) byHeight.set(h, f);
    }
    const variants = Array.from(byHeight.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([h, f]) => ({
            height: h,
            width: f.width || 0,
            itag: String(f.format_id || ''),
            url: f.url,
            codec: String(f.vcodec || '').split('.')[0] || 'avc1',
            tbr: Number(f.tbr) || 0,
            expiresAt: parseExpireSeconds(f.url) ? parseExpireSeconds(f.url) * 1000 : Date.now() + 6 * 60 * 60 * 1000,
        }));

    return {
        video: { url: videoChosen.url, expiresAt: videoExp ? videoExp * 1000 : Date.now() + 6 * 60 * 60 * 1000 },
        audio: { url: audioChosen.url, expiresAt: audioExp ? audioExp * 1000 : Date.now() + 6 * 60 * 60 * 1000 },
        expiresAt: Math.max(
            videoExp ? videoExp * 1000 : Date.now() + 6 * 60 * 60 * 1000,
            audioExp ? audioExp * 1000 : Date.now() + 6 * 60 * 60 * 1000
        ),
        variants,
        videoId,
    };
}

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Small in-memory cache for HLS media playlists (a few dozen KB of text) so
// repeated client requests don't re-fetch the upstream manifest every time and
// TV/desktop start instantly. This is metadata, not media bytes.
const hlsMediaCache = new Map(); // absUrl -> { text, ts }

function cacheHlsMedia(url, text) {
    try { if (hlsMediaCache.size > 64) hlsMediaCache.clear(); } catch (e) { }
    hlsMediaCache.set(url, { text, ts: Date.now() });
}

async function fetchHlsPlaylist(absUrl, videoId) {
    const cached = hlsMediaCache.get(absUrl);
    if (cached && Date.now() - cached.ts < 150000) return cached.text;
    let resp;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            resp = await axios.get(absUrl, {
                responseType: 'text',
                timeout: 60000,
                maxRedirects: 5,
                headers: { 'User-Agent': BROWSER_UA },
            });
        } catch (err) {
            if (attempt === 3) throw err;
            await new Promise(r => setTimeout(r, 500 * attempt));
            continue;
        }
        const data = String(resp.data || '');
        if (data.trim().startsWith('#EXTM3U') || data.trim().length > 20) {
            break;
        }
        logger.warn('hls', 'playlist not usable, retrying', { video_id: videoId, attempt, len: data.length });
        if (attempt === 3) break;
        await new Promise(r => setTimeout(r, 500 * attempt));
    }
    const prefix = `/api/hls/${videoId}/p/`;
    const rewritten = String(resp.data || '')
        .split(/\r?\n/)
        .map(line => {
            const trimmed = String(line).trim();
            if (!trimmed) return line;
            if (trimmed.charAt(0) === '#') {
                if (trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                        let absolute;
                        try {
                            absolute = new URL(uri, absUrl).href;
                        } catch (e) {
                            return match;
                        }
                        return `URI="${prefix}${encodeURIComponent(absolute)}"`;
                    });
                }
                return line;
            }
            let absolute;
            try {
                absolute = new URL(trimmed, absUrl).href;
            } catch (e) {
                return line;
            }
            return `${prefix}${encodeURIComponent(absolute)}`;
        })
        .join('\n');
    if (rewritten.trim().startsWith('#EXTM3U')) cacheHlsMedia(absUrl, rewritten);
    return rewritten;
}

async function handleHlsRequest(req, res) {
    try {
        const urlPath = (req.path || req.url.split('?')[0]).replace(/^\/+/, '/');
        const m = /\/api\/hls\/([^/]+)(?:\/p\/(.+))?$/.exec(urlPath);
        if (!m) return res.status(400).send('Bad HLS path');
        const videoId = m[1];
        const sub = m[2] ? decodeURIComponent(m[2]) : null;

        let entry = hlsMap.get(videoId);
        if (!entry || (entry.expiresAt && Date.now() > entry.expiresAt)) {
            logger.warn('hls', 'refreshing yt-dlp for HLS', { video_id: videoId });
            const output = await getVideoInfoCached(videoId);
            const fresh = buildHlsEntry(videoId, output.formats || []);
            if (!fresh) {
                return res.status(404).send('No HLS variants available');
            }
            hlsMap.set(videoId, fresh);
            entry = fresh;
        }

        if (!sub) {
            const base = `http://${req.headers.host || `${serverIp}:8090`}`;
            const encAudio = encodeURIComponent(entry.audio.url);
            const qH = parseInt(req.query && req.query.q, 10) || 0;

            const chosen = [];
            if (qH > 0 && Array.isArray(entry.variants)) {
                const hit = entry.variants.find(v => v.height === qH) ||
                    entry.variants.reduce((best, v) => {
                        if (!best) return v;
                        return Math.abs(v.height - qH) < Math.abs(best.height - qH) ? v : best;
                    }, null);
                if (hit) chosen.push(hit);
                else for (const v of entry.variants) chosen.push(v);
            } else if (Array.isArray(entry.variants) && entry.variants.length) {
                for (const v of entry.variants) chosen.push(v);
            } else {
                const fall = {
                    height: (decodeURIComponent(entry.video.url).match(/itag=(\d+)/) || [])[1] || '',
                    width: 0, itag: '', url: entry.video.url, codec: '', tbr: 0, expiresAt: entry.video.expiresAt,
                };
                chosen.push(fall);
            }

            const bwOf = v => {
                if (v.tbr > 0) return Math.round(v.tbr * 1000);
                return ({ 144: 120000, 240: 350000, 360: 800000, 480: 1300000, 720: 2500000, 1080: 5000000 })[v.height] || 900000;
            };
            const streams = chosen.map(v => {
                const encV = encodeURIComponent(v.url);
                const bw = bwOf(v);
                const vcodec = v.codec && /^[a-z0-9.]+$/i.test(v.codec) ? v.codec : 'avc1.4d401e';
                const codecs = `${vcodec},mp4a.40.2`;
                return `#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${Math.round(bw * 0.8)},RESOLUTION=${(v.width || 1280)}x${v.height || 360},CODECS="${codecs}",AUDIO="audio"\n` +
                    `${base}/api/hls/${videoId}/p/${encV}\n`;
            }).join('');

            const master =
                `#EXTM3U\n` +
                `#EXT-X-VERSION:3\n` +
                `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="aac",DEFAULT=YES,AUTOSELECT=YES,URI="${base}/api/hls/${videoId}/p/${encAudio}"\n` +
                streams;
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(master);
        }

        const absolute = sub;
        // Media playlists end with ".m3u8"; YouTube segment URLs only contain a
        // "/playlist/index.m3u8/" path segment mid-string, so anchor to the end.
        if (/\.m3u8(\?|#|$)/i.test(absolute)) {
            const text = await fetchHlsPlaylist(absolute, videoId);
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }

        // Binary segment (TS / fMP4 / AAC).
        const headers = {
            'User-Agent': 'Mozilla/5.0',
        };
        if (req.headers.range) headers.Range = req.headers.range;
        const resp = await axios.get(absolute, { responseType: 'arraybuffer', timeout: 90000, maxRedirects: 5, headers });
        res.status(resp.status || 200);
        if (resp.headers['content-type']) res.set('Content-Type', resp.headers['content-type']);
        if (resp.headers['content-length']) res.set('Content-Length', resp.headers['content-length']);
        if (resp.headers['content-range']) res.set('Content-Range', resp.headers['content-range']);
        if (resp.headers['accept-ranges']) res.set('Accept-Ranges', resp.headers['accept-ranges']);
        return res.send(Buffer.from(resp.data));
    } catch (err) {
        logger.error('hls', 'proxy failed', {
            message: logger.truncateStderr(String(err.message || err)),
        });
        if (!res.headersSent) res.status(502).send('HLS proxy error');
    }
}

module.exports = { handleGetVideoInfo, handleStreamRequest, handleHlsRequest };
