const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const QRCode = require('qrcode');
const corsAnywhere = require('cors-anywhere');

const logger = require('./logger');

const { fetchGuideData } = require('./guide_api');

const { handleSearchRequest } = require('./search_api');
const { fetchNextData } = require('./next_api');
const { fetchRelated } = require('./related_api');
const { handleGetVideoInfo, handleStreamRequest, handleHlsRequest, getVideoInfoCached } = require('./get_video_info');

// tv_cast pairing / lounge endpoints
const {
    getLoungeTokenBatch,
    generateScreenId,
    getPairingCode,
    registerPairingCode,
    getLoungeDetails
} = require('./lounge_api');

const imageProxy = require('./image_proxy');

const bodyParser = require('body-parser');
const oauthRouter = require('./oauth_api_v3_api.js');

const watchPageInteractions = require('./watch_page_interactions_apis');
const { registerMsxRoutes, isMsxPath } = require('./msx');


const settingsPath = path.join(__dirname, 'settings.json');

let settings;

if (!fs.existsSync(settingsPath)) {
    const defaultSettings = { 
        serverIp: 'localhost',  
        expBrowse: false,
        hideOnScreenNav: false,
        showToggleVideoInfo: false,
        chainPlayback: true
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
    console.log("Created settings.json with default serverIp = localhost and expBrowse = false.");
    settings = defaultSettings;
} else {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    console.log(`Current settings in settings.json: ${JSON.stringify(settings, null, 4)}`);
}

const { fetchBrowseData } = settings.expBrowse
    ? require('./exp_browse_api')  
    : require('./browse_api');    

const serverIp = settings.serverIp || "localhost";

console.log("Loaded Server IP:", serverIp);

const app = express();
const port = 8090;

// Relay every YouTube CDN image through this backend and rewrite all outgoing
// JSON so the browser never talks to YouTube/archive.org directly.
const imageProxyCtx = {
    serverIp,
    port,
    origin: `http://${serverIp}:${port}`,
};
imageProxy.installImageProxyRoutes(app, imageProxyCtx);

// Address on which the HTTP server binds. Defaults to the configured server IP.
// Set BIND_ADDR=0.0.0.0 when running in Docker / behind a NAT so the socket
// binds to every interface while the client-facing URLs keep using serverIp.
const bindAddr = process.env.BIND_ADDR || serverIp;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
});

const server = corsAnywhere.createServer({
    originWhitelist: [`http://${serverIp}:8090`, 'null', '""', ''],
    removeHeaders: ['cookie', 'cookie2'],
    handleInitialRequest: (req, res) => {
        const origin = req.headers.origin;

        if (origin === `http://${serverIp}:8090` || origin === 'null' || origin === '""' || origin === '') {
            res.setHeader('Access-Control-Allow-Origin', origin);
        } else {
            res.writeHead(403, 'Forbidden');
            res.end('Origin not allowed');
            return true;
        }

        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return true;
        }
        return false;
    }
});


server.listen(8070, bindAddr, () => {
    console.log('CORS Anywhere proxy running on http://' + serverIp + ':8070');
});


app.use((req, res, next) => {
    const started = Date.now();
    const msx = isMsxPath(req.path);
    const queryPreview = { ...req.query };
    for (const key of ['video_id']) {
        if (queryPreview[key]) queryPreview[key] = String(queryPreview[key]).slice(0, 40);
    }

    res.on('finish', () => {
        const durationMs = Date.now() - started;
        logger.http(req, res, res.statusCode, durationMs, {
            msx,
            content_type: res.getHeader('content-type') || '',
            query: queryPreview,
            range: req.headers.range || '',
            seek_align: req.query.seek === '1',
        });
        const seekFlag = req.query.seek === '1' ? ' seek=1' : '';
        const rangeHint = req.headers.range ? ` ${req.headers.range}` : '';
        const crHint = res.getHeader('content-range') ? ` => ${res.getHeader('content-range')}` : '';
        console.log(`[${msx ? 'MSX' : 'REQ'}] ${req.method} ${req.path} ${res.statusCode} (${durationMs}ms)${rangeHint}${crHint}${seekFlag}`);
    });
    next();
});

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use('/assets', express.static(path.join(__dirname, '../assets')));

