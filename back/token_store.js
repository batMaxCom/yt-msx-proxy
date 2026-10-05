/*
 * The bearer the TV plays as.
 *
 * One sign-in, one token. The viewer authorises once through
 * back/viewer_accounts.js; the refresh token lives in back/accounts/<sub>.json and
 * the access token handed to InnerTube on every browse/guide/next comes from here,
 * with the same scopes and the same refresh as the account itself. server.js calls
 * getAccessToken() synchronously from the request path, so the old shape is kept
 * even though the source of the token is now ours rather than the 2016 bundle's.
 *
 * Nothing here logs a token value - only which account was used and when its
 * token runs out.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const viewerAccounts = require('./viewer_accounts');

const ACCOUNT_DIR = path.join(__dirname, 'accounts');

/*
 * One token store for the whole TV, fed by one sign-in.
 *
 * This used to read whatever the 2016 bundle's own OAuth client had left in
 * back/token/, which meant the app had two identities: one for playing (the
 * bundle's) and one for the journal (ours). Every video request rode on a token
 * that had nothing to do with the signed-in viewer, and a viewer could be
 * recognised while the TV played as somebody else's idea of what to show.
 *
 * Now there is one grant. The viewer signs in once, the refresh token lives in
 * back/accounts/<sub>.json, and the bearer handed to InnerTube comes from here -
 * the same account, the same scopes, the same refresh. token_store keeps its old
 * name and synchronous getAccessToken() shape because server.js calls it from the
 * request path, but what it hands out comes from viewer_accounts.
 *
 * Which account? A TV is shared by whoever is watching it, so there is one
 * "current" account rather than one per request. It is the most recently signed
 * in or most recently refreshed, which is what a person stepping up to the set
 * expects. Per-request identity still comes from the session cookie elsewhere;
 * this is only the bearer.
 */

// Refresh a little before the real expiry, so a request landing on the boundary
// does not go out with a token that dies in flight.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_MIN_GAP_MS = 60 * 1000;

let cached = null;            // { sub, accessToken, expiresAt }
let lastAttemptAt = 0;
let refreshing = null;        // in-flight refresh, shared by concurrent callers

/*
 * Which stored account is the TV playing as.
 *
 * Newest mtime wins. signSession and refreshAccount both touch the file, so mtime
 * means "most recently the active account" rather than merely "created first" -
 * stepping up to a set after a different viewer used it picks the right bearer.
 * There is deliberately no "first" account pinned at import: a shared TV should
 * follow whoever used it last, and the journal below keeps per-sub rows regardless.
 */
function currentAccountFile() {
    let names = [];
    try {
        names = fs.readdirSync(ACCOUNT_DIR).filter(name => /^[0-9]{6,32}\.json$/.test(name));
    } catch (err) {
        if (!err || err.code !== 'ENOENT') {
            logger.warn('token', 'account dir unreadable', { message: logger.truncateStderr(String(err.message || err)) });
        }
        return null;
    }
    let best = null;
    let bestAt = -1;
    for (const name of names) {
        const full = path.join(ACCOUNT_DIR, name);
        try {
            const mtime = fs.statSync(full).mtimeMs || 0;
            if (mtime > bestAt) { bestAt = mtime; best = full; }
        } catch (err) { /* file vanished mid-scan */ }
    }
    return best;
}

function subOfFile(file) {
    return file ? path.basename(file, '.json') : '';
}

function logState(level, message, file, token, extra) {
    logger[level]('token', message, {
        file: file ? path.basename(file) : null,
        expires_at: token && token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
        has_refresh_token: !!(token && token.refreshToken),
        ...extra,
    });
}

/*
 * Mint an access token for an account.
 *
 * viewer_accounts owns the credentials and already does this: it holds the
 * refresh token per sub, collapses concurrent refreshes into one, writes the
 * account file back, and logs without ever printing a token. Doing it again here
 * would mean a second copy of the refresh logic and a second place for it to be
 * wrong, so this only asks.
 */
async function refreshToken(sub) {
    const accessToken = await viewerAccounts.accessTokenFor(sub);
    return accessToken ? { sub, accessToken, expiresAt: 0 } : null;
}

/*
 * Resolve the current account's bearer, refreshing if the cached one is inside
 * the expiry margin. Concurrent callers share one refresh rather than each
 * firing their own.
 */
async function load({ force = false } = {}) {
    const file = currentAccountFile();
    if (!file) {
        cached = null;
        return null;
    }
    const sub = subOfFile(file);
    if (cached && cached.sub === sub && !force) {
        // expiresAt 0 means "no local expiry known"; viewer_accounts tracks the
        // real one in memory, so a cached token is trusted until it asks for it.
        const stillFresh = cached.expiresAt === 0 || cached.expiresAt - REFRESH_MARGIN_MS > Date.now();
        if (stillFresh) return cached;
    }

    if (refreshing) return refreshing;

    refreshing = (async () => {
        try {
            const fresh = await refreshToken(sub);
            if (fresh) {
                cached = fresh;
                logState('info', 'using viewer account token', file, fresh);
                return cached;
            }
            cached = null;
            return null;
        } catch (err) {
            logger.warn('token', 'viewer account token unavailable', {
                sub,
                status: err.response ? err.response.status : undefined,
                message: logger.truncateStderr(String(err.message || err)),
            });
            cached = null;
            return null;
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
    if (cached) return cached.accessToken;
    const now = Date.now();
    // Kick off the first load, then throttle so a signed-out TV - one with no
    // account file at all - does not retry on every single request.
    if (!refreshing && now - lastAttemptAt > REFRESH_MIN_GAP_MS) {
        lastAttemptAt = now;
        void load();
    }
    return cached ? cached.accessToken : null;
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
    if (!currentAccountFile()) return null;
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
        // Unconditional rather than isStale(): viewer_accounts tracks the real
        // expiry in memory and this module deliberately does not duplicate that
        // bookkeeping, so "is it stale" is not answerable from here. load() is a
        // no-op when the token is still good - accessTokenFor returns the cached
        // access token without a request - and it also picks up a different
        // account after someone else signs in.
        void load();
    }, REFRESH_INTERVAL_MS);
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { getAccessToken, load, prepare, startBackgroundRefresh };
