const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Hosts whose images we relay through this backend so the browser never
// makes a direct request to YouTube's CDN.
const ALLOWED_HOSTS = new Set([
    'i.ytimg.com',
    'i1.ytimg.com',
    'i2.ytimg.com',
    'i3.ytimg.com',
    's.ytimg.com',
    'yt3.ggpht.com',
    'ggpht.com',
]);

const CACHE_DIR = path.join(__dirname, 'imgcache');

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function cacheKey(targetUrl) {
    return crypto.createHash('sha1').update(targetUrl).digest('hex');
}

// Turn an absolute YouTube CDN image URL into one served by our backend.
// Returns the original URL untouched when it is not on an allowed host.
function toProxyUrl(rawUrl, serverIp, port) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (e) {
        return rawUrl;
    }
    if (!ALLOWED_HOSTS.has(parsed.host)) {
        return rawUrl;
    }
    const origin = `http://${serverIp}:${port}`;
    return `${origin}/img/${parsed.host}${parsed.pathname}${parsed.search}`;
}

const HOST_PATTERN = '(i\\d?\\.ytimg\\.com|s\\.ytimg\\.com|yt3\\.ggpht\\.com|ggpht\\.com)';

// Literal forms: https://i.ytimg.com/..., //i1.ytimg.com/...
const LITERAL_RE = new RegExp('(?:https?:)?\\/\\/' + HOST_PATTERN + '(\\/[^\\s"\'<>]*)?', 'g');
// Percent-encoded forms used by the legacy form-encoded video info blob:
//   https%3A%2F%2Fi.ytimg.com%2F...
//   %2F%2Fi.ytimg.com%2F...
const ENCODED_RE = new RegExp('(?:https%3A%2F%2F|%2F%2F)' + HOST_PATTERN + '(%2F[^%\\s\'"&]*)?', 'g');

function rewriteString(str, ctx) {
    if (typeof str !== 'string' || !str) return str;

    // Fast path: the whole string is one URL.
    if (str.length < 2000 && /^https?:\/\//.test(str)) {
        const proxied = toProxyUrl(str, ctx.serverIp, ctx.port);
        if (proxied !== str) return proxied;
    }

    let out = str;

    out = out.replace(LITERAL_RE, (match, host, rest) => {
        return `${ctx.origin}/img/${host}${rest || ''}`;
    });

    out = out.replace(ENCODED_RE, (match, host, rest) => {
        let tail = rest || '';
        if (!tail.startsWith('%2F')) tail = '%2F' + tail;
        return `http%3A%2F%2F${encodeURIComponent(ctx.serverIp)}%3A${ctx.port}%2Fimg%2F${host}${tail}`;
    });

    return out;
}

function rewriteValue(value, ctx) {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            if (typeof value[i] === 'string') {
                value[i] = rewriteString(value[i], ctx);
            } else if (value[i] && typeof value[i] === 'object') {
                rewriteValue(value[i], ctx);
            }
        }
        return value;
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            const v = value[key];
            if (typeof v === 'string') {
                value[key] = rewriteString(v, ctx);
            } else if (v && typeof v === 'object') {
                rewriteValue(v, ctx);
            }
        }
        return value;
    }
    return value;
}

function serveFromCache(req, res, filePath, metaPath) {
    let meta;
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
        return null;
    }
    if (!fs.existsSync(filePath)) return null;

    res.setHeader('Content-Type', meta.contentType || 'image/jpeg');
    res.setHeader('Content-Length', meta.length);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
}

function downloadAndProxy(req, res, targetUrl, filePath, metaPath, ctx) {
    axios({
        method: 'GET',
        url: targetUrl,
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; 2016YouTubeTV/1.0)',
            'Accept': '*/*',
        },
        responseType: 'stream',
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
        timeout: 30000,
    }).then((upstream) => {
        const contentType = upstream.headers['content-type'] || 'image/jpeg';
        const tmpPath = filePath + '.tmp';

        const ws = fs.createWriteStream(tmpPath);
        upstream.data.pipe(ws);

        ws.on('finish', () => {
            const length = fs.statSync(tmpPath).size;
            fs.writeFileSync(metaPath, JSON.stringify({ contentType, length }));
            fs.renameSync(tmpPath, filePath);
            serveFromCache(req, res, filePath, metaPath);
        });
        ws.on('error', (err) => {
            console.error('[IMG] cache write error:', err.message);
            res.status(502).send('Image cache error');
        });
        upstream.data.on('error', (err) => {
            console.error('[IMG] upstream error:', targetUrl.slice(0, 120), err.message);
            if (!res.headersSent) {
                res.status(502).send('Failed to fetch image');
            } else {
                res.destroy();
            }
            try { fs.unlinkSync(tmpPath); } catch (e) { /* noop */ }
        });

        req.on('close', () => {
            if (!res.writableEnded) {
                upstream.data.destroy();
                try { fs.unlinkSync(tmpPath); } catch (e) { /* noop */ }
            }
        });
    }).catch((err) => {
        console.error('[IMG] fetch error:', targetUrl.slice(0, 120), err.message);
        if (!res.headersSent) {
            res.status(502).send('Failed to fetch image');
        }
    });
}

function buildTargetUrl(req) {
    const full = decodeURIComponent(req.originalUrl.replace(/^\/img\//, ''));
    const slash = full.indexOf('/');
    if (slash <= 0) return null;
    const host = full.slice(0, slash);
    if (!ALLOWED_HOSTS.has(host)) return null;
    const rest = full.slice(slash);
    if (!rest || rest === '/') return null;
    return `https://${host}${rest}`;
}

function installImageProxyRoutes(app, ctx) {
    ensureCacheDir();

    app.get('/img/*', (req, res) => {
        const targetUrl = buildTargetUrl(req);
        if (!targetUrl) {
            return res.status(400).send('Bad image proxy request');
        }

        const key = cacheKey(targetUrl);
        const filePath = path.join(CACHE_DIR, key);
        const metaPath = filePath + '.json';

        if (serveFromCache(req, res, filePath, metaPath)) {
            return;
        }

        downloadAndProxy(req, res, targetUrl, filePath, metaPath, ctx);
    });

    // Local favicon so the browser does not hit web.archive.org.
    app.get('/favicon.ico', (req, res) => {
        const faviconPath = path.join(__dirname, '..', 'assets', 'favicon.ico');
        fs.access(faviconPath, fs.constants.F_OK, (err) => {
            if (err) {
                return res.status(404).end();
            }
            res.setHeader('Content-Type', 'image/x-icon');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(faviconPath);
        });
    });

    // Rewrite every JSON response that leaves the backend so no image URL
    // points at YouTube's CDN.
    const originalJson = app.response.json;
    app.response.json = function rewrittenJson(body) {
        if (body && typeof body === 'object') {
            rewriteValue(body, ctx);
        } else if (typeof body === 'string') {
            body = rewriteString(body, ctx);
        }
        return originalJson.call(this, body);
    };
}

module.exports = {
    ALLOWED_HOSTS,
    toProxyUrl,
    rewriteString,
    rewriteValue,
    installImageProxyRoutes,
};