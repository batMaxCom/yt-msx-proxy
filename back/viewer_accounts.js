/*
 * Viewer accounts: sign-in, and the identity everything else keys on.
 *
 * Why this exists
 * ---------------
 * The watch journal used to be keyed by a profile id the client supplied. That
 * is not an identity: the id travelled in a cookie, anyone could name any id,
 * and "default" was one shared bucket on a public host. So the journal is off
 * (see the ENABLED switch in back/history_store.js) and waits for a key the
 * server can verify.
 *
 * The key is the Google account's `sub` from the userinfo endpoint, obtained
 * through an OAuth token. Not the email: it can change, and it is personal data
 * we have no use for. Not the YouTube channel id either - an account may have
 * no channel at all, which is exactly the case that made channels.list come back
 * empty during testing. `sub` exists for every Google account and never moves.
 *
 * Two APIs, two jobs
 * ------------------
 * The official Data API v3 supplies identity and the subscription list. It is
 * metered (10k units/day by default) but those calls are cheap: userinfo and
 * channels.list are 1 unit, subscriptions.list is 1 unit per 50 channels.
 * Video content comes from InnerTube, which is not metered and is what this
 * whole project already talks to. Nothing here fetches videos.
 *
 * Token handling
 * --------------
 * Our client secret never leaves the server: it is read from
 * back/viewer_auth.env (gitignored, excluded from the Docker build context) or
 * the environment, and it is never sent to a browser and never logged.
 *
 * A refresh token per account is written to back/accounts/<sub>.json with mode
 * 600, because it is a long-lived credential for that person's account. The
 * access token stays in memory only - it lives an hour and is re-minted from
 * the refresh token.
 *
 * Browsers get a signed session cookie rather than the token itself, for the
 * same reason: a 60 minute access token in localStorage is a token in
 * localStorage. The cookie is HttpOnly, so script cannot read it, and it is
 * verified with HMAC on every request.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const logger = require('./logger');

const ACCOUNT_DIR = path.join(__dirname, 'accounts');
const SECRET_FILE = path.join(ACCOUNT_DIR, '.session_secret');
const ENV_FILE = path.join(__dirname, 'viewer_auth.env');

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// openidconnect, not oauthinfo/userinfo: those two hosts 404 on this path. With
// no token the correct host answers 401, which is the signature of a live
// endpoint - a 404 here means a typo, not a missing credential.
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/*
 * One sign-in, one scope, and it is the full one.
 *
 * This was youtube.readonly while the 2016 bundle kept its own client: the Data
 * API calls here needed nothing more. That is no longer the shape - token_store.js
 * now serves *this* token to every InnerTube request the TV makes, so the bearer
 * out on browse/guide/next has to carry whatever those need, which is the whole
 * account rather than a read-only slice.
 *
 * youtube.force-ssl is the tidier name and is what the desktop clients ask for,
 * but Google refuses it here:
 *   400 invalid_scope "Invalid device flow scope: ...youtube.force-ssl"
 * That is a property of the device flow, not of this client, and it is not
 * negotiable from here. The full https://www.googleapis.com/auth/youtube scope is
 * the same access with a name the device endpoint accepts, and it also covers the
 * identity lookups and subscriptions.list on top of playback.
 */
const SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/youtube',
];

// Google's own device code lifetime, used only as a ceiling. The value it hands
// back in expires_in is authoritative - clamping to something shorter than Google
// does just makes a code that still works look dead to whoever is entering it.
const DEVICE_CODE_TTL_SEC = 30 * 60;

// Refresh a little early so a request landing on the boundary does not go out
// with a token that dies in flight.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = 'yt_sess';

let config = null;
let sessionSecret = null;

// sub -> { accessToken, refreshToken, expiresAt }
const tokenCache = new Map();

// sub -> in-flight refresh promise. Without this, two concurrent requests for
// the same account both refresh, and both write back through the same
// `<sub>.json.<pid>.tmp` name - one write lands on the other's temp file.
const refreshingBySub = new Map();