app.use('/logs', express.static(path.join(__dirname, '../logs')));

app.post(['/error_204', '/api/stats/atr', '/csi_204'], express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let pretty = '';
    try {
        const parsed = JSON.parse(raw);
        pretty = JSON.stringify(parsed).slice(0, 4000);
    } catch (e) {
        pretty = raw.slice(0, 4000);
    }
    const entry = { t: Date.now(), path: req.path, bodyLen: raw.length, body: pretty || '(empty)' };
    try {
        logger.error({ category: 'echotest', message: 'client telemetry captured: ' + req.path, meta: entry });
    } catch (e) { /* noop */ }
    console.log(`[CLIENT-TELEMETRY] ${req.path} len=${raw.length} ${pretty.slice(0, 300)}`);
    res.status(204).end();
});

app.post('/api/client-log', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let ev = 'raw', ct = -1, payload = raw;
    try {
        const parsed = JSON.parse(raw);
        ev = parsed.ev || 'parsed';
        ct = parsed.ct !== undefined ? parsed.ct : -1;
        payload = JSON.stringify(parsed).slice(0, 1200);
        try { logger.info('client', `beacon ${ev}`, parsed); } catch (eL) {}
    } catch (e) {}
    console.log(`[CLIENT] ${ev} ct=${ct} ${String(payload).slice(0, 220)}`);
    res.status(204).end();
});

// Media Station X entry points (must be JSON, not HTML)
registerMsxRoutes(app, { serverIp, port });

app.get('/', (req, res) => {
    console.log('Received request for the root endpoint');
    res.sendFile(path.join(__dirname, '../index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// Expose runtime settings to the TV client (custom-player.js reads the
// hideOnScreenNav flag from here to decide whether on-screen nav hints stay).
// Keys added after a settings.json was first written are filled in here, so
// an existing install sees the current defaults without editing the file.
const SETTINGS_DEFAULTS = { chainPlayback: true };
app.get('/settings.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(Object.assign({}, SETTINGS_DEFAULTS, settings));
});

oauthRouter(app);
watchPageInteractions(app);

app.get('/get-thumbnail', async (req, res) => {
    const videoId = req.query.videoId;

    if (!videoId) {
        return res.status(400).json({ error: 'Video ID is required.' });
    }

    const youtubeThumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
        res.json({ thumbnailUrl: youtubeThumbnailUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch thumbnail.' });
    }
});


app.get('/web/*', (req, res) => {
    const requestedUrl = req.params[0];

    const urlStartIndex = requestedUrl.indexOf('http');
    const youtubeUrl = requestedUrl.substring(urlStartIndex);
    const fileName = path.basename(youtubeUrl);

    console.log(`Redirecting to asset: /assets/${fileName}`);

    return res.redirect(`/assets/${fileName}`);
});

app.get('/assets/:folder/*', (req, res) => {
    const folder = req.params.folder;
    const requestedPath = req.params[0];

    const fileName = path.basename(requestedPath);

    const redirectUrl = `/assets/${fileName}`;
    console.log(`Redirecting from /assets/${folder}/${requestedPath} to ${redirectUrl}`);

    res.redirect(redirectUrl);
});

app.get('/assets/:filename', (req, res) => {
    const filename = req.params.filename;

    const cleanedFilename = filename.replace(/^[a-f0-9]{8}/, '');

    console.log(`Serving file: /assets/${cleanedFilename}`);

    const filePath = path.join(__dirname, '../assets', cleanedFilename);

    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            console.error(`File not found: ${filePath}`);
            return res.status(404).send('File not found');
        }

        res.sendFile(filePath);
    });
});

// Telemetry beacons from the 2016 TV client. They intentionally target APP_URL
// (this backend). Forwarding them to youtube-nocookie.com is wrong: those
// legacy paths are gone and produce 404 noise. Acknowledge locally instead.
app.get('/gen_204', (req, res) => {
    console.log('[TELEMETRY] /gen_204 acknowledged locally (not forwarded)');
    res.status(204).end();
});

app.get(/^\/{0,2}get_video_info$/, (req, res) => {
    handleGetVideoInfo(req, res);
});

app.get('/api/stream/:stream_id', handleStreamRequest);

app.get(/^\/{0,2}api\/hls\//, (req, res) => {
    handleHlsRequest(req, res);
});

