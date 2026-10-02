/*
 * Stored account token.
 *
 * The device flow in back/oauth_api_v3_api.js drops a
 * back/token/device_<code>_oauth_token.json for every account that paired. The TV
 * client sends its bearer on /api/guide and /api/browse, but plenty of clients
 * never send one at all, and those rows quietly fall back to the anonymous guide
 * with no Library, no uploads and no subscriptions. Rather than depend on the
 * client remembering, the newest saved token is picked up here.
 *
 * Those tokens live ~16 hours, so reading the file is not enough: an expired one
 * gets refreshed with the same client id/secret the 2016 client itself ships
 * (assets/app-prod.js, d.Wn/d.Zj), the response is written back over the same
 * file, and the next request sees a live token. Nothing here ever logs a token
 * value - only which file was used and when it runs out.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

const TOKEN_DIR = path.join(__dirname, 'token');
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// The 2016 TV app's own OAuth client. Its secret is not a secret: it ships in the
// client bundle, and a refresh needs the same pair the token was issued to.
const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';

// Refresh a little before the real expiry, so a request landing on the boundary
// does not go out with a token that dies in flight.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_MIN_GAP_MS = 60 * 1000;

let cached = null;            // { file, accessToken, expiresAt }
let lastAttemptAt = 0;
let refreshing = null;        // in-flight refresh, shared by concurrent callers

function tokenFiles() {
    try {
        return fs.readdirSync(TOKEN_DIR).filter(name => name.endsWith('_oauth_token.json'));
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            logger.warn('token', 'token dir unreadable', { message: logger.truncateStderr(String(err.message || err)) });
        }
        return [];
    }
}

/* Newest file wins: a device code can be paired more than once and the later file
   is the one that was refreshed last. */
function newestTokenFile() {
    let best = null;
    let bestAt = -1;
    for (const name of tokenFiles()) {
        const full = path.join(TOKEN_DIR, name);
        try {
            const mtime = fs.statSync(full).mtimeMs || 0;
            if (mtime > bestAt) {
                bestAt = mtime;
                best = full;
            }
        } catch (err) { /* file vanished mid-scan */ }
    }
    return best;
}

function readTokenFile(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
        const lifetime = Number(parsed.expires_in) || 0;
        let issuedAt = 0;
        try {
            // expires_in is relative to issue time; the file mtime is the closest
            // stand-in we have, since the device flow does not stamp one.
            issuedAt = fs.statSync(file).mtimeMs || Date.now();
        } catch (err) { issuedAt = Date.now(); }
        return {
            file,
            accessToken: parsed.access_token,
            refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
            expiresAt: lifetime > 0 ? issuedAt + lifetime * 1000 : 0,
        };
    } catch (err) {
        logger.warn('token', 'token file unreadable', { message: logger.truncateStderr(String(err.message || err)) });
        return null;
    }
}

function logState(level, message, file, token, extra) {
    logger[level]('token', message, {
        file: file ? path.basename(file) : null,
        expires_at: token && token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
        has_refresh_token: !!(token && token.refreshToken),
        ...extra,
    });
}

async function refreshToken(token) {
    if (!token || !token.refreshToken) return null;
    const response = await axios.post(OAUTH_TOKEN_URL, null, {
        params: {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            refresh_token: token.refreshToken,
            grant_type: 'refresh_token',
        },
        timeout: 20000,
    });
    const data = response.data || {};
    if (!data.access_token) throw new Error('refresh response had no access_token');

    const lifetime = Number(data.expires_in) || 0;
    const now = Date.now();
    const saved = {
        access_token: data.access_token,
        expires_in: lifetime,
        token_type: data.token_type || 'Bearer',
        refresh_token: data.refresh_token || token.refreshToken,
    };
    // Same path, so the next start finds the fresh one first.
    fs.writeFileSync(token.file, JSON.stringify(saved, null, 2), 'utf8');

    return {
        file: token.file,
        accessToken: data.access_token,
        refreshToken: saved.refresh_token,
        expiresAt: lifetime > 0 ? now + lifetime * 1000 : 0,
    };
}

/*
 * Load the newest saved token, refreshing it when it is inside the expiry margin.
 * Concurrent callers share one refresh instead of racing to write the same file.
 */
async function load({ force = false } = {}) {
    const file = newestTokenFile();
    if (!file) {
        cached = null;
        return null;
    }
    if (cached && cached.file === file && !force) {
        const stillFresh = cached.expiresAt === 0 || cached.expiresAt - REFRESH_MARGIN_MS > Date.now();
        if (stillFresh) return cached;
    }

    const token = readTokenFile(file);
    if (!token) return null;

    const expired = token.expiresAt > 0 && token.expiresAt - REFRESH_MARGIN_MS <= Date.now();
    if (!expired) {
        cached = token;
        logState('info', 'using stored token', file, token);
        return cached;
    }

    if (refreshing) return refreshing;

    refreshing = (async () => {
        try {
            const fresh = await refreshToken(token);
            cached = fresh;
            logState('info', 'stored token refreshed', fresh.file, fresh);
            return fresh;
        } catch (err) {
            logger.warn('token', 'stored token refresh failed', {
                file: path.basename(token.file),
                status: err.response ? err.response.status : undefined,
                message: logger.truncateStderr(String(err.message || err)),
            });
            // An expired token is still better than none for endpoints that only
            // use it as a hint, but it must not be cached as a live one.
            cached = token;
            return token;
        } finally {
            refreshing = null;
            lastAttemptAt = Date.now();
        }
    })();

    return refreshing;
}

/*
 * Synchronous accessor: the token cached from a previous load, or a direct read
 * of the newest file when nothing was loaded yet. A refresh, when needed, is
 * started in the background and picked up by the next request.
 */
function getAccessToken() {
    if (cached && (cached.expiresAt === 0 || cached.expiresAt - REFRESH_MARGIN_MS > Date.now())) {
        return cached.accessToken;
    }
    const now = Date.now();
    if (!refreshing && now - lastAttemptAt > REFRESH_MIN_GAP_MS) {
        lastAttemptAt = now;
        void load();
    }
    if (cached) return cached.accessToken;
    const file = newestTokenFile();
    const token = file ? readTokenFile(file) : null;
    if (token) cached = token;
    return token ? token.accessToken : null;
}

function isStale() {
    return !!(cached && cached.expiresAt > 0 && cached.expiresAt - REFRESH_MARGIN_MS <= Date.now());
}

/*
 * Resolve the stored token before the server takes traffic, so the very first
 * request never goes out with a stale bearer. Bounded on purpose: a slow or
 * unreachable token endpoint must not keep the whole app down, so on timeout we
 * continue with whatever is cached (possibly nothing) and the background loop
 * keeps trying.
 *
 * The timeout timer is deliberately not unref'd: at this point nothing else is
 * keeping the event loop alive (the listener has not been created yet).
 */
async function prepare({ timeoutMs = 15000 } = {}) {
    if (!newestTokenFile()) return null;
    let timer = null;
    try {
        return await Promise.race([
            load(),
            new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function startBackgroundRefresh() {
    // Idempotent: prepare() normally already loaded, so this is a cache hit.
    void load();
    const timer = setInterval(() => {
        if (isStale()) void load();
    }, REFRESH_INTERVAL_MS);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { getAccessToken, load, prepare, startBackgroundRefresh };