/* ---- configuration ------------------------------------------------------ */

// Parse the KEY=value env file. Quoting and `export` are both tolerated because
// this is a file people edit by hand.
function parseEnvFile(text) {
    const out = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trim();
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
            (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
            value = value.slice(1, -1);
        }
        if (key) out[key] = value;
    }
    return out;
}

/*
 * Credentials live in the environment first so a container can inject them
 * without a file on disk at all, and fall back to back/viewer_auth.env for a
 * plain checkout. Missing config is not fatal at require time - the server still
 * has to start and serve anonymous viewers - so this reports rather than throws.
 */
function loadConfig() {
    if (config) return config;
    let fileValues = {};
    try {
        fileValues = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            logger.warn('accounts', 'env file unreadable', {
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
    }
    config = {
        clientId: process.env.YT_VIEWER_CLIENT_ID || fileValues.YT_VIEWER_CLIENT_ID || '',
        clientSecret: process.env.YT_VIEWER_CLIENT_SECRET || fileValues.YT_VIEWER_CLIENT_SECRET || '',
        scope: process.env.YT_VIEWER_SCOPE || fileValues.YT_VIEWER_SCOPE || '',
    };

    // openid is not a preference, it is the requirement: it is what makes the
    // userinfo endpoint return `sub`, and `sub` is the key everything else uses.
    // An env-supplied scope list therefore *adds* to the defaults instead of
    // replacing them - a stale env file that names only youtube.readonly must not
    // be able to quietly strip the identity scope.
    const extras = String(config.scope || '').split(/\s+/).filter(Boolean);
    config.scope = Array.from(new Set([...SCOPES, ...extras])).join(' ');

    config.ready = !!(config.clientId && config.clientSecret);
    if (!config.ready) {
        logger.warn('accounts', 'viewer sign-in is not configured', {
            hint: 'set YT_VIEWER_CLIENT_ID and YT_VIEWER_CLIENT_SECRET',
            env_file_present: fs.existsSync(ENV_FILE),
        });
    }
    return config;
}

/* ---- account files ------------------------------------------------------ */

// `sub` is digits from Google, but it comes from the network, so it is checked
// before it is ever used as a path segment.
function isValidSub(sub) {
    return typeof sub === 'string' && /^[0-9]{6,32}$/.test(sub);
}

function accountPath(sub) {
    return path.join(ACCOUNT_DIR, `${sub}.json`);
}

function ensureAccountDir() {
    fs.mkdirSync(ACCOUNT_DIR, { recursive: true, mode: 0o700 });
}

function saveAccount(sub, data) {
    if (!isValidSub(sub)) throw new Error('refusing to write an account for an invalid sub');
    ensureAccountDir();
    const file = accountPath(sub);
    const payload = JSON.stringify(data, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    // 600 on the temp file, and the rename carries the mode over, so the
    // refresh token is never briefly world-readable.
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
}

function loadAccount(sub) {
    try {
        const parsed = JSON.parse(fs.readFileSync(accountPath(sub), 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            logger.warn('accounts', 'account file unreadable', {
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
        return null;
    }
}

/* ---- session signing ---------------------------------------------------- */

/*
 * A signing key generated on first boot. Tied to the account directory so it
 * lives in the same volume as the accounts: a fresh volume means every session
 * cookie is rejected, which is the safe direction.
 */
function loadSessionSecret() {
    if (sessionSecret) return sessionSecret;
    try {
        const existing = fs.readFileSync(SECRET_FILE);
        if (existing && existing.length >= 32) {
            sessionSecret = existing;
            return sessionSecret;
        }
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            logger.warn('accounts', 'session secret unreadable', {
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
    }
    ensureAccountDir();
    sessionSecret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, sessionSecret, { mode: 0o600 });
    try { fs.chmodSync(SECRET_FILE, 0o600); } catch (err) { /* best effort */ }
    logger.info('accounts', 'generated a new session signing key');
    return sessionSecret;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/*
 * The cookie carries the account id and nothing else: no token, no email, no
 * display name. It is authenticated, not encrypted - a viewer can read their
 * own sub, which is not a secret to them, but nobody else can mint one.
 */
/*
 * Cookies are only checked for a valid signature, which by itself means a signed
 * cookie stays good for its whole 30 day TTL no matter what the user does
 * afterwards. So "sign out" has to actively invalidate, not just clear the
 * browser: each sub carries the timestamp of its newest sign-out, and any
 * session issued at or before that moment is dead on arrival.
 */
const signedOutAt = new Map();

function revokeSessionsFor(sub, now) {
    // Stamped one millisecond ahead of the real instant so that a session minted
    // in the same millisecond as the sign-out - a login racing a logout, or a
    // retry - is not judged as already revoked. Strict > on the comparison is
    // what keeps "sign in again" working.
    signedOutAt.set(sub, Math.max(signedOutAt.get(sub) || 0, (now || Date.now()) + 1));
}

function sessionsRevokedAfter(sub, issuedAt) {
    return (signedOutAt.get(sub) || 0) > issuedAt;
}

function signSession(sub, issuedAt) {
    const payload = b64url(JSON.stringify({ s: sub, t: issuedAt }));
    const sig = b64url(crypto.createHmac('sha256', loadSessionSecret()).update(payload).digest());
    return `${payload}.${sig}`;
}

function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(crypto.createHmac('sha256', loadSessionSecret()).update(payload).digest());
    // Constant-time compare so a wrong signature cannot be refined byte by byte.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data;
    try {
        data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    } catch (err) {
        return null;
    }
    if (!data || !isValidSub(data.s)) return null;
    const issuedAt = Number(data.t) || 0;
    if (!issuedAt || Date.now() - issuedAt > SESSION_TTL_MS) return null;
    // Signature is intact but the cookie was minted before this sub signed out.
    if (sessionsRevokedAfter(data.s, issuedAt)) return null;
    return data.s;
}

function sessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`;
}

function clearedSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/*
 * End whatever viewer session a Cookie header carries, and report which account it
 * belonged to ('' if there was none, or if it did not verify).
 *
 * There are two sign-outs in this app and only one of them is ours. /api/auth/logout
 * is a viewer route and can call anything it likes; the bundle's own Settings
 * sign-out speaks OAuth and never touches /api/*, so the only place it can reach us
 * is the revoke endpoint. Without this, a sign-out from the native menu drops the
 * bearer the bundle was holding and leaves yt_sess standing - the set looks signed
 * out while the server keeps filing watch time under an account that has left.
 *
 * signOutLocalOnly rather than signOut: a client signing itself out should not
 * destroy the grant it is holding, or the next sign-in needs a whole new device
 * flow. Revoking the grant stays an explicit choice behind /api/auth/logout.
 */
function endSessionFromCookieHeader(cookieHeader) {
    if (!cookieHeader || typeof cookieHeader !== 'string') return '';
    const needle = `${SESSION_COOKIE}=`;
    for (const part of cookieHeader.split(';')) {
        const trimmed = part.trim();
        if (trimmed.indexOf(needle) !== 0) continue;
        let raw = '';
        try {
            raw = decodeURIComponent(trimmed.slice(needle.length));
        } catch (e) {
            raw = trimmed.slice(needle.length);
        }
        const sub = verifySession(raw);
        if (!sub) return '';
        signOutLocalOnly(sub);
        return sub;
    }
    return '';
}

/* ---- device flow -------------------------------------------------------- */

/*
 * Step 1. The device code itself never reaches storage - it lives in this
 * process for the length of one sign-in, and the user_code is what a person
 * types on another device.
 */
async function startSignIn() {
    const cfg = loadConfig();
    if (!cfg.ready) {
        const err = new Error('viewer sign-in is not configured on this server');
        err.status = 503;
        throw err;
    }

    const response = await axios.post(DEVICE_CODE_URL, null, {
        params: { client_id: cfg.clientId, scope: cfg.scope },
        timeout: 20000,
    });
    const data = response.data || {};
    if (!data.device_code || !data.user_code) {
        throw new Error('device code response was incomplete');
    }

    logger.info('accounts', 'device code issued', {
        client_id: cfg.clientId,
        expires_in: Number(data.expires_in) || 0,
        scope: cfg.scope,
    });

    const lifetimeSec = Math.min(Number(data.expires_in) || DEVICE_CODE_TTL_SEC, DEVICE_CODE_TTL_SEC);
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUrl: data.verification_url,
        interval: Math.max(1, Number(data.interval) || 5),
        expiresAt: Date.now() + lifetimeSec * 1000,
    };
}

/*
 * Adopt a token pair that something else already exchanged.
 *
 * The 2016 bundle runs its own device flow against /o/oauth2/device/code and
 * /o/oauth2/token, and that route already handles Google's 428/slow_down polling
 * grammar. Re-implementing a second poll loop here would duplicate that logic and
 * give it two chances to drift, so the server exchanges first and hands the
 * result over.
 *
 * What it returns is the identity, so the caller can mint a session. Failing to
 * identify is deliberately not fatal: the bundle needs a bearer to keep playing,
 * and a TV that plays without a name beats a sign-in dialog that errors out.
 */
/*
 * Two scope lists, and the difference between them is the whole point.
 *
 * `scopes` is the widest grant this account has ever been issued - merged, never
 * narrowed, because Google's device flow does not report granted scopes
 * consistently: the same consent screen asking for "openid youtube" came back as
 * both, then as openid alone, on consecutive sign-ins. Narrowing the stored list on
 * one short answer would be permanent, since the narrower refresh token replaces
 * the wider one.
 *
 * `granted_scopes` is what the token in hand can actually do right now, and it is
 * the only one of the two that may be replaced. It is read from Google's own
 * response, never inferred from what was requested. This is what `has_youtube`
 * reports: YouTube answers a request made with an openid-only bearer with
 * "403 insufficient authentication scopes", so a stored-but-ungranted youtube
 * scope is not a near miss, it is the exact reason the app's tabs stay anonymous
 * while Settings insists the viewer is signed in.
 */
function mergeScopes(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        for (const raw of list || []) {
            const scope = String(raw || '').trim();
            if (!scope || seen.has(scope)) continue;
            seen.add(scope);
            out.push(scope);
        }
    }
    return out;
}

async function adoptExchangedToken(data) {
    if (!data || !data.access_token) {
        const e = new Error('token response had no access_token');
        e.status = 502;
        throw e;
    }

    const now = Date.now();
    const lifetime = Number(data.expires_in) || 0;
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';

    // The access token is cached against the account, so identify first. A viewer
    // whose userinfo lookup fails still gets a working TV.
    let identity = null;
    try {
        identity = await resolveIdentity(data.access_token, data.scope);
    } catch (err) {
        logger.warn('accounts', 'token adopted without an identity', {
            status: err.response ? err.response.status : undefined,
            reason: logger.truncateStderr(String(err.message || err)),
        });
    }

    if (identity) {
        tokenCache.set(identity.sub, {
            accessToken: data.access_token,
            refreshToken,
            expiresAt: lifetime > 0 ? now + lifetime * 1000 : 0,
        });
    }

    if (identity && refreshToken) {
        const existing = loadAccount(identity.sub) || {};
        const cfg = loadConfig();
        const requested = String(cfg.scope || '').split(/\s+/).filter(Boolean);
        const granted = identity.scopes || [];
        const scopes = mergeScopes(existing.scopes, granted, requested);
        const missing = requested.filter((scope) => !granted.includes(scope));
        if (missing.length) {
            // Loud on purpose: a grant that came back short is the difference
            // between a working TV and one that cannot reach the Data API.
            logger.warn('accounts', 'exchange granted fewer scopes than requested', {
                sub: identity.sub,
                requested,
                granted,
                missing,
            });
        }
        saveAccount(identity.sub, {
            sub: identity.sub,
            refresh_token: refreshToken,
            channel_id: identity.channelId || existing.channel_id || '',
            name: identity.name || existing.name || '',
            avatar: identity.avatar || existing.avatar || '',
            scopes,
            // What this token can do now. Google answered, so this is a fact and
            // not a guess - and it is allowed to shrink when the grant shrinks.
            granted_scopes: mergeScopes(granted),
            created_at: existing.created_at || new Date(now).toISOString(),
            last_seen_at: new Date(now).toISOString(),
        });
    }

    logger.info('accounts', 'adopted exchanged token', {
        sub: identity ? identity.sub : null,
        scopes: identity ? mergeScopes(identity.scopes) : null,
        expires_in: lifetime,
        stored_refresh_token: !!(identity && refreshToken),
    });

    return identity;
}

/*
 * Who is this? `sub` is the answer and the only required field. Name and avatar
 * are for the UI. The channel is a bonus: an account may not have one, and its
 * absence must not fail the sign-in.
 */
async function resolveIdentity(accessToken, grantedScopes) {
    const headers = { Authorization: `Bearer ${accessToken}` };

    const userinfo = await axios.get(USERINFO_URL, { headers, timeout: 20000 }).catch(err => {
        const status = err.response ? err.response.status : undefined;
        // 401 means the token is not accepted here (wrong audience, revoked,
        // clock skew). 404 means this host+path does not exist, which is a bug in
        // the URL above rather than anything about the person signing in. They
        // need telling apart, because only one of them is worth retrying.
        logger.warn('accounts', 'userinfo lookup failed', {
            status,
            url: USERINFO_URL,
            detail: logger.truncateStderr(String((err.response && err.response.data && err.response.data.error_description) || err.message || err)),
        });
        const e = new Error('userinfo lookup failed');
        e.status = status === 404 ? 500 : 502;
        throw e;
    });
    const info = userinfo.data || {};
    if (!isValidSub(info.sub)) {
        const err = new Error('userinfo returned no usable sub');
        err.status = 502;
        throw err;
    }

    let name = typeof info.name === 'string' ? info.name.slice(0, 120) : '';
    let avatar = typeof info.picture === 'string' ? info.picture.slice(0, 600) : '';
    let channelId = '';

    // A channel is optional, so a failure here is a missing nicety rather than a
    // failed sign-in. The scopes we asked for cover it either way.
    try {
        const response = await axios.get(CHANNELS_URL, {
            headers,
            params: {
                part: 'snippet,contentDetails',
                mine: true,
                maxResults: 1,
            },
            timeout: 20000,
        });
        const items = (response.data && response.data.items) || [];
        if (items.length) {
            const channel = items[0];
            channelId = typeof channel.id === 'string' && /^UC[\w-]{22}$/.test(channel.id) ? channel.id : '';
            if (!name && channel.snippet && channel.snippet.title) name = String(channel.snippet.title).slice(0, 120);
            if (!avatar && channel.snippet && channel.snippet.thumbnails) {
                const thumbs = channel.snippet.thumbnails;
                const pick = thumbs.default || thumbs.medium || thumbs.high;
                if (pick && pick.url) avatar = String(pick.url).slice(0, 600);
            }
        }
    } catch (err) {
        logger.info('accounts', 'no channel for this account', {
            sub: info.sub,
            status: err.response ? err.response.status : undefined,
        });
    }

    // userinfo is NOT the source of truth for scopes. It returns `scope` only
    // sometimes - with this client it comes back absent, which is how an account
    // holding a full youtube grant was recorded as having none, and has_youtube in
    // the public profile answered false. The token response does carry the granted
    // scopes, so the caller passes them in and userinfo is only a fallback.
    const granted = typeof grantedScopes === 'string' && grantedScopes
        ? grantedScopes.split(' ').filter(Boolean)
        : (typeof info.scope === 'string' ? info.scope.split(' ').filter(Boolean) : []);
    return { sub: info.sub, name, avatar, channelId, scopes: granted };
}

/* ---- token upkeep ------------------------------------------------------- */

async function refreshAccount(sub) {
    const stored = loadAccount(sub);
    if (!stored || !stored.refresh_token) {
        tokenCache.delete(sub);
        return null;
    }
    const cfg = loadConfig();
    if (!cfg.ready) return null;

    const response = await axios.post(TOKEN_URL, null, {
        params: {
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: stored.refresh_token,
            grant_type: 'refresh_token',
        },
        timeout: 20000,
    });
    const data = response.data || {};
    if (!data.access_token) throw new Error('refresh response had no access_token');

    const lifetime = Number(data.expires_in) || 0;
    const entry = {
        accessToken: data.access_token,
        // Google only sends a new refresh token when the old one is revoked, so
        // keeping the stored one is correct rather than lazy.
        refreshToken: typeof data.refresh_token === 'string' && data.refresh_token
            ? data.refresh_token
            : stored.refresh_token,
        expiresAt: lifetime > 0 ? Date.now() + lifetime * 1000 : 0,
    };
    tokenCache.set(sub, entry);

    stored.last_seen_at = new Date().toISOString();
    if (entry.refreshToken !== stored.refresh_token) stored.refresh_token = entry.refresh_token;
    // A refresh response may omit scopes or report them short, so it widens the
    // stored list and never trims it - see mergeScopes. An account stored before
    // scopes were read from the right source still gets corrected here.
    const granted = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
    const merged = mergeScopes(stored.scopes, granted);
    if (granted.length && JSON.stringify(merged) !== JSON.stringify(stored.scopes || [])) {
        logger.info('accounts', 'granted scopes widened on refresh', {
            sub,
            scopes: merged,
            previous: stored.scopes || [],
        });
        stored.scopes = merged;
    }
    // A refresh is the cheapest place there is to learn what the live token can
    // actually do, because Google puts the answer in every response. Keep it, so
    // has_youtube stops reporting a scope the account requested once and may
    // never have been granted.
    if (granted.length && JSON.stringify(granted) !== JSON.stringify(stored.granted_scopes || null)) {
        logger.info('accounts', 'live token scopes recorded', {
            sub,
            granted,
            previous: stored.granted_scopes || null,
        });
        stored.granted_scopes = granted;
    }
    saveAccount(sub, stored);

    logger.info('accounts', 'access token refreshed', {
        sub,
        has_refresh_token: !!entry.refreshToken,
        expires_in: lifetime,
    });
    return entry;
}

/*
 * A live access token for an account, re-minting it when it is close to expiry.
 * Concurrent callers share one refresh instead of racing to write the same file.
 */
async function accessTokenFor(sub) {
    if (!isValidSub(sub)) return null;
    const cached = tokenCache.get(sub);
    if (cached && (cached.expiresAt === 0 || cached.expiresAt - REFRESH_MARGIN_MS > Date.now())) {
        return cached.accessToken;
    }

    // One refresh per account at a time, shared by everything waiting on it.
    let pending = refreshingBySub.get(sub);
    if (!pending) {
        pending = (async () => {
            try {
                const fresh = await refreshAccount(sub);
                if (fresh) return fresh.accessToken;
                tokenCache.delete(sub);
                return null;
            } catch (err) {
                logger.warn('accounts', 'token refresh failed', {
                    sub,
                    status: err.response ? err.response.status : undefined,
                    reason: logger.truncateStderr(String(err.message || err)),
                });
                // An expired token is still better than none for endpoints that
                // only use it as a hint, but it must not be cached as a live one.
                tokenCache.delete(sub);
                return null;
            } finally {
                refreshingBySub.delete(sub);
            }
        })();
        refreshingBySub.set(sub, pending);
    }
    return pending;
}

/*
 * The cached access token for an account, without any network call.
 *
 * server.js resolves the bearer synchronously on the request path, so it cannot
 * await accessTokenFor. This answers the only question that can be answered from
 * memory - "do we already hold a live token for this sub" - and returns null
 * otherwise, including when the token is close enough to expiry that the caller
 * should trigger a refresh instead.
 */
function cachedAccessTokenFor(sub) {
    if (!isValidSub(sub)) return null;
    const cached = tokenCache.get(sub);
    if (!cached) return null;
    if (cached.expiresAt > 0 && cached.expiresAt - REFRESH_MARGIN_MS <= Date.now()) return null;
    return cached.accessToken;
}

/* ---- viewer-facing API -------------------------------------------------- */

// Public shape for the UI. No tokens, no scopes beyond a boolean.
function publicProfile(sub, meta) {
    if (!sub) return { signed_in: false };
    const stored = loadAccount(sub) || {};

    // What the account asked for, and what the token in hand can actually do.
    const requested = (meta && meta.scopes) || stored.scopes || [];
    // An account written before granted_scopes existed has no reading yet, so fall
    // back to the requested list rather than accusing a healthy grant of being
    // broken. The next refresh - which whoami already awaits - fills it in.
    const granted = (meta && meta.grantedScopes) || stored.granted_scopes || requested;
    const hasYoutube = [granted].some((l) => l.some((s) => /youtube/.test(s)));
    const wantsYoutube = [requested].some((l) => l.some((s) => /youtube/.test(s)));

    return {
        signed_in: true,
        sub,
        name: (meta && meta.name) || stored.name || '',
        avatar: (meta && meta.avatar) || stored.avatar || '',
        channel_id: (meta && meta.channelId) || stored.channel_id || '',
        has_channel: !!((meta && meta.channelId) || stored.channel_id),
        has_youtube: hasYoutube,
        /*
         * Signed in, but Google never handed over the YouTube scope. Worth saying
         * out loud, because the symptom otherwise reads as an app bug: the viewer
         * is signed in, Settings says so, and yet YouTube answers every data call
         * with "403 insufficient authentication scopes" and the app's own tabs stay
         * anonymous. Only another consent screen can fix that, so say that instead
         * of leaving the person to guess.
         */
        needs_youtube_consent: !hasYoutube && wantsYoutube,
        last_seen_at: stored.last_seen_at || null,
    };
}

async function signOut(sub) {
    if (!isValidSub(sub)) return false;
    // Drop the access token, then tell Google to kill the refresh token too, so
    // signing out of this app also ends the grant the user consented to.
    const cached = tokenCache.get(sub);
    const refreshToken = cached && cached.refreshToken
        ? cached.refreshToken
        : (loadAccount(sub) || {}).refresh_token;
    tokenCache.delete(sub);
    revokeSessionsFor(sub);

    try {
        fs.unlinkSync(accountPath(sub));
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            logger.warn('accounts', 'account file remove failed', {
                sub,
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
    }

    if (refreshToken) {
        try {
            await axios.post(REVOKE_URL, null, { params: { token: refreshToken }, timeout: 15000 });
            logger.info('accounts', 'grant revoked at Google', { sub });
        } catch (err) {
            // The local record is gone either way; a failed revoke means the
            // grant stays live until the user removes it from their Google
            // account, which is worth saying out loud.
            logger.warn('accounts', 'revoke at Google failed', {
                sub,
                status: err.response ? err.response.status : undefined,
            });
        }
    }
    logger.info('accounts', 'viewer signed out', { sub });
    return true;
}

// Unlink the session from a browser without giving up the grant.
function signOutLocalOnly(sub) {
    if (!isValidSub(sub)) return false;
    tokenCache.delete(sub);
    revokeSessionsFor(sub);
    return true;
}

function isConfigured() {
    return loadConfig().ready;
}

module.exports = {
    SESSION_COOKIE,
    SCOPES,
    SESSION_TTL_MS,
    isConfigured,
    loadConfig,
    startSignIn,
    adoptExchangedToken,
    resolveIdentity,
    accessTokenFor,
    cachedAccessTokenFor,
    verifySession,
    signSession,
    revokeSessionsFor,
    endSessionFromCookieHeader,
    sessionsRevokedAfter,
    sessionCookie,
    clearedSessionCookie,
    publicProfile,
    signOut,
    signOutLocalOnly,
    loadAccount,
    isValidSub,
};