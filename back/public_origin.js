// Resolves the origin that the *client* uses to reach this backend.
//
// Direct use (http://192.168.4.52:8090) is the only mode the backend had
// before. Once an nginx front terminates TLS (optionally HTTP/3) the public
// origin differs from the bind address, so every URL we generate has to be
// derived from the incoming request instead of being hardcoded.
//
// Priority:
//   1. settings.publicOrigin  - explicit override for deployments where
//                               X-Forwarded-* is not usable (bare port
//                               mapping, some tunnels)
//   2. X-Forwarded-Proto/Host - set by the nginx front
//   3. Host header            - direct access, no proxy in front
//   4. http://serverIp:port   - last-resort fallback

function firstValue(headerValue) {
    if (!headerValue) return '';
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return String(raw).split(',')[0].trim();
}

function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

const state = {
    serverIp: 'localhost',
    port: 8090,
    getSettings: null,
    // Remembered so callers without a request (the res.json() rewriter, for
    // example) still emit URLs matching the origin the client is using.
    lastOrigin: 'http://localhost:8090',
};

function configure(options) {
    if (!options) return;
    if (options.serverIp) state.serverIp = options.serverIp;
    if (options.port) state.port = options.port;
    if (options.getSettings) state.getSettings = options.getSettings;
    state.lastOrigin = stripTrailingSlash(`http://${state.serverIp}:${state.port}`);
}

function resolve(req) {
    const settings = typeof state.getSettings === 'function' ? state.getSettings() : null;
    const override = settings && settings.publicOrigin;
    if (override) {
        state.lastOrigin = stripTrailingSlash(override);
        return state.lastOrigin;
    }

    if (req && req.headers) {
        const headers = req.headers;
        const proto = firstValue(headers['x-forwarded-proto']);
        const host = firstValue(headers['x-forwarded-host']) || firstValue(headers.host);
        if (host) {
            const scheme = proto
                || (req.socket && req.socket.encrypted ? 'https' : 'http');
            state.lastOrigin = stripTrailingSlash(`${scheme}://${host}`);
            return state.lastOrigin;
        }
    }

    return state.lastOrigin;
}

// Rewriter context for image_proxy / the legacy video info blob. `origin` and
// `encodedOrigin` are getters so they always reflect the current request.
function createRewriteContext() {
    return {
        get serverIp() { return state.serverIp; },
        get port() { return state.port; },
        get origin() { return resolve(); },
        get encodedOrigin() { return encodeOrigin(resolve()); },
    };
}

// `http://host:443` -> `http%3A%2F%2Fhost%3A443`. Needed because the legacy
// form-encoded video info blob carries percent-encoded absolute URLs, and the
// rest of the path inside those URLs is *already* percent-encoded and must not
// be encoded a second time.
function encodeOrigin(origin) {
    const value = stripTrailingSlash(origin);
    const schemeEnd = value.indexOf('://');
    if (schemeEnd < 0) return value;
    const scheme = value.slice(0, schemeEnd);
    const authority = value.slice(schemeEnd + 3).replace(/:/g, '%3A');
    return `${scheme}%3A%2F%2F${authority}`;
}

module.exports = {
    configure,
    resolve,
    createRewriteContext,
    encodeOrigin,
    firstValue,
    stripTrailingSlash,
};