app.get('/api/logs', (req, res) => {
    const opts = {
        level: req.query.level,
        category: req.query.category,
        grep: req.query.search,
        since: req.query.since,
    };
    const tail = parseInt(req.query.tail, 10);
    if (!isNaN(tail) && tail > 0) opts.tail = tail;

    try {
        const entries = logger.readEntries(opts);
        res.json({ count: entries.length, entries });
    } catch (err) {
        logger.error('system', 'Failed to read log entries', { message: err.message });
        res.status(500).json({ error: 'Failed to read log entries', details: err.message });
    }
});

app.get('/api/logs/errors', (req, res) => {
    const top = parseInt(req.query.top, 10);
    try {
        const summary = logger.errorSummary({ top: isNaN(top) ? 20 : top });
        res.json({ count: summary.length, buckets: summary });
    } catch (err) {
        logger.error('system', 'Failed to build error summary', { message: err.message });
        res.status(500).json({ error: 'Failed to build error summary', details: err.message });
    }
});

app.get('/device_204', (req, res) => {
    // Frontend sets eh.f = APP_URL + "/device_204" in app-prod.js — this is
    // supposed to hit our backend, not YouTube. Do not proxy upstream.
    console.log('[TELEMETRY] /device_204 acknowledged locally (not forwarded)');
    res.status(204).end();
});


app.get('/api/stats/qoe', (req, res) => {
    const qoeData = req.query;
    console.log('QoE Data received:', qoeData);

    const { event, fmt, afmt, cpn, ei, el, docid, ns, fexp, html5, c, cver, cplayer, cbrand, cbr, cbrver, ctheme, cmodel, cnetwork, cos, cosver, cplatform, vps, cmt, afs, vfs, view, bwe, bh, vis } = qoeData;

    if (!event || !fmt || !afmt || !cpn || !ei || !docid || !ns) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    logger.info('qoe', `QoE ${event} video=${docid} fmt=${fmt}/${afmt}`, {
        event, fmt, afmt, cpn, ei, el, docid, ns, fexp, c, cver, cplayer, cbrand, cbr, cbrver,
        ctheme, cmodel, cnetwork, cos, cosver, cplatform, vps, cmt, afs, vfs,
    });

    const logEntry = `
    Event: ${event}, Format: ${fmt}, Audio Format: ${afmt}, CPN: ${cpn}, EI: ${ei}, EL: ${el}, DocID: ${docid}, 
    NS: ${ns}, Exp: ${fexp}, HTML5: ${html5}, C: ${c}, CVer: ${cver}, CPlayer: ${cplayer}, CBrand: ${cbrand}, 
    CBR: ${cbr}, CBRVer: ${cbrver}, CTheme: ${ctheme}, CModel: ${cmodel}, CNetwork: ${cnetwork}, COS: ${cos}, 
    COSVer: ${cosver}, CPlatform: ${cplatform}, VPS: ${vps}, CMT: ${cmt}, AFS: ${afs}, VFS: ${vfs}, View: ${view}, 
    BWE: ${bwe}, BH: ${bh}, VIS: ${vis}, Timestamp: ${new Date().toISOString()}
    \n`;

    const logFilePath = path.join(logsDir, 'qoe_report.txt');

    fs.appendFile(logFilePath, logEntry, (err) => {
        if (err) {
            console.error('Error writing to log file:', err);
            return res.status(500).json({ error: 'Failed to log data' });
        }

        res.status(200).json({
            message: 'QoE data received and logged successfully',
            data: qoeData
        });
    });
});

