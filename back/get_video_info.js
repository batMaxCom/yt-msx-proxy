const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const youtubeDl = require('youtube-dl-exec');
const logger = require('./logger');

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

const streamMap = new Map();

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
            streamMap.set(`${videoId}_${format.format_id}`, format.url);
        }
    });
}

function proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, attemptsLeft, delayMs) {
    if (req.destroyed || req.aborted || res.writableEnded) return;

    axios({
        method: 'GET',
        url: targetUrl,
        headers: proxyHeaders,
        responseType: 'stream',
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 60000,
    })
        .then(upstream => {
            res.status(upstream.status);

            const headersToCopy = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
            headersToCopy.forEach(header => {
                if (upstream.headers[header]) {
                    res.setHeader(header, upstream.headers[header]);
                }
            });

            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Access-Control-Allow-Origin', '*');

            if (upstream.status >= 300) {
                logger.warn('stream', `Upstream ${upstream.status} for ${streamId}`, {
                    stream_id: streamId,
                    upstream_status: upstream.status,
                    range: req.headers['range'] || '',
                    upstream_content_type: upstream.headers['content-type'] || '',
                    upstream_content_length: upstream.headers['content-length'] || '',
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

            upstream.data.pipe(res);
        })
        .catch(err => {
            if (isTransientStreamError(err) && attemptsLeft > 1) {
                logger.warn('stream', 'Upstream network error, retrying', {
                    stream_id: streamId,
                    message: String(err.message).slice(0, 300),
                    attempts_left: attemptsLeft - 1,
                });
                setTimeout(() => {
                    proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, attemptsLeft - 1, delayMs);
                }, delayMs);
                return;
            }
            logger.error('stream', 'Stream proxy error', {
                stream_id: streamId,
                message: String(err.message).slice(0, 400),
                code: err.code || undefined,
            });
            console.error(`Stream proxy error for ${streamId}:`, err.message);
            if (!res.headersSent && !res.writableEnded) {
                res.status(502).send('Failed to proxy stream');
            }
        });
}

function proxyStreamWithError(res, status, message) {
    if (!res.headersSent && !res.writableEnded) {
        res.status(status).send(message);
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
    const rangeMatch = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    if (!rangeMatch) {
        return proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, 3, 700);
    }

    let rangeStart = parseInt(rangeMatch[1], 10);
    let rangeEnd = parseInt(rangeMatch[2], 10);

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
    const targetUrl = streamMap.get(streamId);

    if (!targetUrl) {
        logger.error('stream', 'Stream not found', { stream_id: streamId });
        console.error(`Stream not found for id: ${streamId}`);
        return res.status(404).send('Stream not found');
    }

    const proxyHeaders = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (compatible; 2016YouTubeTV/1.0)',
    };

    if (req.headers['range']) {
        proxyHeaders['Range'] = req.headers['range'];
    }

    // Cluster-aligned middleware: when the player requests a mid-file byte
    // range right after a seek (&seek=1), serve the bytes starting at the
    // nearest WebM cluster boundary at/before the requested offset so the
    // raw data is parseable when appended to MSE (arbitrary offsets corrupt
    // the decoder and trigger "An error occurred").
    if (req.query.seek === '1' && req.headers['range']) {
        proxyAlignedSeek(req, res, streamId, targetUrl, proxyHeaders, req.headers['range'])
            .catch(err => {
                logger.error('stream', 'Aligned seek handler error', {
                    stream_id: streamId,
                    message: String(err.message).slice(0, 300),
                });
                proxyStreamWithError(res, 502, 'Failed to proxy stream');
            });
        return;
    }

    proxyStreamWithRetry(req, res, streamId, targetUrl, proxyHeaders, 3, 700);
}


function handleGetVideoInfo(req, res) {
    const videoId = req.query.video_id;
    const prettyPrint = req.query.prettyprint === 'true';
    const unurlencode = req.query.unurlencode === 'true';

    const disableWebM = false;
    if (!videoId) {
        return res.status(400).send('Video ID is required');
    }

    console.log('[REQUEST] GET /get_video_info');
    console.log('[REQUEST] video_id:', videoId);
    console.log('[yt-dlp] using version:', bundledYtDlpVersion);

    // Prefer embedded TV/Android clients — they return the full adaptive format
    // set (video-only H264/VP9/AV1 + audio-only m4a/webm/opus) that the TV
    // player's custom streaming code requires. Plain `tv`, `android` and `web`
    // currently yield only progressive itag 18 + storyboards, which produce the
    // "This video format is not supported." error.
    const ytdlpFlags = {
        dumpSingleJson: true,
        noWarnings: true,
        quiet: true,
        noCheckCertificates: true,
        socketTimeout: 20,
        retries: 3,
        extractorArgs: 'youtube:player_client=tv_embedded,android_embedded',
    };

    // Optional cookies from settings.json:
    //   "ytDlpCookies": "/path/to/cookies.txt"
    //   or "ytDlpCookiesFromBrowser": "chrome"
    if (settings.ytDlpCookies && fs.existsSync(settings.ytDlpCookies)) {
        ytdlpFlags.cookies = settings.ytDlpCookies;
        console.log('[yt-dlp] cookies file:', settings.ytDlpCookies);
    } else if (settings.ytDlpCookiesFromBrowser) {
        ytdlpFlags.cookiesFromBrowser = settings.ytDlpCookiesFromBrowser;
        console.log('[yt-dlp] cookiesFromBrowser:', settings.ytDlpCookiesFromBrowser);
    }

    console.log('[UPSTREAM] yt-dlp', videoId, ytdlpFlags);

    const maxAttempts = typeof settings.ytDlpMaxAttempts === 'number' ? settings.ytDlpMaxAttempts : 3;

    async function extractWithRetry() {
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
                console.error(`[yt-dlp] attempt ${attempt}/${maxAttempts} failed:`, logger.truncateStderr(message));
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
                }
            }
        }
        throw lastErr;
    }

    extractWithRetry()
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



            res.send(encodedResponse);
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

module.exports = { handleGetVideoInfo, handleStreamRequest };