app.get('/api/chart', async (req, res) => {
    const { cht, chs, chl } = req.query;

    if (!cht || cht !== 'qr' || !chl || !chs) {
        return res.status(400).send('Invalid request. Parameters "cht", "chs", and "chl" are required.');
    }

    const size = chs.split('x');
    if (size.length !== 2 || isNaN(size[0]) || isNaN(size[1])) {
        return res.status(400).send('Invalid "chs" parameter. Expected format "widthxheight".');
    }

    const width = parseInt(size[0]);
    const height = parseInt(size[1]);

    try {
        const decodedUrl = decodeURIComponent(chl);

        const qrImage = await QRCode.toBuffer(decodedUrl, { width, height });

        res.setHeader('Content-Type', 'image/png');
        res.send(qrImage);
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).send('Failed to generate QR code');
    }
});

app.get('/api/browse', async (req, res) => {
    const { browseId } = req.query;

    if (!browseId) {
        return res.status(400).json({
            error: 'Missing browseId parameter in the request.'
        });
    }

    try {
        const browseData = await fetchBrowseData(browseId, bearerOf(req), ytCookieOf(req));
        res.json(browseData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: error.message
        });
    }
});

app.post('/api/lounge/pairing/generate_screen_id', async (req, res) => {
    const { pairingCode } = req.body;

    if (!pairingCode) {
        return res.status(400).json({
            error: 'Missing pairingCode parameter in the request.'
        });
    }

    try {
        const screenIdData = await generateScreenId(pairingCode);
        res.json(screenIdData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: 'Failed to generate screen ID',
            details: error.message
        });
    }
});


app.post('/api/lounge/pairing/get_lounge_token_batch', async (req, res) => {
    const { screenIds } = req.body;

    if (!screenIds) {
        return res.status(400).json({
            error: 'Missing screenIds parameter in the request.'
        });
    }

    try {
        // Call the helper function with the screenIds
        const tokenBatchData = await getLoungeTokenBatch(screenIds);
        res.json(tokenBatchData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: 'Failed to get lounge token batch',
            details: error.message
        });
    }
});

app.get('/api/lounge/pairing/get_pairing_code', async (req, res) => {
    const { screenId } = req.query;

    if (!screenId) {
        return res.status(400).json({
            error: 'Missing screenId parameter in the request.'
        });
    }

    try {
        const pairingCodeData = await getPairingCode(screenId);
        res.json(pairingCodeData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: 'Failed to get pairing code',
            details: error.message
        });
    }
});


app.post('/api/lounge/pairing/register_pairing_code', async (req, res) => {
    const { pairingCode } = req.body;

    if (!pairingCode) {
        return res.status(400).json({
            error: 'Missing pairingCode parameter in the request.'
        });
    }

    try {
        const registrationData = await registerPairingCode(pairingCode);
        res.json(registrationData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: 'Failed to register pairing code',
            details: error.message
        });
    }
});

app.get('/api/lounge/pairing/get_lounge_details', async (req, res) => {
    const { screenId } = req.query;

    if (!screenId) {
        return res.status(400).json({
            error: 'Missing screenId parameter in the request.'
        });
    }

    try {
        const loungeDetailsData = await getLoungeDetails(screenId);
        res.json(loungeDetailsData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: 'Failed to get lounge details',
            details: error.message
        });
    }
});

app.all('/api/lounge/bc/bind', async (req, res) => {
    try {
        const youtubeApiUrl = 'https://www.youtube.com/api/lounge/bc/bind';
        
        // Extract necessary parameters from the request
        const loungeIdToken = req.query.loungeIdToken;
        const device = req.query.device || 'LOUNGE_SCREEN';
        
        if (!loungeIdToken) {
            return res.status(400).json({ error: 'Missing loungeIdToken' });
        }
        
        // Construct the correct request to YouTube API
        const params = new URLSearchParams({
            device,
            id: 'deff2a47-89f4-4d02-a940-c00d0abf2809',
            obfuscatedGaiaId: '',
            name: 'YouTube on TV',
            app: 'lb-v4',
            theme: 'cl',
            capabilities: 'dsp,mic,dpa,ntb,pas,dcn,dcp,drq,isg,els',
            cst: 'm',
            mdxVersion: '2',
            loungeIdToken,
            VER: '8',
            v: '2',
            deviceInfo: JSON.stringify({
                brand: 'Samsung',
                model: 'SmartTV',
                year: 0,
                os: 'Tizen',
                osVersion: '5.0',
                chipset: '',
                clientName: 'TVHTML5',
                dialAdditionalDataSupportLevel: 'unsupported',
                mdxDialServerType: 'MDX_DIAL_SERVER_TYPE_UNKNOWN',
                hasIdentityDifferentFromCurrent: false,
                switchableIdentitiesSuffix: ''
            }),
            RID: '9551',
            CVER: '1',
            zx: Date.now().toString(),
            t: '1'
        });
        
        const apiUrlWithQuery = `${youtubeApiUrl}?${params.toString()}`;
        console.log(`Forwarding request to YouTube API: ${apiUrlWithQuery}`);
        
        // Forward request
        const response = await axios.post(apiUrlWithQuery, req.body, {
            headers: {
                ...req.headers,
                Host: 'www.youtube.com',
            }
        });
        
        res.status(response.status).send(response.data);
    } catch (error) {
        console.error('Error forwarding request:', error.message);
        res.status(500).json({
            error: 'Failed to communicate with YouTube Lounge API',
            details: error.message,
        });
    }
});



// The 2016 client sends its OAuth bearer when the user paired an account.
function bearerOf(req) {
    const h = req.headers.authorization || req.headers.Authorization;
    if (!h || typeof h !== 'string') return null;
    return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Optional: a YouTube session cookie header, so the "For you" feed is built from
// the account's real history instead of degrading to a generic trending list.
// See back/exp_browse_api.js for where it is used and how it is filtered.
function ytCookieOf(req) {
    return req.headers['x-yt-cookie'] || null;
}

app.post('/api/browse', async (req, res) => {
    const { browseId } = req.body;

    if (!browseId) {
        return res.status(400).json({
            error: 'Missing browseId parameter in the request body.'
        });
    }

    try {
        const browseData = await fetchBrowseData(browseId, bearerOf(req), ytCookieOf(req));

        res.json(browseData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            error: error.message
        });
    }
});



async function handleGuideRequest(req, res) {
    console.log(`Received ${req.method} request for /api/guide`);


    const authHeader = req.headers['authorization'];
    const authToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    try {
        const guideData = await fetchGuideData(authToken);
        res.json(guideData);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}



app.get('/api/guide', handleGuideRequest);
app.post('/api/guide', handleGuideRequest);

app.post('/api/next', async (req, res) => {
    const { videoId } = req.body;

    if (typeof videoId !== 'string' || !videoId.trim()) {
        return res.status(400).json({
            error: '"videoId" is required and must be a non-empty string.'
        });
    }

    const authorizationHeader = req.headers['authorization'];
    const accessToken = authorizationHeader && authorizationHeader.startsWith('Bearer ') ? authorizationHeader.split(' ')[1] : null;

    try {
        const nextData = await fetchNextData(videoId, accessToken);

        res.json(nextData);
    } catch (error) {
        console.error('Error fetching next data:', error.message);

        res.status(500).json({
            error: 'Failed to fetch data from YouTube /next API.',
            details: error.message || 'No additional details available.'
        });
    }
});



app.post('/api/search', handleSearchRequest);


// Related videos for the endless ("chain") playback mode: InnerTube /next with a
// search fallback, see back/related_api.js. The client calls this when a video
// starts and walks the list when the video ends.
async function handleRelatedRequest(req, res) {
    const videoId = (req.query.videoId || req.query.id || req.params.videoId || '').toString().trim();
    if (!/^[\w-]{6,20}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid videoId is required.' });
    }
    try {
        const result = await fetchRelated(videoId, req.query.limit);
        res.json(result);
    } catch (error) {
        console.error('Error fetching related videos:', error.message);
        logger.error('related', 'request failed', { video_id: videoId, message: error.message });
        res.status(500).json({
            error: 'Failed to fetch related videos.',
            details: error.message,
        });
    }
}

app.get('/api/related', handleRelatedRequest);
app.get('/api/related/:videoId', handleRelatedRequest);


// Metadata for the watch screen: title, author and thumbnail.
//
// The 2016 client renders its own watch metadata from an InnerTube response shape
// that no longer exists, so the screen comes up with a black video and no title at
// all. Rather than trying to teach a 2016 renderer a 2025 payload, the player asks
// for the metadata itself and draws its own panel - the same split this project
// already uses for playback itself.
//
// Served from the yt-dlp metadata cache, so when the video is already playing (the
// normal case) this costs nothing and does not spawn a second yt-dlp run; the
// single-flight in getVideoInfoCached covers the case where both requests race.
function pickThumb(output, videoId) {
    const list = Array.isArray(output.thumbnails) ? output.thumbnails : [];
    let best = null;
    for (const t of list) {
        if (!t || !t.url) continue;
        // stay in the 16:9 range: hqdefault is a reliable fallback even when
        // yt-dlp reports nothing at all
        if (t.height && t.width && t.height / t.width > 0.6) continue;
        if (!best || Number(t.width || 0) > Number(best.width || 0)) best = t;
    }
    if (best && best.url) return String(best.url);
    if (output.thumbnail) return String(output.thumbnail);
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

app.get('/api/video-meta/:videoId', async (req, res) => {
    const videoId = String(req.params.videoId || '').trim();
    if (!/^[\w-]{6,20}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid videoId is required.' });
    }
    try {
        const output = await getVideoInfoCached(videoId);
        // res.json() is wrapped by the image proxy, so the thumbnail comes back
        // already rewritten to /img/... and the TV never talks to ytimg directly
        res.json({
            id: String(output.id || videoId),
            title: String(output.title || ''),
            author: String(output.uploader || output.channel || ''),
            channelId: String(output.channel_id || output.uploader_id || ''),
            duration: Number(output.duration) || 0,
            thumbnail: pickThumb(output, videoId),
            published: String(output.upload_date || ''),
        });
    } catch (error) {
        logger.error('video-meta', 'metadata lookup failed', {
            video_id: videoId,
            message: logger.truncateStderr(String(error.message || error)),
        });
        res.status(502).json({ error: 'Failed to load video metadata.' });
    }
});


process.on('unhandledRejection', (reason) => {
    logger.error('process', 'Unhandled promise rejection', {
        message: reason && reason.message ? String(reason.message) : String(reason),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 800) : undefined,
    });
});

process.on('uncaughtException', (err) => {
    logger.error('process', 'Uncaught exception', {
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack).slice(0, 800) : undefined,
        code: err && err.code ? String(err.code) : undefined,
    });
});

const mainServer = app.listen(port, bindAddr, () => {
    console.log(`Server running at http://` + serverIp + `:` + port);
});

mainServer.on('error', (err) => {
    logger.error('process', 'Server listen error', {
        message: err && err.message ? String(err.message) : String(err),
        code: err && err.code ? String(err.code) : undefined,
    });
    console.error(`Server error on :${port}:`, err && err.message ? err.message : err);
});
