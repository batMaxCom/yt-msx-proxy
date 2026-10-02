/*
 * CustomVideoPlayer — self-contained replacement for the framework playback.
 * Owns the .html5-main-video element, loads media directly through the
 * server proxy (/get_video_info, /api/hls, /api/stream) and never asks
 * for Flash. Strategy per environment:
 *   1. nativehls   — video element plays the master m3u8 (WebOS WAM, Safari...)
 *   2. hlsjs       — hls.js transmux on desktop (per-segment proxy, no throttle)
 *   3. msewebm     — MediaSource with whole VP9/Opus WebM streams (Chromium)
 *   4. progressive — single muxed MP4 (itag=18) served with Range support
 */
(function (global) {
    'use strict';
    if (global.YTCustomPlayer) return;
    global.__CUSTOM_PLAYER_VERSION = '20261002j';

    var appSettings = { hideOnScreenNav: false, showToggleVideoInfo: true };
    try {
        xhrText((global.location.origin || '') + '/settings.json', function (t) {
            if (t) { try { appSettings = JSON.parse(t) || appSettings; } catch (err) { } }
        });
    } catch (err) { }

    var wl = (global.navigator && global.navigator.userAgent) || '';
    var isTV = /Web0S|webOS|LG Browser|LG-|SMART-TV|AppleTV|Tizen|Viera|Phantom]|DTV|wiiu/i.test(wl);
    var base = global.location.origin || '';

    function beacon(ev, extra) {
        try { if (global.__ytclientlog) global.__ytclientlog(ev, extra || {}); } catch (e) { }
        try { if (global.console && global.console.log) global.console.log('[CP] ' + ev, extra || ''); } catch (e) { }
    }

    function getVideoId() {
        var m = (global.location.hash || '').match(/(?:[?&#]|^)v=([\w-]{6,16})/);
        return m ? m[1] : null;
    }

    function xhrText(url, cb) {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.onreadystatechange = function () { if (x.readyState === 4) cb(x.status >= 200 && x.status < 400 ? (x.responseText || '') : null); };
        x.send(null);
    }

    /* ---- local watch journal ----
       The 2016 client cannot write into YouTube's own watch history (that path
       needs session cookies this server does not have), so the journal is kept
       here and lives next to the other per-profile state on the server.

       A /get_video_info call is NOT a view: the same request serves the chain
       prefetch and the idle takeover, so it would log videos nobody ever saw.
       What counts is wall time the media element was actually playing, sampled
       from poll() and reported in deltas - a heartbeat while the video runs, a
       final flush when playback stops - so a crash or a power cut loses at most
       one heartbeat window, and the server adds the deltas up per video. */

    var HIST_PROFILE_KEY = 'yt_profile_id';
    var HIST_HEARTBEAT_SECONDS = 60;
    var histMetaFor = {};           // videoId -> metadata, so a heartbeat is cheap
    var histSession = null;         // the session in progress, null when idle

    /* One backend serves several viewers, so the journal is keyed by profile.
       The TV has no login, so the profile is whatever localStorage holds; a
       ?profile=<id> in the address bar picks one and remembers it. The id is
       mirrored into a cookie because the 2016 app builds its own /api/browse
       URLs and cannot be given a header - without the cookie the History tab
       would always show the default profile's rows.

       When nothing has been chosen we mint a random id instead of settling for
       "default". "default" is one shared bucket on the server, so every device
       that never picked a name would otherwise pile its viewing into the same
       list and each would see what the others watched. A per-device id is what
       makes the histories separate without anyone having to do anything. */
    function histProfileId() {
        try {
            var ls = global.localStorage;
            // An explicit ?profile= is a deliberate choice, so it outranks
            // whatever is already stored. It is also the only way to switch or
            // rename a profile later: if the stored id always won, the first
            // value ever picked could never be changed.
            var m = /[?&]profile=([A-Za-z0-9._-]{1,64})/.exec(String((global.location && global.location.search) || ''));
            var v = m ? m[1] : null;
            if (ls) {
                if (v) {
                    try { ls.setItem(HIST_PROFILE_KEY, v); } catch (e0) { }
                } else {
                    v = ls.getItem(HIST_PROFILE_KEY);
                    if (!v) {
                        v = newHistProfileId();
                        try { ls.setItem(HIST_PROFILE_KEY, v); } catch (e1) { }
                        beacon('CP_PROFILE_NEW', { profile: v });
                    }
                }
            }
            if (v && /^[A-Za-z0-9._-]{1,64}$/.test(v)) {
                try {
                    if (cookieValue('yt_profile_id') !== v) {
                        global.document.cookie = 'yt_profile_id=' + encodeURIComponent(v) +
                            '; path=/; max-age=31536000; SameSite=Lax';
                    }
                } catch (e) { }
                return v;
            }
        } catch (e) { }
        // No usable storage (private mode, storage disabled). Falling back to the
        // shared "default" is honest here: without localStorage there is nothing
        // stable to keep a generated id in, so per-viewer history cannot work.
        return 'default';
    }

    /* 128 bits of entropy, hex, so the id is unguessable and matches the
       /^[A-Za-z0-9._-]{1,64}$/ shape the server accepts. */
    function newHistProfileId() {
        try {
            var c = global.crypto;
            if (c && typeof c.getRandomValues === 'function') {
                var b = new Uint8Array(16);
                c.getRandomValues(b);
                var s = '';
                for (var i = 0; i < b.length; i++) s += (b[i] + 0x100).toString(16).slice(1);
                return 'p' + s;
            }
        } catch (e) { }
        return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    }

    function cookieValue(name) {
        try {
            var raw = String((global.document && global.document.cookie) || '');
            var parts = raw.split(';'), i, p;
            for (i = 0; i < parts.length; i++) {
                p = parts[i].trim();
                if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
            }
        } catch (e) { }
        return '';
    }

    function histBody(id, seconds, meta, plays) {
        var m = meta || histMetaFor[id] || {};
        return {
            profile_id: histProfileId(),
            video_id: id,
            title: m.title || '',
            channel: m.author || '',
            channel_id: m.channelId || '',
            thumbnail: m.thumbnail || '',
            duration: m.duration || 0,
            watch_seconds: Math.max(0, Math.round(seconds)),
            // only the piece that ends the session is a play, not every heartbeat
            plays: plays ? 1 : 0,
        };
    }

    function histPost(id, seconds, meta, plays) {
        if (!id || seconds < 1) return false;
        var payload = JSON.stringify(histBody(id, seconds, meta, plays));
        try {
            if (global.navigator && global.navigator.sendBeacon) {
                // survives the page going away, which is exactly the case a
                // plain XHR does not: the TV gets powered off mid-video
                var blob = new Blob([payload], { type: 'application/json' });
                if (global.navigator.sendBeacon(base + '/api/history/play', blob)) return true;
            }
        } catch (e) { }
        var x = new XMLHttpRequest();
        x.open('POST', base + '/api/history/play', true);
        x.setRequestHeader('Content-Type', 'application/json');
        try { x.setRequestHeader('X-YT-Profile-Id', histProfileId()); } catch (e) { }
        x.send(payload);
        beacon('CP_HIST', { id: id, s: Math.round(seconds), via: 'xhr' });
        return true;
    }

    function histLoadMeta(id) {
        if (!id || histMetaFor[id]) return;
        histMetaFor[id] = null;                 // in flight
        xhrText(base + '/api/video-meta/' + encodeURIComponent(id), function (t) {
            if (!t) { delete histMetaFor[id]; return; }
            try {
                var m = JSON.parse(t);
                histMetaFor[id] = (m && m.id) ? m : {};
            } catch (e) { histMetaFor[id] = {}; }
        });
    }

    function histBegin(id) {
        if (!id) return;
        if (histSession && histSession.id === id) return;
        histEnd();
        histSession = { id: id, watched: 0, reported: 0, lastAt: Date.now() };
        histLoadMeta(id);
    }

    /* Report everything watched since the last post and zero the counter, so a
       crash mid-video keeps at most one heartbeat window unwritten. */
    function histFlush(plays) {
        var s = histSession;
        if (!s) return;
        var pending = s.watched - s.reported;
        if (pending < 1) return;
        s.reported = s.watched;
        histPost(s.id, pending, histMetaFor[s.id], plays);
    }

    function histEnd() {
        if (!histSession) return;
        histFlush(1);
        histSession = null;
    }

    /* Sampled from poll(): only counts while the element is really running, and
       a long gap (tab hidden, engine stalled) is clamped so a frozen player does
       not accumulate hours of "watched" time. */
    function histTick() {
        var s = histSession;
        if (!s || !active || active.id !== s.id) return;
        var el = active.engEl;
        if (!el) return;
        var now = Date.now();
        var dt = (now - s.lastAt) / 1000;
        s.lastAt = now;
        if (dt <= 0 || dt > 10) return;
        var playing = false;
        try { playing = !el.paused && !el.ended && el.readyState >= 2; } catch (e) { }
        if (!playing) return;
        s.watched += dt;
        if (s.watched - s.reported >= HIST_HEARTBEAT_SECONDS) histFlush();
    }

    try {
        global.addEventListener('pagehide', function () { histFlush(); }, false);
        global.addEventListener('beforeunload', function () { histFlush(); }, false);
    } catch (e) { }

    function absUrl(u) {
        if (!u) return u;
        if (/^https?:\/\//i.test(u)) return u;
        return base + (u.charAt(0) === '/' ? '' : '/') + u;
    }

    function nativeHlsOk(el) {
        // On TV prefer MSE-webm whenever the (Chromium-based) WAM supports it,
        // because the synthesized LL-HLS media playlists are flaky upstream.
        // Fall back to native HLS only when MediaSource is unavailable.
        if (isTV) return !mseOk('video/webm; codecs="vp9"');
        try {
            if (el.canPlayType('application/vnd.apple.mpegurl') === 'probably') return true;
            if (el.canPlayType('application/x-mpegurl') === 'probably') return true;
            if (el.canPlayType('audio/mpegurl') === 'probably') return true;
            if (/Safari/i.test(wl) && !/Chrome|Chromium|CriOS/i.test(wl)) return true;
        } catch (e) { return isTV; }
        return false;
    }

    function mseOk(codec) {
        try { return !!(global.MediaSource && global.MediaSource.isTypeSupported && global.MediaSource.isTypeSupported(codec)); } catch (e) { return false; }
    }

    /* ---------------- engines ---------------- */

    function Engine() { this.stopped = false; }
    Engine.prototype.close = function () { this.stopped = true; };
    Engine.prototype.seek = function () { };
    Engine.prototype.adopt = function () { };   // re-attach to a swapped video element

    function EngineNativeHls(conf) {
        this.conf = conf;
        Engine.call(this);
        var self = this;
        // remember a "?q=" that start() may have appended, so adopt() can rebuild it
        var qm = /[?&]q=(\d+)/.exec(String(conf.hlsUrl || ''));
        this._q = qm ? parseInt(qm[1], 10) : 0;
        conf.el.src = conf.hlsUrl;
        try { conf.el.load(); } catch (e) { }
        var tryPlay = function () {
            if (self.stopped) return;
            if (conf.el.paused) {
                var p = conf.el.play();
                if (p && p.catch) p.catch(function () { setTimeout(tryPlay, 800); });
            }
        };
        setTimeout(tryPlay, 250);
    }
    EngineNativeHls.prototype = Object.create(Engine.prototype);
    EngineNativeHls.prototype.constructor = EngineNativeHls;
    EngineNativeHls.prototype.setQuality = function (h) {
        var el = this.conf && this.conf.el;
        // the src is rebuilt from scratch, so the position has to be carried over
        // by hand - a quality change mid-playback must not jump back to 0:00
        var keep = 0, wasPlaying = false;
        if (el) {
            try { keep = el.currentTime || 0; wasPlaying = !el.paused; } catch (e) { }
        }
        this._q = h || 0;
        this._keepTime = keep;
        this._keepPlaying = wasPlaying;
        this.conf.hlsUrl = this._hlsUrlFor(h);
        this.adopt(this.conf.el);
        beacon('CP_Q_RESTART', { h: h || 0, t: Math.round(keep) });
    };
    EngineNativeHls.prototype._hlsUrlFor = function (h) {
        var baseUrl = String(this.conf.hlsUrl || '').split('?')[0];
        return baseUrl + (h ? '?q=' + h : '');
    };
    EngineNativeHls.prototype.adopt = function (el) {
        var conf = this.conf;
        if (!conf) return;
        if (el) conf.el = el;
        if (!conf.el || this.stopped) return;
        // only restore on a deliberate quality switch; a framework element swap
        // (adoptElement) must keep whatever position the new node reports
        var keep = this._keepTime || 0;
        var wantPlay = this._keepPlaying;
        this._keepTime = 0; this._keepPlaying = false;
        conf.el.src = this._hlsUrlFor(this._q);
        try { conf.el.load(); } catch (e) { }
        var self = this;
        var restore = function () {
            if (self.stopped || !conf.el) return;
            if (keep > 0) { try { if (isFinite(conf.el.duration) && keep < conf.el.duration) conf.el.currentTime = keep; } catch (e2) { } }
            if (wantPlay !== false && conf.el.paused) {
                var p = conf.el.play();
                if (p && p.catch) p.catch(function () { setTimeout(function () { if (!self.stopped && conf.el && conf.el.paused) { var q = conf.el.play(); if (q && q.catch) q.catch(function () { }); } }, 400); });
            }
        };
        // the new manifest has to be parsed before currentTime can be set
        try { conf.el.addEventListener('loadedmetadata', restore, false); } catch (e3) { }
        setTimeout(restore, 1200);
    };

    function EngineHlsJs(conf) {
        this.conf = conf;
        Engine.call(this);
        var self = this;
        var Hls = global.Hls;
        if (!Hls || !Hls.isSupported || !Hls.isSupported()) { this._ok = false; return; }
        this._ok = true;
        var hls = new Hls({
            enableWorker: true,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,
            levelLoadingTimeOut: 20000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            // Buffering for a link that is not fast. The defaults assume a
            // 30s/60MB forward buffer and give up on a segment after 4s, which
            // on a slow connection is exactly the "it loads for a while and then
            // freezes" failure. A deeper forward buffer plus a longer patience
            // window turns those stalls into invisible waits.
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            maxBufferSize: 120 * 1000 * 1000,
            backBufferLength: 60,
            maxLoadingDelay: 10000,
            // Pull the first segment before the player asks for it, so the
            // first frame does not wait on a full request/response round trip.
            startFragPrefetch: true,
            lowLatencyMode: false,
            progressive: false
        });
        this._hls = hls;
        this._pendingQ = null;
        hls.attachMedia(conf.el);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            if (self.stopped) return;
            beacon('HLSJS_READY', { levels: hls.levels ? hls.levels.length : -1 });
            if (self._pendingQ) self.setQuality(self._pendingQ);
            hideFrameworkEl();
            if (conf.el.paused) {
                var p = conf.el.play();
                if (p && p.catch) p.catch(function () { });
            }
        });
        hls.on(Hls.Events.ERROR, function (evt, data) {
            beacon('HLSJS_ERROR', { type: data && data.type, details: data && data.details, fatal: data && data.fatal });
            // A rejected append is recoverable in place: repairing the buffer
            // keeps the playhead and the download alive, whereas letting it
            // escalate ends in a hard stop that the user sees as a freeze.
            var details = data && data.details;
            var ED = Hls.ErrorDetails || {};
            if (details === ED.BUFFER_APPEND_ERROR || details === ED.MEDIA_ERROR) {
                try { hls.recoverMediaError(); } catch (e1) { }
                return;
            }
            if (data && data.fatal) {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) try { hls.startLoad(); } catch (e) { }
            }
        });
        hls.loadSource(conf.hlsUrl);
    }
    EngineHlsJs.prototype = Object.create(Engine.prototype);
    EngineHlsJs.prototype.constructor = EngineHlsJs;
    EngineHlsJs.prototype.close = function () {
        Engine.prototype.close.call(this);
        try { if (this._hls) this._hls.destroy(); } catch (e) { }
    };
    EngineHlsJs.prototype.adopt = function (el) {
        var hls = this._hls;
        if (!hls || !el) return;
        try { hls.detachMedia(); } catch (e) { }
        this.conf.el = el;
        try { hls.attachMedia(el); } catch (e2) { }
        if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () { }); }
    };
    EngineHlsJs.prototype.setPendingQ = function (h) {
        this._pendingQ = h || null;
        if (this._hls && this._hls.levels && this._hls.levels.length) this.setQuality(h);
    };
    EngineHlsJs.prototype.setQuality = function (h) {
        var hls = this._hls;
        if (!hls || !hls.levels || !hls.levels.length) { this._pendingQ = h || null; return; }
        var idx = -1, i;
        if (h) {
            for (i = 0; i < hls.levels.length; i++) if (hls.levels[i].height === h) { idx = i; break; }
            // No exact rung: take the nearest one rather than silently dropping
            // back to Auto, which used to make the menu look like a dead key.
            if (idx < 0) {
                var bestGap = Infinity;
                for (i = 0; i < hls.levels.length; i++) {
                    var gap = Math.abs(hls.levels[i].height - h);
                    if (gap < bestGap) { bestGap = gap; idx = i; }
                }
            }
            // A hand-picked level is not a ceiling: lifting the cap lets a later
            // Auto selection climb again instead of staying pinned at this rung.
            try { hls.autoLevelCapping = -1; } catch (e3) { }
        } else {
            // Auto: hand the decision back to hls.js ABR. The cap is lifted
            // rather than pinned to the top rung - ABR measures the link and
            // settles where it can actually keep up, which is the whole point
            // of having more than one level in the playlist.
            idx = -1;
            try { hls.autoLevelCapping = -1; } catch (e2) { }
        }
        try { hls.currentLevel = idx; } catch (e) { }
        beacon('HLSJS_Q', { h: h || 0, idx: idx, levels: hls.levels.length, auto: !h });
    };

    /* Incremental fetch tuning for the MSE engine.
       The engine used to pull each stream in a single response, so a long video
       had to arrive in full before the first frame was appended - on a slow link
       that simply never finished. Streams are now read in bounded Range chunks
       and the download is throttled to stay a little ahead of playback, which
       also keeps memory flat instead of holding the whole file in one buffer. */
    var MSE_FIRST_CHUNK = 1024 * 1024;   // init segment + first clusters: fast start
    var MSE_CHUNK = 4 * 1024 * 1024;      // steady state chunk
    var MSE_TARGET_AHEAD = 30;            // seconds of buffer to keep downloaded
    var MSE_POLL_MS = 500;
    /* A rendition change on the MSE/progressive engines cannot be hidden: the
       new stream starts at byte 0, so the buffer has to be rebuilt and the
       playhead restored. That is a real stall every time, so a burst of
       requests (a user cycling the menu, or the health guard reacting to the
       stall it just caused) is collapsed into a single rebuild. */
    var Q_SWITCH_DEBOUNCE_MS = 400;
    var MSE_CHUNK_TIMEOUT_MS = 45000;
    var MSE_MAX_RETRIES = 6;

    function EngineMseWebm(conf) {
        this.conf = conf;
        Engine.call(this);
        this._videoLinks = (conf.videoLinks || []).slice();
        if (!this._videoLinks.length && conf.video) this._videoLinks = [conf.video];
        this._audio = conf.audio || null;
        this._requests = [];
        this._feeds = [];
        this._pump = null;
        this._generation = 0;
        this._objectUrl = '';
        this._videoSb = null;
        this._audioSb = null;
        this._currentVideo = null;
        this._restoreTime = 0;
        this._shouldPlay = true;
        var video = this._selectVideo(conf.height);
        this._openSource(video);
    }
    EngineMseWebm.prototype = Object.create(Engine.prototype);
    EngineMseWebm.prototype.constructor = EngineMseWebm;

    EngineMseWebm.prototype.getQualityLevels = function () {
        return qualityHeights(this._videoLinks);
    };

    EngineMseWebm.prototype._selectVideo = function (h) {
        if (!this._videoLinks.length) return null;
        if (h) {
            var exact = null, nearest = null, nearestDistance = Number.MAX_SAFE_INTEGER, i;
            for (i = 0; i < this._videoLinks.length; i++) {
                var current = this._videoLinks[i];
                var currentHeight = formatHeight(current);
                if (currentHeight === h) { exact = current; break; }
                var distance = Math.abs(currentHeight - h);
                if (currentHeight > 0 && distance < nearestDistance) { nearest = current; nearestDistance = distance; }
            }
            if (exact) return exact;
            if (nearest) return nearest;
        }
        return defaultVideo(this._videoLinks);
    };

    EngineMseWebm.prototype._clearMetadata = function () {
        var el = this.conf && this.conf.el;
        if (el && this._onMeta) {
            try { el.removeEventListener('loadedmetadata', this._onMeta); } catch (e) { }
        }
        this._onMeta = null;
    };

    EngineMseWebm.prototype._abortRequests = function () {
        for (var i = 0; i < this._requests.length; i++) {
            try { this._requests[i].abort(); } catch (e) { }
        }
        this._requests = [];
    };

    EngineMseWebm.prototype._stopPump = function () {
        if (this._pump) {
            clearInterval(this._pump);
            this._pump = null;
        }
    };

    EngineMseWebm.prototype.close = function () {
        Engine.prototype.close.call(this);
        this._clearMetadata();
        this._stopPump();
        if (this._qTimer) { clearTimeout(this._qTimer); this._qTimer = null; }
        this._qPending = null;
        this._feeds = [];
        this._abortRequests();
        if (this._ms) {
            try { if (this._ms.readyState === 'open') this._ms.endOfStream(); } catch (e) { }
        }
        if (this._objectUrl) {
            try { global.URL.revokeObjectURL(this._objectUrl); } catch (e) { }
            this._objectUrl = '';
        }
    };

    EngineMseWebm.prototype._openSource = function (video) {
        if (this.stopped) return;
        if (!video || !video.url) { beacon('MSE_SOURCE_FAIL', { reason: 'video' }); return; }
        var generation = ++this._generation;
        this._stopPump();
        this._feeds = [];
        this._abortRequests();
        this._clearMetadata();
        var self = this;
        var el = this.conf && this.conf.el;
        var oldUrl = this._objectUrl;
        this._currentVideo = video;
        this._videoSb = null;
        this._audioSb = null;
        this._ms = null;
        this._pending = 0;
        try { el.pause(); } catch (e) { }
        try { el.removeAttribute('src'); el.load(); } catch (e) { }
        var ms = new global.MediaSource();
        this._ms = ms;
        var objectUrl = global.URL.createObjectURL(ms);
        this._objectUrl = objectUrl;
        this._onMeta = function () {
            if (self.stopped || generation !== self._generation) return;
            self._clearMetadata();
            var t = self._restoreTime || 0;
            try { if (t > 0 && isFinite(el.duration) && t < el.duration) el.currentTime = t; } catch (err) { }
            if (self._shouldPlay && el.paused) {
                var p = el.play();
                if (p && p.catch) p.catch(function () { });
            }
        };
        el.addEventListener('loadedmetadata', this._onMeta);
        el.src = objectUrl;
        try { el.load(); } catch (e) { }
        if (oldUrl) {
            try { global.URL.revokeObjectURL(oldUrl); } catch (e) { }
        }
        ms.addEventListener('sourceopen', function () {
            if (self.stopped || generation !== self._generation || ms.readyState !== 'open') return;
            var videoMime = video.mime || mseMime(video, 'video');
            var audioMime = self._audio ? (self._audio.mime || mseMime(self._audio, 'audio')) : '';
            beacon('MSE_SOURCEOPEN', { rs: ms.readyState, mime: videoMime });
            try { self._videoSb = ms.addSourceBuffer(videoMime); }
            catch (e) { beacon('MSE_VIDEOSB_FAIL', { m: videoMime, e: String(e) }); return; }
            try { if (self._audio) self._audioSb = ms.addSourceBuffer(audioMime); }
            catch (e) { self._audioSb = null; }
            // Audio no longer waits for the whole video file: it is pulled as
            // soon as the video has its first chunk, otherwise a long video
            // would stay silent until it finished downloading.
            var audioStarted = false;
            var startAudio = function () {
                if (audioStarted) return;
                audioStarted = true;
                if (self.stopped || generation !== self._generation) return;
                if (self._audioSb && self._audio) self._loadStream(self._audio.url, self._audioSb, null, null, generation);
            };
            self._loadStream(video.url, self._videoSb, null, function () {
                startAudio();
                self._boot(generation);
            }, generation);
        });
    };

    /* ---- incremental Range feed ------------------------------------------
           One stream = one SourceBuffer fed by successive bounded Range reads.
           `next` is the resume point, so a dropped connection costs one chunk,
           not the whole file. Nothing is requested while the buffer is already
           comfortably ahead of the playhead. */

    EngineMseWebm.prototype._loadStream = function (url, sb, done, onFirst, generation) {
        var self = this;
        this._pending++;
        this._feeds.push({
            url: url,
            sb: sb,
            next: 0,
            total: 0,
            firstDone: false,
            firedFirst: false,
            done: false,
            eof: false,
            fails: 0,
            xhr: null,
            onFirst: onFirst || null,
            doneCb: done || null,
        });
        beacon('MSE_FEED', { url: String(url).slice(-46) });
        this._maybeStartPump();
        this._pumpFeeds(generation);
    };

    /* Seconds of media buffered past the playhead, or -1 when nothing is
       buffered around it yet. */
    EngineMseWebm.prototype._bufferedAhead = function () {
        var el = this.conf && this.conf.el;
        if (!el || !el.buffered || !el.buffered.length) return -1;
        var ct = el.currentTime || 0, end = -1;
        for (var i = 0; i < el.buffered.length; i++) {
            if (el.buffered.start(i) <= ct + 0.25 && el.buffered.end(i) > end) end = el.buffered.end(i);
        }
        return end < 0 ? -1 : end - ct;
    };

    EngineMseWebm.prototype._wantsMore = function (st) {
        if (st.eof || st.done) return false;
        // Once the last byte is in there must be no further request: asking for
        // bytes=total- would only earn a 416 from upstream.
        if (st.total && st.next >= st.total) return false;
        if (!st.firstDone) return true;
        var ahead = this._bufferedAhead();
        if (ahead < 0) return true;
        return ahead < MSE_TARGET_AHEAD;
    };

    EngineMseWebm.prototype._maybeStartPump = function () {
        if (this._feeds.length && !this._pump && !this.stopped) {
            var self = this;
            this._pump = setInterval(function () { self._pumpFeeds(self._generation); }, MSE_POLL_MS);
        }
    };

    EngineMseWebm.prototype._pumpFeeds = function (generation) {
        if (this.stopped || generation !== this._generation) return;
        for (var i = 0; i < this._feeds.length; i++) {
            var st = this._feeds[i];
            if (st.done || st.xhr) continue;
            if (st.sb.updating) continue;      // let the previous append drain
            if (!this._wantsMore(st)) continue;
            this._fetchChunk(st, generation);
        }
    };

    EngineMseWebm.prototype._fetchChunk = function (st, generation) {
        var self = this;
        var size = st.firstDone ? MSE_CHUNK : MSE_FIRST_CHUNK;
        var start = st.next, end = start + size - 1;
        var x = new XMLHttpRequest();
        var settled = false;
        st.xhr = x;

        x.open('GET', st.url, true);
        x.responseType = 'arraybuffer';
        try { x.timeout = MSE_CHUNK_TIMEOUT_MS; } catch (e0) { }
        try { x.setRequestHeader('Range', 'bytes=' + start + '-' + end); } catch (e1) { }

        var settle = function (fn) {
            if (settled) return;
            settled = true;
            st.xhr = null;
            // A settled request can no longer be aborted, so stop tracking it:
            // one entry per chunk would otherwise pile up for the whole file.
            var qi = self._requests.indexOf(x);
            if (qi >= 0) self._requests.splice(qi, 1);
            if (self.stopped || generation !== self._generation) return;
            fn();
        };
        x.onreadystatechange = function () {
            if (x.readyState !== 4) return;
            if (x.status >= 200 && x.status < 300) settle(function () { self._onChunk(st, x, generation); });
            else settle(function () { self._onChunkFail(st, 'http_' + x.status, generation); });
        };
        x.onerror = function () { settle(function () { self._onChunkFail(st, 'network', generation); }); };
        x.ontimeout = function () { settle(function () { self._onChunkFail(st, 'timeout', generation); }); };

        this._requests.push(x);
        try { x.send(null); } catch (e2) { settle(function () { self._onChunkFail(st, 'send', generation); }); }
    };

    /* Run `cb` once the SourceBuffer is not mid-append. */
    EngineMseWebm.prototype._afterAppend = function (st, cb) {
        if (!st.sb.updating) { cb(); return; }
        var h = function () {
            try { st.sb.removeEventListener('updateend', h); } catch (e) { }
            cb();
        };
        try { st.sb.addEventListener('updateend', h); } catch (e2) { cb(); }
    };

    EngineMseWebm.prototype._onChunk = function (st, x, generation) {
        var self = this;
        var cr = x.getResponseHeader('Content-Range') || '';
        var m = /\/(\d+)\s*$/.exec(cr);
        if (m) st.total = parseInt(m[1], 10);
        var buf = x.response;

        if (!buf || !buf.byteLength) {
            if (st.total && st.next >= st.total) this._finishFeed(st);
            else this._onChunkFail(st, 'empty', generation);
            return;
        }

        this._afterAppend(st, function () {
            if (self.stopped || generation !== self._generation) return;
            try { st.sb.appendBuffer(buf); }
            catch (e) {
                beacon('MSE_APPEND_FAIL', { e: String(e), bytes: buf.byteLength, next: st.next });
                self._onChunkFail(st, 'append', generation);
                return;
            }
            var onUp = function () {
                try { st.sb.removeEventListener('updateend', onUp); } catch (e) { }
                st.next += buf.byteLength;
                st.firstDone = true;
                st.fails = 0;
                beacon('MSE_CHUNK', {
                    bytes: buf.byteLength,
                    next: st.next,
                    total: st.total,
                    pct: st.total ? Math.round(st.next * 100 / st.total) : -1,
                    ahead: self._bufferedAhead(),
                });
                if (!st.firedFirst) {
                    st.firedFirst = true;
                    beacon('MSE_FIRST_APPEND', { len: self._bufferedAhead() });
                    if (st.onFirst) st.onFirst();
                }
                if (st.total && st.next >= st.total) {
                    st.eof = true;
                    self._finishFeed(st);
                }
            };
            try {
                if (st.sb.updating) st.sb.addEventListener('updateend', onUp);
                else onUp();
            } catch (e3) { self._onChunkFail(st, 'updateend', generation); }
        });
    };

    EngineMseWebm.prototype._onChunkFail = function (st, reason, generation) {
        if (this.stopped || generation !== this._generation) return;
        // A response that lands after the feed was already retired (e.g. a late
        // 416 for a range past EOF) must not log a retry or restart the pump.
        if (st.done) return;
        st.fails++;
        if (st.fails > MSE_MAX_RETRIES) {
            beacon('MSE_FEED_GIVEUP', { reason: reason, next: st.next, total: st.total });
            this._finishFeed(st);
            return;
        }
        var delay = Math.min(5000, 700 * Math.pow(2, st.fails - 1));
        beacon('MSE_RETRY', { reason: reason, next: st.next, fails: st.fails, delay: delay });
        var self = this;
        setTimeout(function () { self._pumpFeeds(generation); }, delay);
    };

    EngineMseWebm.prototype._finishFeed = function (st) {
        if (st.done) return;
        st.done = true;
        this._pending = Math.max(0, this._pending - 1);
        var idx = this._feeds.indexOf(st);
        if (idx >= 0) this._feeds.splice(idx, 1);
        beacon('MSE_FEED_DONE', { next: st.next, total: st.total, pct: st.total ? Math.round(st.next * 100 / st.total) : -1 });
        var cb = st.doneCb;
        st.doneCb = null;
        if (cb) { try { cb(); } catch (e) { } }
        if (!this._feeds.length) this._stopPump();
        this._endOfStreamWhenComplete();
    };

    EngineMseWebm.prototype._feedsBusy = function () {
        return this._feeds.length > 0;
    };

    EngineMseWebm.prototype._endOfStreamWhenComplete = function () {
        if (this.stopped) return;
        if (this._pending > 0) return;
        var ms = this._ms;
        if (!ms || ms.readyState !== 'open') return;
        // Without endOfStream() the element never reaches the end of the
        // buffered range, so "ended" never fires and playback never ends.
        try { ms.endOfStream(); } catch (e) { }
    };

    EngineMseWebm.prototype._boot = function (generation) {
        if (this.stopped || generation !== this._generation) return;
        var self = this, tries = 0;
        var kick = function () {
            if (self.stopped || generation !== self._generation) return;
            var el = self.conf.el;
            var rs = el.readyState;
            try { beacon('MSE_KICK', { rs: rs, t: Math.round((el.currentTime || 0) * 10) / 10, b: el.buffered && el.buffered.length ? +el.buffered.end(el.buffered.length - 1).toFixed(1) : -1 }); } catch (e) { }
            if (rs >= 2) { hideFrameworkEl(); return; }
            if (!self._shouldPlay) return;
            var p = el.play();
            if (p && p.catch) p.catch(function () { });
            tries++;
            // While chunks are still arriving the decoder legitimately has
            // nothing to show, so keep waiting patiently: remounting here would
            // throw away the partial buffer and restart the download - exactly
            // the failure this engine had on slow links.
            if (self._feedsBusy()) {
                if (tries <= 60) setTimeout(kick, 2000);
                else {
                    try { beacon('MSE_SLOW_WAIT', { t: Math.round((el.currentTime || 0) * 10) / 10, rs: rs }); } catch (e) { }
                    setTimeout(kick, 5000);
                }
                return;
            }
            if (tries <= 10) setTimeout(kick, 2500);
            else {
                try { beacon('MSE_REMOUNT', { t: Math.round((el.currentTime || 0) * 10) / 10, rs: rs }); } catch (e) { }
                if (global.YTCustomPlayer && global.YTCustomPlayer._remount) global.YTCustomPlayer._remount(self.conf.el);
            }
        };
        kick();
    };

    EngineMseWebm.prototype.setQuality = function (h) {
        var video = this._selectVideo(h);
        if (!video || video === this._currentVideo) return;
        var el = this.conf && this.conf.el;
        var self = this;
        if (this._qTimer) clearTimeout(this._qTimer);
        this._qPending = video;
        this._qTimer = setTimeout(function () {
            self._qTimer = null;
            var target = self._qPending;
            self._qPending = null;
            if (!target || self.stopped || target === self._currentVideo) return;
            self._restoreTime = el ? (el.currentTime || 0) : 0;
            self._shouldPlay = !!(el && el.paused === false);
            self._openSource(target);
            beacon('MSE_Q', { h: formatHeight(target) || 0, requested: h || 0 });
        }, Q_SWITCH_DEBOUNCE_MS);
    };

    function EngineNoop() { Engine.call(this); }
    EngineNoop.prototype = Object.create(Engine.prototype);
    EngineNoop.prototype.constructor = EngineNoop;

    function EngineProgressive(conf) {
        this.conf = conf;
        Engine.call(this);
        this._sources = (conf.sources || []).slice();
        if (!this._sources.length && conf.url) this._sources = [{ url: conf.url }];
        this._currentSource = null;
        this._restoreTime = 0;
        this._shouldPlay = true;
        this._timer = null;
        this._onMeta = null;
        this._loadSource(this._selectSource(conf.height));
    }
    EngineProgressive.prototype = Object.create(Engine.prototype);
    EngineProgressive.prototype.constructor = EngineProgressive;

    EngineProgressive.prototype.getQualityLevels = function () {
        return qualityHeights(this._sources);
    };

    EngineProgressive.prototype._selectSource = function (h) {
        if (!this._sources.length) return null;
        if (h) {
            var exact = null, nearest = null, nearestDistance = Number.MAX_SAFE_INTEGER, i;
            for (i = 0; i < this._sources.length; i++) {
                var current = this._sources[i];
                var currentHeight = formatHeight(current);
                if (currentHeight === h) { exact = current; break; }
                var distance = Math.abs(currentHeight - h);
                if (currentHeight > 0 && distance < nearestDistance) { nearest = current; nearestDistance = distance; }
            }
            if (exact) return exact;
            if (nearest) return nearest;
        }
        return defaultVideo(this._sources);
    };

    EngineProgressive.prototype._clearMetadata = function () {
        var el = this.conf && this.conf.el;
        if (el && this._onMeta) {
            try { el.removeEventListener('loadedmetadata', this._onMeta); } catch (e) { }
        }
        this._onMeta = null;
    };

    EngineProgressive.prototype._loadSource = function (source) {
        if (this.stopped || !source || !source.url) return;
        this._clearMetadata();
        var self = this;
        var el = this.conf && this.conf.el;
        this._currentSource = source;
        try { el.pause(); } catch (e) { }
        try { el.removeAttribute('src'); el.load(); } catch (e) { }
        this._onMeta = function () {
            if (self.stopped) return;
            self._clearMetadata();
            var t = self._restoreTime || 0;
            try { if (t > 0 && isFinite(el.duration) && t < el.duration) el.currentTime = t; } catch (err) { }
            if (self._shouldPlay && el.paused) {
                var p = el.play();
                if (p && p.catch) p.catch(function () { });
            }
        };
        el.addEventListener('loadedmetadata', this._onMeta);
        el.src = source.url;
        try { el.load(); } catch (e) { }
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(function () {
            if (!self.stopped && self._shouldPlay && el.paused) {
                var p = el.play();
                if (p && p.catch) p.catch(function () { });
            }
        }, 300);
    };

    EngineProgressive.prototype.setQuality = function (h) {
        var source = this._selectSource(h);
        if (!source || source === this._currentSource) return;
        var el = this.conf && this.conf.el;
        var self = this;
        if (this._qTimer) clearTimeout(this._qTimer);
        this._qPending = source;
        this._qTimer = setTimeout(function () {
            self._qTimer = null;
            var target = self._qPending;
            self._qPending = null;
            if (!target || self.stopped || target === self._currentSource) return;
            self._restoreTime = el ? (el.currentTime || 0) : 0;
            self._shouldPlay = !!(el && el.paused === false);
            self._loadSource(target);
            beacon('PROGRESSIVE_Q', { h: formatHeight(target) || 0, requested: h || 0 });
        }, Q_SWITCH_DEBOUNCE_MS);
    };

    EngineProgressive.prototype.close = function () {
        Engine.prototype.close.call(this);
        this._clearMetadata();
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._qTimer) { clearTimeout(this._qTimer); this._qTimer = null; }
        this._qPending = null;
    };

    /* ---------------- format picking ---------------- */

    function linkMime(l) {
        return String(l && (l.mime || l.type) || '').split(';')[0].trim().toLowerCase();
    }

    function linkCodecs(l) {
        if (!l) return '';
        var raw = String(l.mime || l.type || '');
        var match = /codecs\s*=\s*["']?([^;"']+)/i.exec(raw);
        return String(match ? match[1] : (l.codecs || l.codec || '')).trim();
    }

    function linkItag(l) {
        if (!l) return '';
        if (l.itag !== undefined && l.itag !== null && l.itag !== '') return String(l.itag);
        var match = /[?&]itag=(\d+)/i.exec(String(l.url || ''));
        return match ? match[1] : '';
    }

    function formatHeight(l) {
        if (!l) return 0;
        var explicit = parseInt(l.height, 10);
        if (isFinite(explicit) && explicit > 0) return explicit;
        var size = String(l.size || l.resolution || '');
        var match = /(\d+)\s*x\s*(\d+)/i.exec(size);
        if (match) return parseInt(match[2], 10) || 0;
        match = /[?&]size=(\d+)x(\d+)/i.exec(String(l.url || ''));
        if (match) return parseInt(match[2], 10) || 0;
        var heights = {
            '18': 360, '22': 720, '37': 1080, '38': 3072,
            '133': 240, '134': 360, '135': 480, '136': 720, '137': 1080, '138': 2160,
            '160': 144, '247': 720, '248': 144, '271': 1440, '272': 2880, '278': 1440,
            '394': 144, '397': 480, '398': 720, '399': 1080, '571': 4320, '616': 4320
        };
        return heights[linkItag(l)] || 0;
    }

    function qualityHeights(links) {
        var seen = {}, out = [], i;
        for (i = 0; i < (links || []).length; i++) {
            var h = formatHeight(links[i]);
            if (h > 0 && !seen[h]) { seen[h] = true; out.push(h); }
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function linkBitrate(l) {
        if (!l) return 0;
        var explicit = parseFloat(l.bitrate !== undefined ? l.bitrate : l.tbr);
        if (isFinite(explicit) && explicit > 0) return explicit;
        var m = /[?&]bitrate=([\d.]+)/i.exec(String(l.url || ''));
        return m ? parseFloat(m[1]) : 0;
    }

    /* Bytes advertised by the backend (adaptive_fmts "clen"). The MSE engines
       buffer a whole file before playing, so an absurdly large rendition would
       stall or OOM the device; use it to keep "auto" at the best rendition that
       is still sane. Unknown sizes are never filtered out. */
    function linkBytes(l) {
        if (!l) return 0;
        var raw = l.clen !== undefined ? l.clen : l.contentLength;
        var n = parseFloat(raw);
        if (isFinite(n) && n > 0) return n;
        var m = /[?&]clen=(\d+)/i.exec(String(l.url || ''));
        return m ? parseFloat(m[1]) : 0;
    }

    function autoByteCap() {
        var mb = parseInt(appSettings.maxAutoQualityMB, 10);
        if (!isFinite(mb) || mb <= 0) mb = 600;
        return mb * 1024 * 1024;
    }

    /* "auto" = the best stream this video has: highest resolution, then the
       highest bitrate. Renditions larger than the sanity cap are stepped over
       (in resolution order) so a multi-GB 4K file cannot wedge the player. */
    function defaultVideo(links) {
        var candidates = (links || []).filter(function (l) { return l && l.url && linkMime(l).indexOf('video/') === 0; });
        if (!candidates.length) return null;
        var sorted = candidates.slice().sort(function (a, b) {
            var ha = formatHeight(a), hb = formatHeight(b);
            if (ha !== hb) return hb - ha;
            return linkBitrate(b) - linkBitrate(a);
        });
        var cap = autoByteCap(), i;
        for (i = 0; i < sorted.length; i++) {
            var bytes = linkBytes(sorted[i]);
            if (!bytes || bytes <= cap) return sorted[i];
        }
        return sorted[0];
    }

    function bestVideo(links, container) {
        container = container || 'webm';
        var candidates = (links || []).filter(function (l) { return l && l.url && linkMime(l) === 'video/' + container; });
        return defaultVideo(candidates);
    }

    function bestAudio(links, container) {
        container = container || 'webm';
        var candidates = (links || []).filter(function (l) { return l && l.url && linkMime(l) === 'audio/' + container; });
        return candidates.length ? candidates[0] : null;
    }

    function isMuxedLink(l) {
        if (!l || !l.url || linkMime(l) !== 'video/mp4' || /api\/hls\//i.test(l.url)) return false;
        var itag = linkItag(l);
        if (/^(18|22|37|38)$/.test(itag)) return true;
        if (linkCodecs(l).indexOf(',') >= 0) return true;
        return String(l.muxed || l.audio || '') === '1';
    }

    function progressiveLinks(links, progLink) {
        var out = [], seen = {}, i, l;
        function add(candidate) {
            if (!candidate || !candidate.url || /api\/hls\//i.test(candidate.url)) return;
            if (linkMime(candidate) !== 'video/mp4' && !/(?:^|[?&])itag=(?:18|22|37|38)(?:&|$)/i.test(candidate.url)) return;
            if (seen[candidate.url]) return;
            seen[candidate.url] = true;
            out.push(candidate);
        }
        for (i = 0; i < (links || []).length; i++) {
            l = links[i];
            if (isMuxedLink(l)) add(l);
        }
        if (progLink && linkMime(progLink) === 'video/mp4') add(progLink);
        return out;
    }

    function muxedUrl(links) {
        var candidates = progressiveLinks(links, null);
        var source = defaultVideo(candidates);
        return source ? source.url : null;
    }

    function codecsForItag(url, kind, mime) {
        var it = parseInt((String(url || '').match(/[?&]itag=(\d+)/i) || [])[1], 10);
        var base = String(mime || '').toLowerCase();
        if (kind === 'audio') {
            if (base.indexOf('mp4') >= 0 || base.indexOf('m4a') >= 0) return it === 139 ? 'mp4a.40.5' : 'mp4a.40.2';
            return (it === 171 || it === 172) ? 'vorbis' : 'opus';
        }
        if (base.indexOf('mp4') >= 0) return 'avc1.4d401e';
        return (it === 43 || it === 44 || it === 45) ? 'vp8' : 'vp9';
    }

    function mseMime(l, kind) {
        var fallback = kind === 'audio' ? 'audio/webm' : 'video/webm';
        var b = linkMime(l) || fallback;
        var c = linkCodecs(l) || codecsForItag(l && l.url, kind, b);
        return c ? b + '; codecs="' + c + '"' : b;
    }

    /* ---------------- main API ---------------- */

    var active = null;
    var ownElTimer = 0;
    var onSeekHandler = onSeek;

    /* The framework's element gets wedged by the 2016 app's own load()/error cycles
       and then buffers into MSE forever without decoding (rs:0). For MSE engines we
       use a fresh element of our own; nativehls (TV) keeps the framework element.
       The replacement mirrors the framework video's absolute geometry but is mounted
       inside #player and uses NO z-index, so the app's own transport controls and
       info panel (later/positioned siblings, z-index:1) still paint on top: the video
       never covers the player navigation. */
    function mirrorHostGeo(vid) {
        var host = global.document && global.document.querySelector('.html5-main-video');
        if (!host || !vid) return;
        try {
            var cs = global.getComputedStyle(host);
            vid.style.objectFit = cs.objectFit || 'contain';
            vid.style.width = cs.width;
            vid.style.height = cs.height;
            vid.style.top = cs.top;
            vid.style.left = cs.left;
            vid.style.right = cs.right;
            vid.style.bottom = cs.bottom;
            var r = host.getBoundingClientRect();
            if (!r || !(r.width > 0) || !(r.height > 0) || isNaN(r.left) || isNaN(r.top)) return;
            var w = parseFloat(cs.width), h = parseFloat(cs.height);
            if (!(w > 0)) vid.style.width = Math.round(r.width) + 'px';
            if (!(h > 0)) vid.style.height = Math.round(r.height) + 'px';
            if (cs.top === 'auto') vid.style.top = Math.round(r.top) + 'px';
            if (cs.left === 'auto') vid.style.left = Math.round(r.left) + 'px';
        } catch (e) { }
    }

    function makeOwnEl() {
        var host = global.document && global.document.querySelector('.html5-main-video');
        var vid = global.document.createElement('video');
        vid.setAttribute('playsinline', '');
        vid.style.cssText = 'position:absolute;pointer-events:none;background:transparent;';
        var target = (global.document && global.document.querySelector('#player')) ||
            (global.document && global.document.querySelector('#movie_player')) ||
            (global.document && global.document.body);
        try { if (target && target.appendChild) target.appendChild(vid); } catch (e) { }
        mirrorHostGeo(vid);
        if (host && !ownElTimer) {
            ownElTimer = setInterval(function () {
                if (active && active.ownEl) mirrorHostGeo(active.ownEl);
            }, 800);
        }
        try { global.addEventListener('resize', function () { if (active && active.ownEl) mirrorHostGeo(active.ownEl); }); } catch (e) { }
        beacon('CP_OWNEL', {});
        return vid;
    }

    function hideFrameworkEl() {
        var host = global.document && global.document.querySelector('.html5-main-video');
        if (host) { try { host.style.visibility = 'hidden'; } catch (e) { } }
    }

    function dropOwnEl(ownEl) {
        if (!ownEl) return;
        try { ownEl.remove(); } catch (e) { }
        var host = global.document && global.document.querySelector('.html5-main-video');
        if (host) { try { host.style.visibility = ''; } catch (e) { } }
    }

    function stopActive() {
        histEnd();                              // flush the time actually played
        qualityRequest++;
        var el = active && active.engEl;
        if (el) {
            try { el.pause(); } catch (e) { }
            try { el.removeEventListener('ended', chainOnEnded); } catch (e2) { }
            try { if (el.currentSrc || el.src) el.src = ''; } catch (e) { }
            try { el.removeAttribute('src'); } catch (e) { }
            try { el.load(); } catch (e) { }
        }
        if (active && active.engEl) {
            try { unbindSeek(active.engEl); } catch (e) { }
        }
        if (active) {
            try { if (active.engine && active.engine.close) active.engine.close(); } catch (e) { }
            dropOwnEl(active.ownEl);
        }
        active = null;
        chainBusy = false;
        chainPendingFor = '';
        chainItems = [];
        chainFor = '';
        metaReq++;                            // drop any metadata still in flight
        hideVideoMeta();
        closeRelPanel();                      // its rows described the video we just left
        chainLoadingFor = '';
    }

    /* The 2016 app re-creates its video element every time the watch surface
       re-renders (which it does for every chained video). Adopt the new node
       instead of restarting playback from zero. */
    function adoptElement(el) {
        if (!active || !el) return;
        if (!active.ownEl && active.engine) {
            try { if (active.engine.adopt) active.engine.adopt(el); } catch (e) { }
        }
        active.el = el;
        try { el.setAttribute('data-yt-custom', active.id); } catch (e) { }
        try { el.addEventListener('ended', chainOnEnded); } catch (e2) { }
        beacon('CP_ADOPT', { id: active.id, own: active.ownEl ? 1 : 0 });
    }

    function onSeek() {
        if (active && active.engine && active.engine.seek && active.engEl) {
            try { active.engine.seek(active.engEl.currentTime || 0); } catch (e) { }
        }
    }

    function bindSeek(el) {
        try { el.addEventListener('seeking', onSeekHandler); } catch (e) { }
    }

    function unbindSeek(el) {
        try { el.removeEventListener('seeking', onSeekHandler); } catch (e) { }
    }

    function start(conf) {
        var el = conf.el || conf.element;
        if (!el) return false;
        var id = conf.id || getVideoId();
        if (!id) return false;
        if (active && active.id === id && active.engEl && !active.engEl.paused) {
            if (el !== active.el) adoptElement(el);
            return true;
        }

        stopActive();
        active = { id: id, el: el, engine: null };
        try { el.setAttribute('data-yt-custom', id); } catch (e) { }

        var hlsUrl = conf.hlsUrl || (base + '/api/hls/' + id);
        hlsUrl = absUrl(hlsUrl);
        beacon('CP_START', { id: id, engine: null, hlsUrl: hlsUrl.slice(0, 80) });
        histBegin(id);                          // real playback started, unlike a prefetch
        // hls.js must be handed the FULL ladder (see the engine branch below),
        // never the ?q= pinned single rendition the other engines ask for:
        // with ?q= present the backend serves exactly one variant and hls.js
        // is back to a single level, with no ABR and nothing to switch to.
        // A stored preference is applied through setPendingQ instead.
        var hlsLevelsUrl = function (u) {
            u = String(u || '');
            u = u.replace(/([?&])q=\d+/gi, function (m, sep) { return sep === '?' ? '?' : ''; })
                 .replace(/[?&]$/, '');
            if (/[?&]levels=1\b/.test(u)) return u;
            return u + (u.indexOf('?') < 0 ? '?' : '&') + 'levels=1';
        };

        var eng = null;
        var engEl = el;
        var links = conf.mediaLinks || [];
        var previousHeight = qualityListId === id ? currentHeight() : null;
        var wantH = previousHeight || storedHeight;
        if (qualityListId !== id) {
            qualityList = [];
            qualityIdx = -1;
            qualityListId = id;
        }
        qualityMode = '';

        if (nativeHlsOk(el)) {
            qualityMode = 'hls';
            if (wantH) hlsUrl += (hlsUrl.indexOf('?') < 0 ? '?' : '&') + 'q=' + wantH;
            eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
            beacon('CP_ENGINE', { k: 'nativehls', id: id, q: wantH || 0 });
        } else if (global.Hls && global.Hls.isSupported && global.Hls.isSupported()) {
            qualityMode = 'hls';
            // hls.js on desktop: every TS segment is a small, fresh upstream
            // request proxied by /api/hls — no sustained-download throttling.
            //
            // The plain master playlist is trimmed to the single best rendition,
            // which left hls.js with exactly ONE level: no ABR to fall back on
            // and no level to switch to, so every quality change was a no-op and
            // a slow link simply starved. levels=1 serves the whole ladder, and
            // with it hls.js can switch rendition on a segment boundary without
            // ever tearing down the buffer - that is the seamless path.
            engEl = makeOwnEl();
            eng = new EngineHlsJs({ el: engEl, hlsUrl: hlsLevelsUrl(hlsUrl) });
            if (eng._ok) eng.setPendingQ(wantH);
            beacon('CP_ENGINE', { k: 'hlsjs', id: id });
        } else {
            var webmLinks = (links || []).filter(function (l) { return l && l.url && linkMime(l) === 'video/webm'; });
            var v = mseOk('video/webm; codecs="vp9"') ? bestVideo(links, 'webm') : null;
            if (v) {
                setQualityList(id, qualityHeights(webmLinks), wantH, false);
                qualityMode = 'mse';
                engEl = makeOwnEl();
                eng = new EngineMseWebm({
                    el: engEl,
                    videoLinks: webmLinks,
                    height: currentHeight(),
                    audio: (function () {
                        var a = bestAudio(links, 'webm');
                        return a ? { url: absUrl(a.url), mime: mseMime(a, 'audio') } : null;
                    })()
                });
                beacon('CP_ENGINE', { k: 'msewebm', id: id, q: currentHeight() || 0 });
            } else {
                var mp4Links = (links || []).filter(function (l) { return l && l.url && linkMime(l) === 'video/mp4' && !isMuxedLink(l); });
                v = (mseOk('video/mp4; codecs="avc1.4d401e"') || mseOk('video/mp4')) ? bestVideo(mp4Links, 'mp4') : null;
                if (v) {
                    setQualityList(id, qualityHeights(mp4Links), wantH, false);
                    qualityMode = 'mse';
                    engEl = makeOwnEl();
                    eng = new EngineMseWebm({
                        el: engEl,
                        videoLinks: mp4Links,
                        height: currentHeight(),
                        audio: (function () {
                            var a = bestAudio(links, 'mp4');
                            return a ? { url: absUrl(a.url), mime: mseMime(a, 'audio') } : null;
                        })()
                    });
                    beacon('CP_ENGINE', { k: 'msemp4', id: id, q: currentHeight() || 0 });
                } else {
                    eng = new EngineNoop();
                    beacon('CP_ENGINE', { k: 'nomse', id: id });
                }
            }
        }

        if (eng && eng.constructor === EngineNoop) {
            var sources = progressiveLinks(links, conf.progLink);
            if (sources.length) {
                setQualityList(id, qualityHeights(sources), wantH, false);
                qualityMode = 'progressive';
                engEl = makeOwnEl();
                eng = new EngineProgressive({ el: engEl, sources: sources, height: currentHeight() });
                beacon('CP_ENGINE', { k: 'progressive', id: id, q: currentHeight() || 0 });
            } else {
                qualityMode = 'hls';
                if (wantH) hlsUrl += (hlsUrl.indexOf('?') < 0 ? '?' : '&') + 'q=' + wantH;
                eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
                beacon('CP_ENGINE', { k: 'lastresort-nativehls', id: id, q: wantH || 0 });
            }
        }

        active.engEl = engEl;
        active.ownEl = (engEl === el) ? null : engEl;
        active.engine = eng;
        onSeekHandler = onSeek;
        bindSeek(engEl);
        try { engEl.addEventListener('seeked', function () { beacon('CP_SEEKED', {}); }); } catch (e) { }
        try { engEl.addEventListener('ended', chainOnEnded); } catch (e2) { }
        // a "waiting" event during playback means the device could not sustain the
        // stream, which is the signal the quality guard reacts to
        try { engEl.addEventListener('waiting', function () { noteStall(); }); } catch (e5) { }
        try { engEl.addEventListener('playing', function () { trSyncIcon(); }); } catch (e6) { }
        try { engEl.addEventListener('pause', function () { trSyncIcon(); }); } catch (e7) { }
        try { engEl.addEventListener('ended', function () { trSyncIcon(); }); } catch (e8) { }
        resetHealth();
        chainAdvanceTo({ id: id, title: (conf.title || '') });
        loadVideoMeta(id);                  // the watch screen has no title of its own
        // the up-next ranking is resolved as soon as the video starts, not when it
        // ends: the skip button needs a target straight away, and the toggle only
        // decides whether playback rolls over on its own
        loadChain(id);
        if (chainPlayed.length > 60) chainPlayed.shift();
        if (chainPlayed.indexOf(id) < 0) chainPlayed.push(id);
        if (qualityMode === 'hls') loadQualityList(id, wantH);
        else applyQuality();
        return true;
    }

    /* fallback: take over if framework never started anything */

    function parseAdaptive(text) {
        var pairs = {}, i, kv, tmp = text.split('&');
        for (i = 0; i < tmp.length; i++) {
            kv = tmp[i].indexOf('=');
            if (kv < 0) continue;
            try { pairs[decodeURIComponent(tmp[i].slice(0, kv))] = decodeURIComponent(tmp[i].slice(kv + 1)); } catch (e) { }
        }
        var af = pairs.adaptive_fmts || '';
        var out = [];
        var entries = af.split(',');
        for (i = 0; i < entries.length; i++) {
            if (!entries[i]) continue;
            var f = {}, kvs = entries[i].split('&'), j;
            for (j = 0; j < kvs.length; j++) {
                var e = kvs[j].indexOf('=');
                if (e < 0) continue;
                try { f[decodeURIComponent(kvs[j].slice(0, e))] = decodeURIComponent(kvs[j].slice(e + 1)); } catch (err) { }
            }
            if (!f.url) continue;
            var q = f.url.split('?')[1];
            if (!f.mime && q) {
                var qs = q.split('&'), k;
                for (k = 0; k < qs.length; k++) if (qs[k].indexOf('mime=') === 0) f.mime = decodeURIComponent(qs[k].slice(5));
            }
            out.push(f);
        }
        return out;
    }

 function startById(id, el, cb) {
     // the up-next payload was already resolved when the previous video started,
     // so the common case is an instant switch with no request at all
     var pre = takeChainPrefetch(id);
     if (pre) { startFromInfo(id, el, pre, cb); return; }
     xhrText(base + '/get_video_info?video_id=' + encodeURIComponent(id), function (t) {
         startFromInfo(id, el, t, cb);
     });
 }

  function startFromInfo(id, el, t, cb) {
      if (!t || !el || active) { if (cb) cb(false); return; }
      var links = parseAdaptive(t);
      var hls = null, i;
      for (i = 0; i < links.length; i++) { if (links[i].url && /itag=hls/.test(links[i].url)) { hls = links[i].url; break; } }
      var ok = start({ id: id, el: el, mediaLinks: links, hlsUrl: hls || (base + '/api/hls/' + id) });
      if (cb) cb(ok);
  }



    var lastCandidate = 0;
    var takeoverBusy = false;
    var quitId = null;
    var quitUntil = 0;
    var lastHash = null;

    /* A user-initiated quit (Esc) must not be immediately undone by the takeover:
       after we stop playback the hash can still hold the same v=... and the app may
       only append &resume, so re-takeover would silently restart the same video.
       Suppress takeover of the just-quit id while the URL keeps pointing at that same
       watch video; a proper navigation (different video, or away to browse) re-arms it. */
    var QUIT_COOLDOWN_MS = 60000;

    function suppressQuit(id) {
        quitId = id;
        quitUntil = Date.now() + QUIT_COOLDOWN_MS;
    }

    function onWatchRoute() {
        try { return String((global.location && global.location.hash) || '').indexOf('/watch') >= 0; }
        catch (e) { return false; }
    }

    /* Leaving the watch screen must silence the player. The app handles its own
       Back key and just swaps the route, so without this our element keeps
       playing off-screen and the user hears a video they already left behind.
       poll() is the backstop for clients whose Back never reaches our handler. */
    function stopIfLeftWatch(why) {
        if (!active || onWatchRoute()) return false;
        var id = active.id;
        beacon('CP_LEFT_WATCH', { id: id, via: why });
        stopActive();
        lastCandidate = 0;
        return true;
    }

    function poll() {
        setTimeout(function () {
            histTick();
            stopIfLeftWatch('poll');
            var id = getVideoId();
            var el = global.document && global.document.querySelector('.html5-main-video');
            if (!id || !el) { lastCandidate = 0; poll(); return; }
            var hashNow = (global.location && global.location.hash) || '';
            if (hashNow !== lastHash) {
                lastHash = hashNow;
                if (id !== quitId) { quitId = null; quitUntil = 0; }
                lastCandidate = 0;
            }
            var now = Date.now();
            if (active) {
                var lost = (active.el !== el);
                if (lost && active.id === id && !active.ownEl) {
                    adoptElement(el);            // same video, framework swapped the node
                    lost = false;
                }
                if (!lost && !active.ownEl) {
                    lost = (el.readyState === 0 && !/^blob:/.test(el.currentSrc || el.src || ''));
                }
                if (!lost && active.id !== id) {
                    beacon('CP_NAV', { from: active.id, to: id });
                    stopActive();
                    lastCandidate = 0;
                    poll();
                    return;
                }
                if (!lost) { lastCandidate = 0; poll(); return; }
                stopActive();
            }
            if (id === quitId && now < quitUntil) { lastCandidate = 0; poll(); return; }
            if (!takeoverBusy && el.readyState === 0) {
                if (!lastCandidate) lastCandidate = Date.now();
                var doingFlash = false;
                try { doingFlash = /Flash Player is required/.test(global.document.body.innerText || ''); } catch (e) { }
                if (doingFlash || (Date.now() - lastCandidate > 4000)) {
                    lastCandidate = 0;
                    takeoverBusy = true;
                    beacon('CP_TAKEOVER', { via: doingFlash ? 'flash' : 'idle' });
                    startById(id, el, function () { takeoverBusy = false; });
                }
            } else if (!takeoverBusy) lastCandidate = 0;
            poll();
        }, 1000);
    }

    function remount(el) {
        try { stopActive(); } catch (e) { }
        var id = getVideoId();
        if (id && el) {
            beacon('CP_REMOUNT', { id: id });
            startById(id, el);
        }
    }

    /* ---- transport (player navigation) ----
       The 2016 app renders its transport timeline from its own player model,
       which never advances in our setup (we play on our own element), so the
       seekbar stays 0:00 and the built-in navigation keys do nothing useful.
       We re-implement both on top of the real framework DOM: feed the seekbar
       and time labels from our playing element, own Arrow/Down/Space so the
       panel is summoned on demand and auto-hides after TR_HIDE_MS of no
       activity, and keep left/right seeking in every transport state. Volume
       via up/down is intentionally removed (use the panel's Play/seek + the
       TV's own system if any). Keys are only intercepted while the watch
       surface exists and is not snapped into grid browsing. */

    var TR_HIDE_MS = 5000;
    var SEEK_STEP = 10;
    var trSeen = false;
    var trVisible = false;
    var lastTrActive = 0;

    function trEl() { return global.document && global.document.querySelector('#transport-controls'); }

    function watchSurface() { return global.document && global.document.querySelector('#watch'); }

    function fmtTime(s) {
        if (!(isFinite(s) && s >= 0)) return '';
        s = Math.floor(s);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        if (h) return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + ss).slice(-2);
        return m + ':' + ('0' + ss).slice(-2);
    }

    function setTitleTray(visible) {
        var doc = global.document;
        var tray = doc && doc.getElementById('title-tray');
        if (!tray) return;
        var want = visible ? 'block' : 'none';
        try { if (tray.style.display !== want) tray.style.display = want; } catch (e) { }
    }

    function setTransport(visible) {
        var tc = trEl();
        var w = watchSurface();
        if (visible) {
            if (tc) {
                try { tc.classList.remove('hidden'); } catch (e) { }
                try { tc.classList.remove('no-model'); } catch (e) { }
            }
            if (w) w.classList.add('transport-showing');
            setTitleTray(true);
            if (metaReady) metaShow();
        } else {
            if (tc) tc.classList.add('hidden');
            if (w) w.classList.remove('transport-showing');
            hideVideoMeta();
            setTitleTray(false);
        }
    }

    function showTransport() {
        trVisible = true;
        lastTrActive = Date.now();
        setTransport(true);
        ensureNavRow();
        renderTrFocus();
    }

    /* ---- transport navigation, in the order the user asked for ----
         1. info, quality
         2. the seek bar
         3. previous, rewind, play/pause, forward, next, related

       The app's own transport row cannot be used for this. Its #button-list is
       not the skip/play row at all: on the watch screen it renders the More
       Actions menu (subscribe / like / report / search), the previous / rewind /
       play / forward / next entries only exist inside the player's own model,
       and opening that menu takes the remote focus away for good. So the whole
       row is ours: three zones walked with up/down, items within a zone with
       left/right, and no dependency on what the app happens to have rendered. */
    var TR_ZONE_TOP = 0;      // info, quality
    var TR_ZONE_SEEK = 1;     // the seek bar
    var TR_ZONE_ACTIONS = 2;  // prev, rew, play, ff, next, related

    var trZone = TR_ZONE_SEEK;
    var trZoneIdx = 0;
    var trBtnEls = null;      // rebuilt by ensureNavRow()
    // what the ring is currently painted on, so renderTrFocus() can skip the
    // rewrite when nothing moved (syncUI polls it every 150ms)
    var trFocusedEl = null, trFocusedCls = '', trPrevEl = null, trPrevCls = '';
    var relBtn = null;        // our "Похожие" button

    var TR_SPEC = [
        { zone: TR_ZONE_TOP, id: 'yt-cp-infobtn', icon: 'icon-player-info', label: 'Инфо', act: 'info' },
        { zone: TR_ZONE_TOP, id: 'yt-cp-qbtn', icon: 'icon-player-settings', label: 'Качество', act: 'quality' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-prevbtn', icon: 'icon-player-prev', label: 'Предыдущее', act: 'prev' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-rewbtn', icon: 'icon-player-rew', label: 'Назад', act: 'rew' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-playbtn', icon: 'icon-player-play', label: 'Играть', act: 'play' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-ffbtn', icon: 'icon-player-ff', label: 'Вперёд', act: 'ff' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-nextbtn', icon: 'icon-player-next', label: 'Следующее', act: 'next' },
        { zone: TR_ZONE_ACTIONS, id: 'yt-cp-relbtn', icon: 'icon-playlist', label: 'Похожие', act: 'rel' }
    ];

    function trAct(name) {
        switch (name) {
            case 'info': return toggleInfoPanel();
            case 'quality': return toggleQualityMenu();
            case 'prev': return chainSkipPrev();
            case 'next': return chainSkipNext();
            case 'rel': return toggleRelPanel();
            case 'rew': trSeek(-SEEK_STEP); return true;
            case 'ff': trSeek(SEEK_STEP); return true;
            case 'play': trTogglePlay(); return true;
        }
        return false;
    }

    function trSpecFor(zone, idx) {
        var out = [], i;
        for (i = 0; i < TR_SPEC.length; i++) if (TR_SPEC[i].zone === zone) out.push(TR_SPEC[i]);
        if (!out.length) return null;
        return out[((idx % out.length) + out.length) % out.length];
    }

    function trZoneCount(zone) {
        var n = 0, i;
        for (i = 0; i < TR_SPEC.length; i++) if (TR_SPEC[i].zone === zone) n++;
        return n;
    }

    /* Index of a spec inside its own zone (the index the walk uses). */
    function trSpecIndex(spec) {
        var k = 0, i;
        for (i = 0; i < TR_SPEC.length; i++) {
            if (TR_SPEC[i].zone !== spec.zone) continue;
            if (TR_SPEC[i] === spec) return k;
            k++;
        }
        return 0;
    }

    /* The seek bar is the app's own element; it is only ever a focus target, and
       the ring is ours so the walk stays visible whichever model is in charge. */
    function seekBarEl() {
        var tc = trEl();
        if (!tc) return null;
        return tc.querySelector('#progress-bar') || tc.querySelector('.progress-bar');
    }

    function renderTrFocus() {
        var doc = global.document;
        if (!doc) return;
        // The element that is about to receive the ring, computed before anything
        // is touched: syncUI runs every 150ms, and rewriting the classes and the
        // inline shadow on every tick produced a steady stream of mutations for
        // the app to react to, which is where the renderer spin came from.
        var want = null, wantCls = '';
        if (trZone === TR_ZONE_SEEK) {
            var pb = seekBarEl();
            if (pb) {
                want = pb;
                wantCls = 'yt-cp-focus';
            }
        } else {
            var sp = trSpecFor(trZone, trZoneIdx);
            if (sp && trBtnEls) {
                want = trBtnEls[sp.id] || null;
                wantCls = 'yt-cp-focus' + (sp.act === 'play' ? ' selected' : '');
            }
        }
        if (want === trFocusedEl && wantCls === trFocusedCls) return;   // already painted
        var i;
        for (i = 0; i < 2; i++) {
            var prev = i ? trFocusedEl : (trPrevEl || null);
            var prevCls = i ? trFocusedCls : (trPrevCls || '');
            if (!prev) continue;
            try { prev.classList.remove('yt-cp-focus'); } catch (e) { }
            try { prev.classList.remove('selected'); } catch (e) { }
            trBlurStyle(prev);
            try { prev.removeAttribute('data-yt-cp-pos'); } catch (e) { }
        }
        trPrevEl = trFocusedEl; trPrevCls = trFocusedCls;
        trFocusedEl = want; trFocusedCls = wantCls;
        if (!want) return;
        // start from a clean slate: two rings at once is what made the selection
        // look like it had jumped into an unrelated field
        var old = doc.querySelectorAll('.yt-cp-focus');
        for (i = 0; i < old.length; i++) {
            try { old[i].classList.remove('yt-cp-focus'); } catch (e) { }
            trBlurStyle(old[i]);
        }
        var sel = doc.querySelectorAll('.yt-cp-trbtn.selected');
        for (i = 0; i < sel.length; i++) { try { sel[i].classList.remove('selected'); } catch (e) { } }
        try { want.classList.add('yt-cp-focus'); } catch (e) { }
        trFocusStyle(want);
        if (wantCls.indexOf('selected') >= 0) {
            try { want.classList.add('selected'); } catch (e) { }
        }
        if (wantCls === 'yt-cp-focus') {
            var n = trZoneCount(trZone);
            if (n > 1) {
                try { want.setAttribute('data-yt-cp-pos', (trZoneIdx % n) + 1 + '/' + n); } catch (e) { }
            }
        }
    }

    /* Focus is styled by app-prod.css; the old inline glow is only cleared here. */
    function trFocusStyle(el) {
        // no visual work here: the ring used to be an inline glow, which painted a
        // white halo over the 2px progress line and over the icon font. The look now
        // comes from app-prod.css (.yt-cp-focus), same as the app's own buttons.
        try { if (el && el.style) el.style.boxShadow = ''; } catch (e) { }
    }

    function trBlurStyle(el) {
        try { if (el && el.style) el.style.boxShadow = ''; } catch (e) { }
    }

    function trFocusZone(zone, idx) {
        trZone = zone;
        if (idx !== undefined && idx !== null) trZoneIdx = idx;
        var n = trZoneCount(zone);
        if (n && trZoneIdx >= n) trZoneIdx = n - 1;
        if (trZoneIdx < 0) trZoneIdx = 0;
        renderTrFocus();
    }

    /* Left/right inside a zone; on the seek bar that still means scrubbing. */
    function trNavHoriz(dir) {
        if (trZone === TR_ZONE_SEEK) { trSeek(dir * SEEK_STEP); return; }
        var n = trZoneCount(trZone);
        if (!n) return;
        trZoneIdx = ((trZoneIdx + dir) % n + n) % n;
        renderTrFocus();
    }

    /* Up/down between the three zones, in the order the user listed them.
       Entering a zone always starts at its first item: carrying the index over
       from the zone above landed the remote on an unrelated control (play or
       related instead of "Предыдущее видео"), which is how focus used to end up
       somewhere the user had never pointed at. */
    function trNavVert(dir) {
        if (dir < 0) {
            if (trZone === TR_ZONE_ACTIONS) trFocusZone(TR_ZONE_SEEK);
            else trFocusZone(TR_ZONE_TOP, 0);
            return;
        }
        if (trZone === TR_ZONE_TOP) trFocusZone(TR_ZONE_SEEK);
        else if (trZone === TR_ZONE_SEEK) trFocusZone(TR_ZONE_ACTIONS, 0);
    }

    function trActivate() {
        if (trZone === TR_ZONE_SEEK) { trTogglePlay(); return true; }
        var sp = trSpecFor(trZone, trZoneIdx);
        if (!sp) return false;
        return trAct(sp.act);
    }

    /* Our transport, in two rows around the app's own seek bar:
           row 1  info, quality
           seek   the app's own #progress-bar
           row 2  previous, rewind, play/pause, forward, next, related

       The app's #button-list stays in the document but is not a navigation
       target: the app re-renders it on every model update (on the watch screen
       it is the More Actions menu, not the playback row), so anything we track
       there is gone on the next tick. */
    function ensureNavRow() {
        var doc = global.document;
        var tc = trEl();
        if (!doc || !tc) return null;
        var holder = tc;
        var seek = seekBarEl();
        var sb = (seek && seek.parentNode) ? seek.parentNode : null;   // .player-seekbar
        if (sb && sb.parentNode) holder = sb.parentNode;

        var top = doc.getElementById('yt-cp-nav-top');
        var act = doc.getElementById('yt-cp-nav-actions');
        if (!top || top.parentNode !== holder) {
            if (top) { try { top.parentNode.removeChild(top); } catch (e0) { } }
            top = doc.createElement('div');
            top.id = 'yt-cp-nav-top';
            trRowStyle(top);
            if (sb && sb.parentNode) { try { sb.parentNode.insertBefore(top, sb); } catch (e) { } }
            else { try { holder.insertBefore(top, holder.firstChild); } catch (e) { } }
        }
        if (!act || act.parentNode !== holder) {
            if (act) { try { act.parentNode.removeChild(act); } catch (e0) { } }
            act = doc.createElement('div');
            act.id = 'yt-cp-nav-actions';
            trRowStyle(act);
            if (sb) { try { sb.parentNode.insertBefore(act, sb.nextSibling); } catch (e) { } }
            else { try { holder.appendChild(act); } catch (e) { } }
        }

        var i, sp, el;
        for (i = 0; i < TR_SPEC.length; i++) {
            sp = TR_SPEC[i];
            var host = sp.zone === TR_ZONE_ACTIONS ? act : top;
            el = doc.getElementById(sp.id);
            if (!el || el.parentNode !== host) {
                var fresh = doc.createElement('div');
                fresh.id = sp.id;
                fresh.className = sp.icon + ' yt-cp-trbtn button';
                fresh.setAttribute('tabindex', '-1');
                fresh.setAttribute('aria-label', sp.label);
                fresh.setAttribute('title', sp.label);
                (function (spec) {
                    var lab = doc.createElement('span');
                    lab.className = 'label';
                    lab.textContent = spec.label;
                    fresh.appendChild(lab);
                    // clicking a button moves the remote there first, so a mouse
                    // user and a remote user always agree on where focus is
                    fresh.addEventListener('mouseover', function () {
                        var k = trSpecIndex(spec);
                        trFocusZone(spec.zone, k);
                    }, true);
                    fresh.addEventListener('click', function (e) {
                        if (e && e.preventDefault) e.preventDefault();
                        if (e && e.stopPropagation) e.stopPropagation();
                        trFocusZone(spec.zone, trSpecIndex(spec));
                        trAct(spec.act);
                        pokeTransport();
                    });
                })(sp);
                try { host.appendChild(fresh); } catch (e2) { continue; }
                el = fresh;
                // a replaced node invalidates the painted ring
                trFocusedEl = trPrevEl = null;
                trFocusedCls = trPrevCls = '';
            }
            trBtnEls = trBtnEls || {};
            trBtnEls[sp.id] = el;
            if (sp.act === 'rel') relBtn = el;
        }
        trBtnEls = trBtnEls || {};
        // The app's row is not a navigation target any more. It is left in the
        // document but emptied, because the app re-renders it on every model
        // update and would otherwise keep re-adding the "Похожие" button we
        // used to inject into it as a duplicate.
        var bl = doc.querySelector('#button-list');
        if (bl) {
            try { if (bl.style.display !== 'none') bl.style.display = 'none'; } catch (e) { }
            if (bl.querySelector('.yt-cp-relbtn')) {
                var stale = bl.querySelectorAll('.yt-cp-relbtn');
                for (var s = 0; s < stale.length; s++) {
                    try { if (stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]); } catch (e2) { }
                }
            }
        }
        return act;
    }

    /* The rows carry no geometry of their own: app-prod.css gives them the app's
       own button metrics, so nothing here can drift away from the native look. */
    function trRowStyle(row) {
        try { row.className = 'yt-cp-nav-row'; } catch (e) { }
    }

    function trSeek(delta) {
        var el = active && active.engEl;
        if (!el) return;
        var dur = el.duration;
        var max = isFinite(dur) && dur > 0 ? dur : Number.MAX_SAFE_INTEGER;
        var nt = Math.max(0, Math.min(max, (el.currentTime || 0) + delta));
        try { el.currentTime = nt; } catch (e) { }
        beacon('CP_KBD', { k: delta > 0 ? 'ff' : 'rew', t: Math.round(nt * 10) / 10 });
    }

    function trTogglePlay() {
        var el = active && active.engEl;
        if (!el) return;
        try {
            if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () { }); }
            else el.pause();
        } catch (e) { }
        trSyncIcon();
        beacon('CP_KBD', { k: 'space', t: Math.round((el.currentTime || 0) * 10) / 10 });
    }

    function trSetPaused(pause) {
        var el = active && active.engEl;
        if (!el) return;
        try {
            if (pause) el.pause();
            else if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () { }); }
        } catch (e) { }
        trSyncIcon();
    }

    /* The app's own player model never reports an isPlaying flip in our setup
       (we own playback), so the play/pause glyph has to be driven here. The CSS
       renders the pause glyph (e635) while .toggle-selected is present. */
    function trSyncIcon() {
        var b = trBtnEls && trBtnEls['yt-cp-playbtn'];
        if (!b) b = global.document && global.document.getElementById('yt-cp-playbtn');
        if (!b) return;
        var playing = !!(active && active.engEl && !active.engEl.paused && !active.engEl.ended);
        try {
            if (playing) b.classList.add('toggle-selected');
            else b.classList.remove('toggle-selected');
        } catch (e) { }
        var lab = b.querySelector('.label');
        var t = playing ? 'Пауза' : 'Играть';
        if (lab && lab.textContent !== t) lab.textContent = t;
    }

    function goHome() {
        try { global.location.hash = '#/browse-sets?c=home'; } catch (e) { }
    }

    var qualityList = [];
    var qualityIdx = -1;
    var qualityListId = '';
    var qualityMode = '';
    var qualityRequest = 0;
    var storedHeight = 0;

    /* ---- adaptive quality guard ----
       "Auto" means the highest rendition, which is what we always asked for. On a
       weak TV or a congested network that choice is simply unplayable, so we watch
       the device and move one rung at a time: down when it demonstrably cannot keep
       up, back up when it is comfortably ahead.

       Two very different failures look identical from the outside, and a guard that
       only understands one of them is useless in practice:

         - the decoder is too slow. Frames get dropped, but playback continues.
         - the download is too slow. Nothing gets dropped, because there is nothing
           to decode: the media simply stops advancing, readyState sags and `waiting`
           fires. Watching dropped frames alone sees a perfectly healthy 0%.

       So starvation is measured on its own terms, and any one of the three signals
       is enough. Only ever touches Auto, and only a few times per video, so a single
       busy scene cannot walk a whole ladder and a struggling device cannot flap. */
    var health = { at: 0, started: 0, progress: 0, media: -1, dropped: 0, total: 0, stalls: 0, bad: 0, good: 0, steps: 0, moves: 0, cycles: 0, id: '', own: false, lastMove: 0 };
    var HEALTH_MS = 3000;            // sampling window
    var HEALTH_WARMUP_MS = 6000;     // wall clock, deliberately NOT currentTime: a
                                     // stream that dies before 6s must still be
                                     // allowed to ask for less, not stay frozen
    var HEALTH_PROGRESS_EPS = 0.05;  // how far the media has to move to count as progress
    var HEALTH_STARVE_MS = 1200;     // this much of a window with no progress is bad
    var HEALTH_STARVE_HARD_MS = 2400;// this much starving needs no second window
    var HEALTH_DROP_RATIO = 0.08;    // >8% dropped frames counts as "cannot keep up"
    var HEALTH_STALLS = 2;           // or this many rebuffer events in one window
    var HEALTH_BAD_RUN = 3;          // bad windows before stepping down
    var HEALTH_CLEAN_RATIO = 0.02;   // and this clean, with no stalls, before stepping up
    var HEALTH_GOOD_RUN = 5;         // clean windows before climbing - deliberately slower
    var HEALTH_MAX_STEPS = 3;        // downgrades per cycle
    var HEALTH_MAX_MOVES = 8;        // level changes per cycle
    var HEALTH_MAX_CYCLES = 2;       // down-and-up round trips per video, then it stops
    var HEALTH_COOLDOWN_MS = 15000;  // quiet period after a move: without it the
                                     // guard reacts to its own consequences and
                                     // walks the ladder while the stream recovers


    /* ---- continuous ("endless") playback state ---- */
    var chainOn = true;
    var chainItems = [];
    var chainFor = '';
    var chainRequest = 0;
    var chainBusy = false;
    var chainPlayed = [];
    var chainPendingFor = '';
    var chainToastTimer = 0;
    var chainLoadingFor = '';
    var chainPrefetchedFor = '';
    var chainPrefetched = null;   // {id, text, at} - resolved up-next payload
    var chainWaiters = [];        // callbacks parked on an in-flight ranking request
    var chainEmptyFor = '';       // video we already asked about and got nothing back
    var chainErrorFor = '';       // video whose ranking request failed outright
    var PREFETCH_TTL_MS = 10 * 60 * 1000;
    var chainPath = [];        // [{id,title}] in visit order
    var chainPathPos = -1;     // index of the video currently playing

    function readStoredQuality() {
        storedHeight = 0;
        try {
            var v = parseInt(global.localStorage && global.localStorage.getItem('ytc_quality'), 10);
            if (isFinite(v) && v > 0) storedHeight = v;
        } catch (e) { }
    }

    function readChainPref() {
        chainOn = (appSettings.chainPlayback === undefined) ? true : !!appSettings.chainPlayback;
        try {
            var v = global.localStorage && global.localStorage.getItem('ytc_chain');
            if (v === '0') chainOn = false;
            else if (v === '1') chainOn = true;
        } catch (e) { }
    }

    function saveChainPref() {
        try { if (global.localStorage) global.localStorage.setItem('ytc_chain', chainOn ? '1' : '0'); } catch (e) { }
    }

    function chainEnabled() { return !!chainOn; }

    function setChainEnabled(on) {
        chainOn = !!on;
        saveChainPref();
        if (!chainOn) { chainBusy = false; chainPendingFor = ''; }
        beacon('CP_CHAIN', { on: chainOn });
        return chainOn;
    }

    function maxLevel() {
        return qualityList.length ? qualityList[qualityList.length - 1] : 0;
    }

    function qualityLabel() {
        var h = currentHeight();
        if (h) return h + 'p';
        var top = maxLevel();
        return top ? 'Auto ' + top + 'p' : 'Auto';
    }

    function currentHeight() {
        if (qualityIdx < 0 || !qualityList.length || qualityIdx >= qualityList.length) return null;
        return qualityList[qualityIdx];
    }

    function setQualityList(id, levels, preferred, shouldApply) {
        var seen = {}, out = [], i, h;
        for (i = 0; i < (levels || []).length; i++) {
            h = parseInt(levels[i], 10);
            if (h > 0 && !seen[h]) { seen[h] = true; out.push(h); }
        }
        out.sort(function (a, b) { return a - b; });
        var wanted = preferred;
        if (wanted === undefined) wanted = qualityListId === id ? currentHeight() : storedHeight;
        qualityList = out;
        qualityListId = id || '';
        qualityIdx = -1;
        if (wanted > 0) for (i = 0; i < out.length; i++) if (out[i] === wanted) { qualityIdx = i; break; }
        updateQualityLabel();
        if (qMenuOpen()) renderQualityMenu();
        if (shouldApply) applyQuality();
    }

    function saveQuality() {
        var h = currentHeight() || 0;
        storedHeight = h;
        try { if (global.localStorage) global.localStorage.setItem('ytc_quality', String(h)); } catch (e) { }
    }

    function loadQualityList(id, preferred, cb) {
        if (typeof preferred === 'function') { cb = preferred; preferred = undefined; }
        if (!id) { if (cb) cb(false); return; }
        var request = ++qualityRequest;
        // levels=1 asks the backend for the FULL ladder; the plain master
        // playlist is trimmed to the single best rendition (that is what "auto"
        // plays), so it can no longer be used to build the menu.
        xhrText(base + '/api/hls/' + encodeURIComponent(id) + '?levels=1', function (t) {
            if (request !== qualityRequest || (active && active.id !== id)) { if (cb) cb(false); return; }
            if (!t) { if (cb) cb(false); return; }
            var seen = {}, out = [], h, m, re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)/g;
            while ((m = re.exec(t))) {
                h = parseInt(m[2], 10);
                if (h > 0 && !seen[h]) { seen[h] = true; out.push(h); }
            }
            if (out.length) {
                out.sort(function (a, b) { return a - b; });
                setQualityList(id, out, preferred, true);
            }
            beacon('CP_QLIST', { levels: out.join(','), videoId: id });
            if (cb) cb(true);
        });
    }

    function setQualityTo(height) {
        if (!qualityList.length) return false;
        var next = -1;
        if (height) {
            var parsed = parseInt(height, 10);
            for (var i = 0; i < qualityList.length; i++) if (qualityList[i] === parsed) { next = i; break; }
            if (next < 0) return false;
        }
        qualityIdx = next;
        health.own = false;                          // a hand-made choice outranks the guard
        health.bad = 0; health.good = 0;
        if (next < 0) { health.steps = 0; health.moves = 0; }   // back to Auto: allow the guard again
        saveQuality();
        applyQuality();
        updateQualityLabel();
        if (qMenuOpen()) renderQualityMenu();
        beacon('CP_Q', { idx: qualityIdx, h: currentHeight() });
        return true;
    }

    function cycleQuality() {
        if (!qualityList.length) {
            if (qualityMode === 'hls') loadQualityList(active ? active.id : getVideoId());
            return;
        }
        if (qualityIdx < 0) qualityIdx = 0;
        else if (qualityIdx >= qualityList.length - 1) qualityIdx = -1;
        else qualityIdx += 1;
        health.own = false;
        health.bad = 0; health.good = 0;
        if (qualityIdx < 0) { health.steps = 0; health.moves = 0; }
        saveQuality();
        applyQuality();
        updateQualityLabel();
        beacon('CP_Q', { idx: qualityIdx, h: currentHeight() });
    }

    function applyQuality() {
        var eng = active && active.engine;
        if (eng && typeof eng.setQuality === 'function') {
            eng.setQuality(currentHeight());
        } else {
            beacon('CP_Q_NOTSUP', { e: eng && eng.constructor ? eng.constructor.name : 'none' });
        }
    }

    /* Reads the decoder counters. getVideoPlaybackQuality() is the standard, the
       webkit_ prefixed pair is what old webOS exposes, and when neither exists we
       fall back on rebuffer events alone. */
    function playbackCounters(el) {
        var dropped = -1, total = -1;
        try {
            if (el.getVideoPlaybackQuality) {
                var q = el.getVideoPlaybackQuality();
                dropped = q.droppedVideoFrames; total = q.totalVideoFrames;
            }
        } catch (e) { }
        if (dropped < 0) {
            try { if (typeof el.webkitDroppedFrameCount === 'number') dropped = el.webkitDroppedFrameCount; } catch (e2) { }
            try { if (typeof el.webkitDecodedFrameCount === 'number') total = el.webkitDecodedFrameCount; } catch (e3) { }
        }
        return { dropped: dropped < 0 ? 0 : dropped, total: total < 0 ? 0 : total, known: dropped >= 0 && total > 0 };
    }

    function resetHealth() {
        health.at = 0; health.started = 0; health.progress = 0; health.media = -1;
        health.dropped = 0; health.total = 0;
        health.stalls = 0; health.bad = 0; health.good = 0;
        health.steps = 0; health.moves = 0; health.cycles = 0; health.own = false; health.lastMove = 0;
        health.id = active ? active.id : '';
    }

    function noteStall() {
        if (active) health.stalls++;
    }

    /* When hls.js is driving a real multi-level playlist it already measures the
       link and drops a rung on its own, at a segment boundary, without touching
       the buffer. Pinning a level from here would override a better mechanism
       with a worse one, so the guard stands down and only guards the engines
       that have no ABR of their own. */
    function abrOwnsQuality() {
        if (qualityMode !== 'hls') return false;
        var eng = active && active.engine;
        return !!(eng && eng._hls && eng._hls.levels && eng._hls.levels.length > 1);
    }

    /* The guard may only act on Auto, or on a rung it moved to itself. A level the
       user picked by hand is off limits in both directions. */
    function healthMayAct() {
        if (abrOwnsQuality()) return false;
        if (health.cycles > HEALTH_MAX_CYCLES) return false;
        if (health.moves >= HEALTH_MAX_MOVES) return false;
        // Right after a move the buffer is still filling at the new rung; the
        // windows that follow are the recovery, not evidence of a bad choice.
        if (Date.now() - (health.lastMove || 0) < HEALTH_COOLDOWN_MS) return false;
        return qualityIdx < 0 || health.own;
    }

    function healthApply(idx) {
        health.moves++;
        health.own = true;
        health.lastMove = Date.now();
        qualityIdx = idx;
        applyQuality();
        updateQualityLabel();
        if (qMenuOpen()) renderQualityMenu();
    }

    function healthStepDown(why, ratio, starveMs, stalls) {
        if (!healthMayAct()) return;
        if (health.steps >= HEALTH_MAX_STEPS) return;
        var target = qualityList.length - 2 - health.steps;
        if (target < 0) return;
        health.steps++;
        healthApply(target);
        chainNotice('Quality lowered to ' + qualityList[target] + 'p - ' + why);
        beacon('CP_Q_DOWNGRADE', { h: qualityList[target], steps: health.steps, why: why,
            ratio: Math.round(ratio * 100), starveMs: starveMs, stalls: stalls });
    }

    /* Climbing back is the whole point of asking for Auto: once the device is
       comfortably ahead, hand the pixels back. Reaching the top restores Auto
       itself and re-arms the downgrade budget, because from there we are starting
       over from a clean, known-good state. The cycle counter is not reset, so a
       device that genuinely cannot settle still gets left alone eventually. */
    function healthStepUp() {
        if (qualityIdx < 0) return;                 // already all the way up
        if (!healthMayAct()) return;
        if (!health.own) return;                    // the user chose this level
        var top = qualityList.length - 1;
        if (qualityIdx >= top) {
            health.moves++;
            health.own = false;
            health.cycles++;
            qualityIdx = -1;
            health.steps = 0; health.moves = 0;
            applyQuality();
            updateQualityLabel();
            if (qMenuOpen()) renderQualityMenu();
            chainNotice('Quality back to Auto (' + qualityList[top] + 'p)');
            beacon('CP_Q_AUTO_RESTORED', { h: qualityList[top], cycle: health.cycles });
            return;
        }
        var target = qualityIdx + 1;
        healthApply(target);
        chainNotice('Quality raised to ' + qualityList[target] + 'p');
        beacon('CP_Q_UPGRADE', { h: qualityList[target], steps: health.steps });
    }

    /* Called from the 250ms UI tick, but only does real work every HEALTH_MS. */
    function samplePlaybackHealth() {
        if (!active || !active.engEl || qualityList.length < 2) return;
        if (health.id !== active.id) resetHealth();
        var el = active.engEl;
        var now = Date.now();
        if (!health.at) { health.at = now; return; }
        if (now - health.at < HEALTH_MS) return;

        var media = 0;
        try { media = el.currentTime || 0; } catch (e) { }

        // A pause is the user, not the network: end the window without a verdict so
        // pausing for a minute never looks like an unplayable stream.
        if (el.paused) {
            health.at = now; health.stalls = 0; health.started = 0;
            health.progress = now; health.media = media;
            return;
        }
        if (!health.started) health.started = now;      // wall clock, see HEALTH_WARMUP_MS
        if (media > health.media + HEALTH_PROGRESS_EPS) health.progress = now;
        health.media = media;

        if (now - health.started < HEALTH_WARMUP_MS) { health.at = now; health.stalls = 0; return; }

        // how much of THIS window the media was not moving for
        var windowMs = now - health.at;
        var since = health.progress > health.at ? health.progress : health.at;
        var starveMs = now - since;
        if (starveMs > windowMs) starveMs = windowMs;

        // readyState below HAVE_FUTURE_DATA means there is no data ahead of the play
        // head at all. This is the most direct "the download is not keeping up"
        // reading there is, and it works even on engines that never fire `waiting`.
        var noData = false;
        try { noData = typeof el.readyState === 'number' && el.readyState < 3; } catch (e2) { }

        var c = playbackCounters(el);
        var dTotal = c.total - health.total;
        var dDrop = c.dropped - health.dropped;
        var stalls = health.stalls;
        health.at = now; health.dropped = c.dropped; health.total = c.total; health.stalls = 0;

        var known = c.known && dTotal > 0;
        var ratio = known ? dDrop / dTotal : 0;
        var starved = starveMs >= HEALTH_STARVE_MS || noData || stalls >= HEALTH_STALLS;
        var strained = known && (ratio > HEALTH_DROP_RATIO || stalls >= HEALTH_STALLS * 2);
        var bad = starved || strained;

        if (bad) {
            health.good = 0;
            // a window that is mostly dead pipe is acted on straight away: waiting
            // out a second one just means the user sits through another 3s of it
            if (starveMs >= HEALTH_STARVE_HARD_MS || noData) {
                health.bad = 0;
                healthStepDown(noData ? 'not enough data buffered' : 'playback is stalling',
                    ratio, starveMs, stalls);
                return;
            }
            if (++health.bad < HEALTH_BAD_RUN) return;
            health.bad = 0;
            healthStepDown(starved ? 'playback is stalling' : 'device cannot keep up', ratio, starveMs, stalls);
            return;
        }
        health.bad = 0;
        // climbing back needs a much cleaner signal than dropping did, otherwise the
        // guard oscillates on a borderline stream
        if (!known || ratio >= HEALTH_CLEAN_RATIO) return;
        if (++health.good < HEALTH_GOOD_RUN) return;
        health.good = 0;
        healthStepUp();
    }

    /* The quality label lives on our own transport button (ensureTopButtons);
       this only keeps the app's own settings button in step, in case it ever
       renders one. */
    /* The app's own list is not a navigation target any more, so the level is
       shown on our own quality button instead of on the app's hidden entry. */
    function updateQualityLabel() {
        trQualityLabelSync();
    }

    /* ---- quality dropdown ----
       The 2016 client has no quality picker, so we put a plain DOM menu on top
       of the transport: Auto (best available) first, then every rendition the
       backend offers, then the endless-playback switch. The app's own
       navigation code does not know this element, so pointer input and the
       remote keys are handled here (documented in qualityMenuKey). */
    var qMenu = null;
    var qMenuAnchor = null;
    var qMenuIdx = 0;
    var qMenuRows = [];

    function qualityButton() {
        var doc = global.document;
        if (!doc) return null;
        return doc.querySelector('#yt-cp-qbtn') ||
            doc.querySelector('#button-list .icon-player-settings') ||
            doc.querySelector('.icon-player-settings');
    }

    function menuHost() {
        var doc = global.document;
        if (!doc) return null;
        return doc.querySelector('#player') || doc.querySelector('#movie_player') || doc.body;
    }

    /* The drawers also open from pages without a live player (a channel tile on
       the search page), where #player is present but hidden, which would make
       the drawer unrenderable. So they take the player only when it is on
       screen, and fall back to the body otherwise. */
    function overlayHost() {
        var host = menuHost();
        var body = global.document && global.document.body;
        if (host && host !== body) {
            try {
                if (!host.getClientRects().length) host = null;
            } catch (e) { }
        }
        return host || body;
    }

    function qMenuOpen() {
        return !!(qMenu && qMenu.style && qMenu.style.display !== 'none');
    }

    function qualityRows() {
        var rows = [], i;
        var top = maxLevel();
        rows.push({ type: 'q', value: 0, label: top ? 'Auto (max ' + top + 'p)' : 'Auto', on: qualityIdx < 0 });
        for (i = qualityList.length - 1; i >= 0; i--) {
            rows.push({ type: 'q', value: qualityList[i], label: qualityList[i] + 'p', on: currentHeight() === qualityList[i] });
        }
        rows.push({ type: 'sep' });
        rows.push({ type: 'chain', value: 1, label: 'Endless playback', on: chainEnabled() });
        return rows;
    }

    function onQualityRowClick(idx, e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        qMenuIdx = idx;
        selectQualityRow(qMenuRows[idx]);
    }

    function qualityMenuRow(t) {
        // TVs sometimes lack Element.prototype.closest; walk up manually.
        if (t && t.closest) return t.closest('.yt-cp-row');
        for (var n = t; n && n !== qMenu; n = n.parentNode) {
            if (n && n.getAttribute && /(^|\s)yt-cp-row(\s|$)/.test(n.getAttribute('class') || '')) return n;
        }
        return null;
    }

    function buildQualityMenu() {
        if (qMenu) return qMenu;
        var doc = global.document;
        if (!doc || !doc.createElement) return null;
        var host = menuHost();
        if (!host) return null;
        var el = doc.createElement('div');
        el.id = 'yt-cp-quality-menu';
        el.style.cssText = 'position:fixed;z-index:2147483000;display:none;min-width:200px;' +
            'padding:10px 0;background:#1f1f1f;color:#fff;border:2px solid #6b6b6b;border-radius:4px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,.65);text-align:left;pointer-events:auto;' +
            'font:normal 24px/1.4 Roboto,Arial,Helvetica,sans-serif;';
        try { host.appendChild(el); } catch (e) { return null; }
        el.addEventListener('mousedown', function (e) { if (e.stopPropagation) e.stopPropagation(); }, true);
        // rows bind their own click handler; this one is only a fallback for
        // targets inside a row that do not re-emit (the 2016 app stops bubbling)
        el.addEventListener('click', function (e) {
            var t = qualityMenuRow(e.target);
            if (!t) return;
            var idx = parseInt(t.getAttribute('data-idx'), 10);
            if (isNaN(idx) || idx === qMenuIdx) return;
            onQualityRowClick(idx, e);
        });
        el.addEventListener('mousemove', function (e) {
            var t = qualityMenuRow(e.target);
            if (!t) return;
            var idx = parseInt(t.getAttribute('data-idx'), 10);
            if (isNaN(idx) || idx === qMenuIdx) return;
            qMenuIdx = idx;
            highlightQualityRow();
        });
        qMenu = el;
        return qMenu;
    }

    function renderQualityMenu() {
        var el = buildQualityMenu();
        if (!el) return;
        var doc = global.document;
        var rows = qualityRows();
        var i, row;
        while (el.firstChild) el.removeChild(el.firstChild);
        qMenuRows = [];
        for (i = 0; i < rows.length; i++) {
            row = doc.createElement('div');
            qMenuRows.push(rows[i]);
            row.setAttribute('data-idx', String(i));
            if (rows[i].type === 'sep') {
                row.className = 'yt-cp-row yt-cp-sep';
                row.style.cssText = 'height:1px;margin:8px 0;background:#5a5a5a;';
              } else {
                  row.className = 'yt-cp-row';
                  row.style.cssText = 'padding:6px 20px;white-space:nowrap;';
                  // the row itself must be focusable, otherwise the app's own focus
                  // model keeps the remote and up/down never reaches the menu
                  try { row.setAttribute('tabindex', '-1'); } catch (e3) { }

                var text = rows[i].label;
                if (rows[i].type === 'chain') text += ': ' + (chainEnabled() ? 'on' : 'off');
                if (rows[i].on) text += '  \u2713';
                row.appendChild(doc.createTextNode(text));
                (function (idx) {
                    row.addEventListener('click', function (e) { onQualityRowClick(idx, e); });
                })(i);
            }
            el.appendChild(row);
        }
        highlightQualityRow();
    }

    function highlightQualityRow() {
        if (!qMenu) return;
        var nodes = qMenu.getElementsByTagName('div'), i, n;
        for (i = 0; i < nodes.length; i++) {
            n = nodes[i];
            if (!n.className || n.className.indexOf('yt-cp-row') < 0) continue;
            var idx = parseInt(n.getAttribute('data-idx'), 10);
              var row = qMenuRows[idx];
              var on = (idx === qMenuIdx);
              n.style.background = on ? '#3d3d3d' : 'transparent';

              n.style.color = (!row || row.type === 'sep') ? '#9a9a9a' : '#fff';
              if (on) {
                  // hold the DOM focus on the highlighted row: the app listens for
                  // keydown on the focused element and would otherwise walk its own
                  // focus tree while our cursor sits still
                  if (n.focus) { try { n.focus(); } catch (e2) { } }
                  if (n.scrollIntoView) { try { n.scrollIntoView({ block: 'nearest' }); } catch (e3) { } }
              }
          }
      }


    function positionQualityMenu() {
        if (!qMenu) return;
        var doc = global.document;
        var vw = global.innerWidth || (doc.documentElement && doc.documentElement.clientWidth) || 1280;
        var vh = global.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 720;
        var w = qMenu.offsetWidth || 200;
        var hgt = qMenu.offsetHeight || 200;
        var top = Math.max(10, Math.round((vh - hgt) / 2));
        var left = Math.max(10, Math.round((vw - w) / 2));
        var r = null;
        try { r = qMenuAnchor && qMenuAnchor.getBoundingClientRect ? qMenuAnchor.getBoundingClientRect() : null; } catch (e) { r = null; }
        if (r && r.width && r.height) {
            top = r.top - hgt - 10;                 // above the button, like every TV client
            if (top < 10) top = Math.min(vh - hgt - 10, r.bottom + 10);
            left = r.left + Math.round(r.width / 2) - Math.round(w / 2);
        }
        // fixed + viewport clamping: the player host is not always positioned,
        // so absolute coordinates would resolve against the wrong ancestor
        qMenu.style.top = Math.max(10, Math.min(vh - hgt - 10, top)) + 'px';
        qMenu.style.left = Math.max(10, Math.min(vw - w - 10, left)) + 'px';
    }

    function openQualityMenu(anchor) {
        var el = buildQualityMenu();
        if (!el) return false;
        if (!qualityList.length) loadQualityList(active ? active.id : getVideoId());
        qMenuAnchor = anchor || qualityButton();
        // start the cursor on the row that is currently in effect
        var rows = qualityRows(), i;
        qMenuIdx = 0;
        for (i = 0; i < rows.length; i++) {
            if (rows[i].type === 'q' && rows[i].on) { qMenuIdx = i; break; }
        }
        renderQualityMenu();
        el.style.display = 'block';
        positionQualityMenu();
        // renderQualityMenu() already moved the DOM focus onto the active row
        if (qMenuAnchor && qMenuAnchor.blur) { try { qMenuAnchor.blur(); } catch (e4) { } }
        pokeTransport();
        beacon('CP_QMENU', { open: true, levels: qualityList.join(',') });
        return true;
    }

    function closeQualityMenu() {
        if (!qMenu) return;
        qMenu.style.display = 'none';
        qMenuAnchor = null;
        beacon('CP_QMENU', { open: false });
    }

    function toggleQualityMenu(anchor) {
        if (qMenuOpen()) { closeQualityMenu(); return true; }
        return openQualityMenu(anchor);
    }

    function selectQualityRow(row) {
        if (!row) return;
        if (row.type === 'q') {
            setQualityTo(row.value);
            closeQualityMenu();
        } else if (row.type === 'chain') {
            setChainEnabled(!chainEnabled());
            renderQualityMenu();
        }
    }

    function movableRow(dir) {
        var rows = qualityRows(), i, j, n = rows.length;
        if (!n) return;
        // walk away from the cursor, not from a fixed offset, and wrap around
        for (i = 1; i <= n; i++) {
            j = (qMenuIdx + dir * i + n) % n;      // +n keeps the modulo positive
            if (rows[j].type !== 'sep') { qMenuIdx = j; return; }
        }
    }

    function qualityMenuKey(e) {
        if (!qMenuOpen()) return false;
        var code = e.keyCode || e.which || 0;
        var key = e.key || '';
        var map = { 8: 'Back', 13: 'Enter', 27: 'Escape', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
        if (map[code]) key = map[code];
        if (key === 'Backspace') key = 'Back';
        var handled = true;
        switch (key) {
            case 'ArrowDown':
                movableRow(1);
                highlightQualityRow();
                break;
            case 'ArrowUp':
                movableRow(-1);
                highlightQualityRow();
                break;
            case 'Enter':
            case ' ':
            case 'space':
                selectQualityRow(qMenuRows[qMenuIdx]);
                break;
            case 'Escape':
            case 'Back':
                closeQualityMenu();
                break;
            default:
                handled = false;
        }
        if (!handled) return false;
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return true;
    }

    /* ---- endless ("chain") playback ----
       When a video runs out we ask the backend for YouTube's own up-next
       ranking (/api/related -> InnerTube /next, search fallback) and start the
       best candidate we have not played yet. The hash is rewritten so the app's
       watch screen follows along, and the next video's metadata is warmed up
       while the current one is still playing. */

    /* Warming the next video up front: this hits /get_video_info, which both
       fills the server's 20 minute yt-dlp cache and hands us the payload back so
       the switch can start instantly instead of waiting on a fresh yt-dlp run. */
    function chainPrefetch(id) {
        if (!id) return;
        if (chainPrefetched && chainPrefetched.id === id) return;
        chainPrefetched = { id: id, text: '', at: Date.now() };
        xhrText(base + '/get_video_info?video_id=' + encodeURIComponent(id), function (t) {
            if (!t || !chainPrefetched || chainPrefetched.id !== id) return;
            chainPrefetched.text = t;
        });
    }

    function takeChainPrefetch(id) {
        var pre = chainPrefetched;
        if (!pre || pre.id !== id || !pre.text) return '';
        if (Date.now() - pre.at > PREFETCH_TTL_MS) return '';
        chainPrefetched = null;
        return pre.text;
    }

    function loadChain(id, cb) {
        if (!id) return;
        if (chainFor === id) {
            // a request is already on its way: hold the caller until it lands,
            // firing back with [] right now would make it re-enter chainNext()
            if (chainLoadingFor === id) { if (cb) chainWaiters.push(cb); return; }
            if (chainItems.length) { if (cb) cb(chainItems); return; }
        }
        chainWaiters = [];
        chainFor = id;
        chainEmptyFor = '';
        chainItems = [];
        chainLoadingFor = id;
        var req = ++chainRequest;
        if (relOpenNow()) renderRelPanel();
        xhrText(base + '/api/related?videoId=' + encodeURIComponent(id) + '&limit=20', function (res) {
            if (req !== chainRequest) return;
            chainLoadingFor = '';
            var data = null;
            try { data = JSON.parse(res); } catch (e) { beacon('CP_CHAIN_BADJSON', {}); chainFlushWaiters(null); relPanelRefresh(); return; }
            if (!data || !data.items || !data.items.length) {
                beacon('CP_CHAIN_EMPTY', { id: id, src: data && data.source });
                chainEmptyFor = id;          // don't keep re-asking for the same video
                chainFlushWaiters(null);
                relPanelRefresh();
                return;
            }
            chainItems = data.items;
            beacon('CP_CHAIN_LIST', { id: id, n: chainItems.length, src: data.source });
            // resolve the up-next target right now, while the current video plays
            var first = pickChainItem(id);
            if (first) chainPrefetch(first.id);
            chainFlushWaiters(chainItems);
            relPanelRefresh();
        });
    }

    /* the panel is fed by the same list the chain walks, so it only ever needs
       to re-read chainItems: a new ranking, a video switch, or the transport
       waking up again */
    function relPanelRefresh() {
        if (!relOpenNow()) return;
        var keep = relItems[relIdx] && relItems[relIdx].id;
        renderRelPanel();
        if (keep) {
            for (var i = 0; i < relItems.length; i++) {
                if (relItems[i].id === keep) { relIdx = i; break; }
            }
            highlightRelRow();
        }
        relLabelSync();
    }

    function chainFlushWaiters(items) {
        var w = chainWaiters;
        chainWaiters = [];
        for (var i = 0; i < w.length; i++) { try { w[i](items); } catch (e) { } }
    }

    function pickChainItem(currentId) {
        if (!chainItems.length) return null;
        var i, it, fallback = null;
        for (i = 0; i < chainItems.length; i++) {
            it = chainItems[i];
            if (!it || !it.id || it.id === currentId) continue;
            if (chainPlayed.indexOf(it.id) >= 0) continue;
            // keep a live stream as a last resort: it never "ends", so chaining
            // into one would stop the endless stream on its own terms
            if (it.live) { if (!fallback) fallback = it; continue; }
            return it;
        }
        return fallback;
    }

    function chainNavigate(id) {
        try {
            var hash = (global.location && global.location.hash) || '';
            if (hash.indexOf('v=') >= 0) hash = hash.replace(/([?&#]v=)[\w-]+/, '$1' + id);
            else hash = '#/watch?v=' + id;
            global.location.hash = hash;
            beacon('CP_CHAIN_HASH', { to: id, hash: hash.slice(0, 60) });
        } catch (e) { beacon('CP_CHAIN_NAV_FAIL', { id: id, e: String(e) }); }
    }

    /* Session history drives "skip backward": every video we start is appended
       here, so pressing it again returns to the one we came from. A target that
       is already in the path just moves the cursor instead of duplicating it. */
    function chainAdvanceTo(entry) {
        if (!entry || !entry.id) return;
        var i, cur = chainPath[chainPathPos];
        if (cur && cur.id === entry.id) return;
        for (i = 0; i < chainPath.length; i++) {
            if (chainPath[i].id === entry.id) {
                chainPathPos = i;
                if (entry.title && !chainPath[i].title) chainPath[i].title = entry.title;
                return;
            }
        }
        // entered from the outside (typed hash, app navigation): drop whatever
        // "forward" entries we had, this is a new branch
        if (chainPathPos < chainPath.length - 1) chainPath = chainPath.slice(0, chainPathPos + 1);
        chainPath.push({ id: entry.id, title: entry.title || '' });
        chainPathPos = chainPath.length - 1;
        while (chainPath.length > 80) { chainPath.shift(); chainPathPos--; }
    }

    function chainPrevItem() {
        return (chainPathPos > 0 && chainPath[chainPathPos - 1]) ? chainPath[chainPathPos - 1] : null;
    }

    function chainNextItem() {
        if (chainPathPos < 0) return null;
        return chainPath[chainPathPos + 1] || null;
    }

    function chainNotice(text) {
        chainToast({ id: '', title: text }, 0);
    }

    /* ---- watch screen metadata: thumbnail, title, author ----
       The 2016 watch screen takes its title/author/thumbnail from an InnerTube
       payload shape that YouTube no longer serves, so it renders an empty black
       screen. The metadata is already known to the backend (yt-dlp resolves it for
       playback anyway).

       The top title-tray (#title-tray) still renders its round avatar + title, so
       the old bottom thumbnail/title/author panel (#yt-cp-meta) is now dead code
       and intentionally disabled: it only duplicated info at the bottom of the
       player.

       What is still needed is the app's own diagnostics panel: it is rendered on
       every watch screen with live stream data, and settings.json can turn it off.
       The transport's "Info" button drives it, so the toggle is honoured there
       rather than being forced off from the tick. */
    var metaReq = 0;
    var metaReady = false;
    var infoPanelUser = false;      // set once the user opened the panel themselves
    var infoPanelShown = false;     // what the user last asked for, tracked explicitly

    function loadVideoMeta(id) {
        void id;   // bottom metadata panel disabled: keep the top title-tray only
    }

    function infoPanelEls() {
        var doc = global.document;
        if (!doc) return [];
        var out = [], i, list = doc.querySelectorAll('#html5-video-info-panel, .html5-video-info-panel, #movie_player .html5-video-info, .video-info-panel');
        for (i = 0; i < list.length; i++) out.push(list[i]);
        return out;
    }

    function infoPanelOpen() {
        var els = infoPanelEls(), i;
        for (i = 0; i < els.length; i++) {
            try { if (els[i].style.display !== 'none') return true; } catch (e) { }
        }
        return false;
    }

    function setInfoPanel(show) {
        var els = infoPanelEls(), i;
        for (i = 0; i < els.length; i++) {
            try { els[i].style.display = show ? '' : 'none'; } catch (e) { }
        }
        var tvi = global.document && global.document.querySelector('.legend-item.toggle-video-info');
        if (tvi) { try { tvi.style.display = show ? '' : 'none'; } catch (e) { } }
        infoPanelUser = !!show;
        infoPanelShown = !!show;
        pokeTransport();
        try { beacon('CP_INFO', { open: !!show }); } catch (e) { }
    }

    /* Toggled against our own state, not against the panel's computed style:
       the app renders that panel on its own on some screens, so reading it back
       meant the first press of the Info button could close a panel the user had
       never opened. */
    function toggleInfoPanel() {
        setInfoPanel(!infoPanelShown);
        return true;
    }

    function metaStyle() {
        return 'position:absolute;left:3%;bottom:12%;z-index:55;max-width:46%;' +
            'display:flex;align-items:flex-start;gap:14px;pointer-events:none;' +
            'opacity:0;transition:opacity .35s;text-align:left;';
    }

    function renderVideoMeta(m) {
        var doc = global.document;
        var host = menuHost();
        if (!doc || !host) return;
        var el = doc.getElementById('yt-cp-meta');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'yt-cp-meta';
            el.style.cssText = metaStyle();
            var img = doc.createElement('img');
            img.id = 'yt-cp-meta-thumb';
            img.style.cssText = 'width:200px;height:112px;object-fit:cover;flex:0 0 auto;' +
                'border-radius:3px;background:#111;';
            var box = doc.createElement('div');
            box.style.cssText = 'min-width:0;';
            var title = doc.createElement('div');
            title.id = 'yt-cp-meta-title';
            title.style.cssText = 'color:#fff;font-size:26px;line-height:1.2;font-weight:500;' +
                'text-shadow:0 1px 3px rgba(0,0,0,.85);max-height:2.4em;overflow:hidden;';
            var author = doc.createElement('div');
            author.id = 'yt-cp-meta-author';
            author.style.cssText = 'color:#ddd;font-size:19px;margin-top:6px;' +
                'text-shadow:0 1px 3px rgba(0,0,0,.85);';
            box.appendChild(title);
            box.appendChild(author);
            el.appendChild(img);
            el.appendChild(box);
            host.appendChild(el);
        }
        var thumb = doc.getElementById('yt-cp-meta-thumb');
        var ttl = doc.getElementById('yt-cp-meta-title');
        var by = doc.getElementById('yt-cp-meta-author');
        if (thumb && m.thumbnail) thumb.src = m.thumbnail;
        if (ttl) ttl.textContent = m.title;
        if (by) by.textContent = m.author || '';
        metaReady = true;
        // The panel is chrome, not a popup: it appears with the controls and leaves
        // with them. Showing it on arrival while the transport is already hidden
        // would strand it on screen, because nothing else ever hides it.
        if (trVisible) metaShow();
    }

    function metaShow() {
        var el = global.document && global.document.getElementById('yt-cp-meta');
        if (el) { try { el.style.opacity = '1'; } catch (e) { } }
    }

    function hideVideoMeta() {
        var el = global.document && global.document.getElementById('yt-cp-meta');
        if (el) { try { el.style.opacity = '0'; } catch (e) { } }
    }

    function chainToast(item, dir) {
        var doc = global.document;
        if (!doc || !item) return;
        var host = menuHost();
        if (!host) return;
        var el = doc.getElementById('yt-cp-chain-toast');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'yt-cp-chain-toast';
            el.style.cssText = 'position:absolute;left:0;right:0;top:8%;z-index:60;text-align:center;' +
                'pointer-events:none;opacity:0;transition:opacity .4s;';
            host.appendChild(el);
        }
        var mark = dir < 0 ? '\u25c0 ' : (dir > 0 ? '\u25b6 ' : '');
        el.textContent = mark + (item.title || item.id);
        try { el.style.opacity = '1'; } catch (e) { }
        if (chainToastTimer) clearTimeout(chainToastTimer);
        chainToastTimer = setTimeout(function () {
            try { if (el) el.style.opacity = '0'; } catch (e2) { }
        }, 4000);
    }

    /* One place that actually switches video: rewrites the hash (so the app's
       watch screen follows), drops the finished session and starts the target.
       dir is +1 for forward, -1 for backward. */
    var CHAIN_SKIP_TRIES = 8;    // how many dead candidates a manual skip may roll through
    var chainSkipTries = 0;

    function chainGo(entry, dir, manual) {
        if (!entry || !entry.id || chainBusy) return false;
        var cur = active ? active.id : getVideoId();
        if (!manual && cur && getVideoId() !== cur) return false;   // app is navigating on its own
        chainBusy = true;
        chainPendingFor = '';
        chainAdvanceTo(entry);
        beacon(dir < 0 ? 'CP_CHAIN_PREV' : 'CP_CHAIN_NEXT', { from: cur, to: entry.id, title: entry.title });
        /* Keep the ranking we are walking plus the video it belongs to: if the
           target turns out to be dead we have to carry on down THIS list, not
           ask for the dead video's own (empty) one. */
        var fromId = cur || '';
        var fromList = chainItems.slice();
          chainNavigate(entry.id);
          var el = global.document && global.document.querySelector('.html5-main-video');
          stopActive();                     // clears chainItems and chainBusy, so set it again
          chainBusy = true;
          // no manual warm-up here: start() -> loadChain() resolves the following
          // link itself, and prefetching first would evict the payload we are
          // about to consume for entry.id
          if (el) {

            startById(entry.id, el, function (ok) {
                chainBusy = false;
                /* Rewriting the hash makes the app re-enter the watch screen, and
                   its idle takeover starts the target on its own. startFromInfo
                   then bails out with cb(false) because a session already exists,
                   which is a success, not a dead candidate: rolling on here used
                   to skip through the whole ranking and leave the user on some
                   unrelated video. */
                if (ok || (active && active.id === entry.id)) {
                    chainSkipTries = 0;
                    chainToast(entry, dir);
                    return;
                }
                /* A candidate the backend cannot resolve (removed, private,
                   region locked) used to leave the remote on a dead screen with
                   no session: the hash moved but nothing ever started. Roll on to
                   the next entry of the list we came from, for as long as the
                   user keeps skipping. */
                if (manual && dir > 0 && chainSkipTries < CHAIN_SKIP_TRIES) {
                    chainSkipTries++;
                    chainItems = fromList.filter(function (it) { return it && it.id !== entry.id; });
                    chainFor = fromId;
                    beacon('CP_CHAIN_SKIP_FAIL', { id: entry.id, try: chainSkipTries, left: chainItems.length });
                    chainNext(fromId, true);
                } else {
                    chainSkipTries = 0;
                    chainNotice('Видео недоступно');
                }
            });
        } else {
            chainBusy = false;
        }
        return true;
    }

    function chainNext(currentId, manual) {
        if (chainBusy) return false;
        if (!manual && !chainEnabled()) return false;
        var cur = currentId || (active ? active.id : getVideoId());
        if (!cur) return false;
        if (!chainItems.length) {
            if (chainEmptyFor === cur) {
                if (!manual) return false;         // nothing to roll over to
                return true;                        // manual: swallow, do not retry
            }
            if (manual) { loadChain(cur, function () { chainNext(cur, true); }); return true; }
            loadChain(cur);
            return false;
        }
        var next = pickChainItem(cur);
        if (!next) {
            // ranking exhausted: look for a fresh list before giving up
            if (chainFor !== cur) { loadChain(cur, manual ? function () { chainNext(cur, true); } : null); return manual === true; }
            beacon('CP_CHAIN_DONE', { id: cur });
            return false;
        }
        chainItems.shift();
        if (chainPlayed.indexOf(next.id) < 0) chainPlayed.push(next.id);
        return chainGo({ id: next.id, title: next.title }, 1, manual);
    }

    /* Transport "skip forward" / "skip backward". Forward walks back through
       visited videos first, then continues down the up-next ranking; backward
       walks the session history. Both work even with endless playback off. */
    function chainSkipNext() {
        if (!active || chainBusy) return false;
        var hist = chainNextItem();
        if (hist) return chainGo(hist, 1, true);
        return chainNext(active.id, true);
    }

    function chainSkipPrev() {
        if (!active || chainBusy) return false;
        var hist = chainPrevItem();
        if (!hist) { beacon('CP_CHAIN_PREV_NONE', { id: active.id }); return false; }
        return chainGo(hist, -1, true);
    }

    function chainCheck() {
        if (!chainEnabled() || !active || !active.engEl) return;
        if (chainBusy) return;
        if (chainPendingFor === active.id) return;
        if (getVideoId() !== active.id) return;             // app-driven nav wins
        var el = active.engEl, dur = el.duration;
        if (el.ended) { chainPendingFor = active.id; chainNext(active.id); return; }
        if (el.paused) return;                              // user paused: do not jump
        if (!(isFinite(dur) && dur > 0)) return;            // live stream
        if (dur - (el.currentTime || 0) > 1.5) return;
        if (chainPrefetchedFor !== active.id) {
            chainPrefetchedFor = active.id;
            var nxt = pickChainItem(active.id);
            if (nxt) chainPrefetch(nxt.id);                 // warm the cache once
        }
        chainPendingFor = active.id;
        chainNext(active.id);
    }

    function chainOnEnded() {
        if (!active) return;
        beacon('CP_ENDED', { id: active.id });
        chainCheck();
    }

    /* ---- related videos panel ----
       The video fills the whole screen (both #watch and #player are 100%x100%
       in this app), so there is no room "below" it: the list is a drawer over
       the right edge, the way a TV client shows its queue. It is fed by the
       ranking /api/related already resolves for the endless chain, so opening
       the panel during playback costs nothing. */

    var relPanel = null;
    var relScroll = null;
    var relStatus = null;
    var relRows = [];          // row elements
    var relItems = [];         // row payloads
    var relIdx = 0;
    var relOpen = false;
    var relBtn = null;         // our transport button
    var REL_MAX = 20;

    function relOpenNow() { return !!(relPanel && relPanel.style.display !== 'none'); }

    function relCandidates() {
        var cur = active ? active.id : getVideoId();
        var out = [], seen = {}, i, it;
        for (i = 0; i < chainItems.length && out.length < REL_MAX; i++) {
            it = chainItems[i];
            if (!it || !it.id || it.id === cur || seen[it.id]) continue;
            seen[it.id] = true;
            out.push(it);
        }
        return out;
    }

    function relPanelStyle() {
        var vw = global.innerWidth || 1280;
        return 'position:fixed;right:0;top:0;bottom:0;z-index:2147482900;' +
            'width:' + Math.round(Math.min(430, Math.max(300, vw * 0.3))) + 'px;' +
            'display:none;flex-direction:column;box-sizing:border-box;' +
            'background:rgba(18,18,18,.94);border-left:2px solid #3a3a3a;' +
            'box-shadow:-4px 0 24px rgba(0,0,0,.6);pointer-events:auto;' +
            'font:normal 18px/1.35 Roboto,Arial,Helvetica,sans-serif;color:#fff;';
    }

    function buildRelPanel() {
        var host = relPanel && relPanel.parentNode ? relPanel.parentNode : null;
        // the app re-renders the player's children, so a cached node can end up
        // detached; drop it and rebuild rather than toggling a node nobody sees
        if (relPanel && host !== overlayHost()) {
            relPanel = null;
            relRows = [];
            relScroll = null;
            relStatus = null;
        }
        if (relPanel) return relPanel;
        var doc = global.document;
        if (!doc || !doc.createElement) return null;
        host = overlayHost();
        if (!host) return null;
        var el = doc.createElement('div');
        el.id = 'yt-cp-related';
        el.style.cssText = relPanelStyle();

        var head = doc.createElement('div');
        head.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:12px;' +
            'padding:18px 20px 12px;border-bottom:1px solid #333;';
        var title = doc.createElement('div');
        title.id = 'yt-cp-related-title';
        title.style.cssText = 'flex:1 1 auto;font-size:22px;font-weight:500;';
        title.textContent = 'Похожие видео';
        var close = doc.createElement('div');
        close.className = 'yt-cp-rel-close';
        close.style.cssText = 'flex:0 0 auto;padding:4px 12px;border:1px solid #555;border-radius:3px;' +
            'color:#bbb;font-size:16px;cursor:pointer;';
        close.textContent = '✕';
        close.addEventListener('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            closeRelPanel();
        });
        head.appendChild(title);
        head.appendChild(close);

        relStatus = doc.createElement('div');
        relStatus.id = 'yt-cp-related-status';
        relStatus.style.cssText = 'flex:0 0 auto;padding:14px 20px;color:#9a9a9a;font-size:17px;display:none;';

        relScroll = doc.createElement('div');
        relScroll.id = 'yt-cp-related-list';
        relScroll.style.cssText = 'flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:8px 10px 40%;';

        el.appendChild(head);
        el.appendChild(relStatus);
        el.appendChild(relScroll);
        try { host.appendChild(el); } catch (e) { return null; }
        el.addEventListener('mousedown', function (e) { if (e.stopPropagation) e.stopPropagation(); }, true);
        el.addEventListener('click', function (e) {
            // the byline badge opens the channel; the rest of the row plays
            var badge = e.target && e.target.closest ? e.target.closest('.yt-cp-rel-channel') : null;
            if (badge) {
                var brow = relRowOf(e.target);
                if (!brow) return;
                var bidx = parseInt(brow.getAttribute('data-idx'), 10);
                if (isNaN(bidx)) return;
                var bit = relItems[bidx];
                if (bit && bit.authorId) {
                    if (e.preventDefault) e.preventDefault();
                    closeRelPanel();
                    openChannel(bit.authorId);
                }
                return;
            }
            var row = relRowOf(e.target);
            if (!row) return;
            var idx = parseInt(row.getAttribute('data-idx'), 10);
            if (isNaN(idx)) return;
            relIdx = idx;
            playRelRow(idx);
        });
        el.addEventListener('mousemove', function (e) {
            var row = relRowOf(e.target);
            if (!row) return;
            var idx = parseInt(row.getAttribute('data-idx'), 10);
            if (isNaN(idx) || idx === relIdx) return;
            relIdx = idx;
            highlightRelRow();
        });
        relPanel = el;
        return relPanel;
    }

    function relRowOf(t) {
        if (t && t.closest) return t.closest('.yt-cp-rel-row');
        for (var n = t; n && n !== relPanel; n = n.parentNode) {
            if (n && n.getAttribute && /(^|\s)yt-cp-rel-row(\s|$)/.test(n.getAttribute('class') || '')) return n;
        }
        return null;
    }

    function relRow(item, idx) {
        var doc = global.document;
        var row = doc.createElement('div');
        row.className = 'yt-cp-rel-row';
        row.setAttribute('data-idx', String(idx));
        // focusable, or the app's own focus model keeps the remote and the
        // cursor never moves (same reason the quality rows carry tabindex)
        try { row.setAttribute('tabindex', '-1'); } catch (e) { }
        row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;padding:8px;' +
            'margin-bottom:4px;border-radius:3px;cursor:pointer;color:#fff;';

        var thumbWrap = doc.createElement('div');
        thumbWrap.style.cssText = 'position:relative;flex:0 0 auto;width:168px;height:94px;' +
            'background:#000;border-radius:3px;overflow:hidden;';
        var img = doc.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        if (item.thumb) img.src = item.thumb;
        else img.alt = '';
        thumbWrap.appendChild(img);
        if (item.duration) {
            var dur = doc.createElement('div');
            dur.style.cssText = 'position:absolute;right:4px;bottom:4px;padding:1px 5px;' +
                'background:rgba(0,0,0,.8);border-radius:2px;font-size:14px;color:#fff;';
            dur.textContent = item.duration;
            thumbWrap.appendChild(dur);
        }

        var box = doc.createElement('div');
        box.style.cssText = 'flex:1 1 auto;min-width:0;';
        var t = doc.createElement('div');
        t.style.cssText = 'font-size:18px;line-height:1.25;max-height:2.6em;overflow:hidden;';
        t.textContent = item.title || item.id;
        var meta = [];
        if (item.author) meta.push(item.author);
        if (item.live) meta.push('эфир');
        if (item.short) meta.push('Shorts');
        if (item.autoplay) meta.push('YouTube: дальше');
        // byline and the channel badge share a row: the text truncates instead of
        // wrapping, otherwise a long author line pushes the badge out of the box
        var by = doc.createElement('div');
        by.className = 'yt-cp-rel-meta';
        by.style.cssText = 'margin-top:5px;font-size:15px;color:#b0b0b0;' +
            'display:flex;align-items:center;gap:8px;max-height:2.4em;overflow:hidden;';
        var byText = doc.createElement('span');
        byText.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap;';
        byText.textContent = meta.join(' · ');
        by.appendChild(byText);
        box.appendChild(t);
        box.appendChild(by);

        // "open this channel" affordance, only where the byline actually named a
        // channel (the bare autoplay endpoint has no authorId)
        if (item.authorId) {
            var ch = doc.createElement('span');
            ch.className = 'yt-cp-rel-channel';
            ch.style.cssText = 'flex:0 0 auto;padding:1px 8px;' +
                'border:1px solid currentColor;border-radius:10px;font-size:13px;opacity:.75;';
            ch.textContent = 'Канал';
            by.appendChild(ch);
        }

        row.appendChild(thumbWrap);
        row.appendChild(box);
        return row;
    }

    function relSetStatus(text) {
        if (!relStatus) return;
        if (!text) { relStatus.style.display = 'none'; relStatus.textContent = ''; return; }
        relStatus.textContent = text;
        relStatus.style.display = 'block';
    }

    function renderRelPanel() {
        if (!buildRelPanel()) return;
        var items = relCandidates();
        relItems = items;
        while (relScroll.firstChild) relScroll.removeChild(relScroll.firstChild);
        relRows = [];
        if (!items.length) {
            relSetStatus(relLoading() ? 'Загрузка подборки…' : 'Подборка недоступна');
            highlightRelRow();
            return;
        }
        relSetStatus('');
        for (var i = 0; i < items.length; i++) {
            var row = relRow(items[i], i);
            relRows.push(row);
            relScroll.appendChild(row);
        }
        if (relIdx >= items.length) relIdx = items.length - 1;
        if (relIdx < 0) relIdx = 0;
        highlightRelRow();
    }

    function relLoading() {
        var cur = active ? active.id : getVideoId();
        return !!(cur && chainLoadingFor === cur);
    }

    function highlightRelRow() {
        var i, on;
        for (i = 0; i < relRows.length; i++) {
            on = (i === relIdx);
            relRows[i].style.background = on ? '#fff' : 'transparent';
            relRows[i].style.color = on ? '#111' : '#fff';
            // only the byline carries its own colour; the title inherits the row
            var meta = relRows[i].getElementsByClassName('yt-cp-rel-meta');
            if (meta.length) meta[0].style.color = on ? '#555' : '#b0b0b0';
            if (on) {
                // hold the DOM focus so the app's keydown handler does not walk
                // its own focus tree while our cursor sits still
                try { relRows[i].focus(); } catch (e) { }
                try { relRows[i].scrollIntoView({ block: 'nearest' }); } catch (e2) { }
            }
        }
    }

    function moveRelRow(dir) {
        if (!relRows.length) return;
        relIdx = ((relIdx + dir) % relRows.length + relRows.length) % relRows.length;
        highlightRelRow();
    }

    function playRelRow(idx) {
        var it = relItems[idx];
        if (!it || !it.id) return;
        beacon('CP_REL_PICK', { id: it.id, idx: idx, n: relItems.length });
        closeRelPanel();
        if (it.id === (active ? active.id : '')) { showTransport(); return; }
        chainGo(it, 1, true);
    }

    function openRelPanel() {
        if (!buildRelPanel()) return false;
        relOpen = true;
        relPanel.style.display = 'flex';
        relIdx = 0;
        renderRelPanel();
        // the ranking may still be in flight when the panel is summoned
        var cur = active ? active.id : getVideoId();
        if (cur && !chainItems.length && !chainLoadingFor && chainEmptyFor !== cur) loadChain(cur);
        if (relBtn) { try { relBtn.blur(); } catch (e) { } }
        showTransport();
        beacon('CP_REL_OPEN', { id: cur, n: relItems.length });
        return true;
    }

    function closeRelPanel() {
        if (!relPanel) return;
        relPanel.style.display = 'none';
        relOpen = false;
        beacon('CP_REL_CLOSE', {});
    }

    function toggleRelPanel() {
        if (relOpenNow()) { closeRelPanel(); return true; }
        return openRelPanel();
    }

    function relPanelKey(e) {
        if (!relOpenNow()) return false;
        var code = e.keyCode || e.which || 0;
        var map = { 8: 'Back', 13: 'Enter', 27: 'Escape', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
        var key = e.key || '';
        if (map[code]) key = map[code];
        if (key === 'Backspace') key = 'Back';
        var handled = true;
        switch (key) {
            case 'ArrowDown':
                moveRelRow(1);
                break;
            case 'ArrowUp':
                moveRelRow(-1);
                break;
            case 'ArrowRight':
            case 'ArrowLeft':
            case 'Escape':
            case 'Back':
                closeRelPanel();
                break;
            case 'Enter':
            case ' ':
            case 'space':
                playRelRow(relIdx);
                break;
            default:
                handled = false;
        }
        if (!handled) return false;
        // browsing the list counts as player activity, otherwise the transport
        // (and with it the drawer) times out from under the user's finger
        showTransport();
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return true;
    }

    /* ---- channel panel ----
       Opens a public channel by id, @handle or url, with the same drawer and
       key model as the related panel so the remote behaves identically. The
       body comes from /api/channel, which answers with shelves of videos; Left
       and Right walk the channel's tabs, Down past the end pages in more. */

    var chnPanel = null;
    var chnScroll = null;
    var chnStatus = null;
    var chnRows = [];
    var chnItems = [];        // flat row payloads, across shelves
    var chnIdx = 0;
    var chnOpen = false;
    var chnKey = '';          // what the user asked for, for retries
    var chnTabIdx = 0;
    var chnData = null;       // last /api/channel answer
    var chnLoading = false;
    var chnRequest = 0;
    var CHN_TABS = [
        { key: 'home', label: 'Главная' },
        { key: 'videos', label: 'Видео' },
        { key: 'shorts', label: 'Shorts' },
        { key: 'live', label: 'Эфиры' }
    ];

    function chnOpenNow() { return !!(chnPanel && chnPanel.style.display !== 'none'); }

    function chnPanelStyle() {
        var vw = global.innerWidth || 1280;
        return 'position:fixed;right:0;top:0;bottom:0;z-index:2147482899;' +
            'width:' + Math.round(Math.min(520, Math.max(320, vw * 0.36))) + 'px;' +
            'display:none;flex-direction:column;box-sizing:border-box;' +
            'background:rgba(15,15,15,.96);border-left:2px solid #3a3a3a;' +
            'box-shadow:-4px 0 24px rgba(0,0,0,.6);pointer-events:auto;' +
            'font:normal 18px/1.35 Roboto,Arial,Helvetica,sans-serif;color:#fff;';
    }

    function chnBuildPanel() {
        var host = chnPanel && chnPanel.parentNode ? chnPanel.parentNode : null;
        // same stale-host guard as the related drawer: the app re-renders the
        // player's children, so a cached node can end up detached
        if (chnPanel && host !== overlayHost()) {
            chnPanel = null;
            chnRows = [];
            chnScroll = null;
            chnStatus = null;
        }
        if (chnPanel) return chnPanel;
        var doc = global.document;
        if (!doc || !doc.createElement) return null;
        host = overlayHost();
        if (!host) return null;
        var el = doc.createElement('div');
        el.id = 'yt-cp-channel';
        el.style.cssText = chnPanelStyle();

        var head = doc.createElement('div');
        head.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:10px;' +
            'padding:14px 16px 10px;border-bottom:1px solid #333;';
        var avatar = doc.createElement('img');
        avatar.id = 'yt-cp-channel-avatar';
        avatar.style.cssText = 'flex:0 0 auto;width:48px;height:48px;border-radius:50%;' +
            'object-fit:cover;background:#222;display:none;';
        var box = doc.createElement('div');
        box.style.cssText = 'flex:1 1 auto;min-width:0;';
        var title = doc.createElement('div');
        title.id = 'yt-cp-channel-title';
        title.style.cssText = 'font-size:21px;font-weight:500;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap;';
        title.textContent = 'Канал';
        var sub = doc.createElement('div');
        sub.id = 'yt-cp-channel-sub';
        sub.style.cssText = 'font-size:15px;color:#9a9a9a;margin-top:2px;';
        var close = doc.createElement('div');
        close.className = 'yt-cp-ch-close';
        close.style.cssText = 'flex:0 0 auto;padding:4px 12px;border:1px solid #555;border-radius:3px;' +
            'color:#bbb;font-size:16px;cursor:pointer;';
        close.textContent = '✕';
        close.addEventListener('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            closeChannel();
        });
        box.appendChild(title);
        box.appendChild(sub);
        head.appendChild(avatar);
        head.appendChild(box);
        head.appendChild(close);

        var tabs = doc.createElement('div');
        tabs.id = 'yt-cp-channel-tabs';
        tabs.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;padding:10px 16px;' +
            'border-bottom:1px solid #2a2a2a;overflow:hidden;';
        for (var i = 0; i < CHN_TABS.length; i++) {
            (function (tab, n) {
                var b = doc.createElement('div');
                b.className = 'yt-cp-ch-tab';
                b.setAttribute('data-tab', String(n));
                b.setAttribute('tabindex', '-1');
                b.style.cssText = 'padding:5px 12px;border:1px solid #444;border-radius:14px;' +
                    'font-size:15px;color:#bbb;white-space:nowrap;';
                b.textContent = tab.label;
                b.addEventListener('click', function (e) {
                    if (e && e.preventDefault) e.preventDefault();
                    if (e && e.stopPropagation) e.stopPropagation();
                    chnGoTab(n);
                });
                tabs.appendChild(b);
            })(CHN_TABS[i], i);
        }

        chnStatus = doc.createElement('div');
        chnStatus.id = 'yt-cp-channel-status';
        chnStatus.style.cssText = 'flex:0 0 auto;padding:14px 16px;color:#9a9a9a;font-size:17px;display:none;';

        chnScroll = doc.createElement('div');
        chnScroll.id = 'yt-cp-channel-list';
        chnScroll.style.cssText = 'flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:8px 10px 40%;';

        el.appendChild(head);
        el.appendChild(tabs);
        el.appendChild(chnStatus);
        el.appendChild(chnScroll);
        try { host.appendChild(el); } catch (e) { return null; }
        el.addEventListener('mousedown', function (e) { if (e.stopPropagation) e.stopPropagation(); }, true);
        el.addEventListener('click', function (e) {
            var row = chnRowOf(e.target);
            if (row) {
                var idx = parseInt(row.getAttribute('data-idx'), 10);
                if (!isNaN(idx)) { chnIdx = idx; playChnRow(idx); }
                return;
            }
            var tab = e.target && e.target.closest ? e.target.closest('.yt-cp-ch-tab') : null;
            if (tab) {
                var n = parseInt(tab.getAttribute('data-tab'), 10);
                if (!isNaN(n)) chnGoTab(n);
            }
        });
        el.addEventListener('mousemove', function (e) {
            var row = chnRowOf(e.target);
            if (!row) return;
            var idx = parseInt(row.getAttribute('data-idx'), 10);
            if (isNaN(idx) || idx === chnIdx) return;
            chnIdx = idx;
            chnHighlight();
        });
        chnPanel = el;
        return chnPanel;
    }

    function chnRowOf(t) {
        if (t && t.closest) return t.closest('.yt-cp-ch-row');
        for (var n = t; n && n !== chnPanel; n = n.parentNode) {
            if (n && n.getAttribute && /(^|\s)yt-cp-ch-row(\s|$)/.test(n.getAttribute('class') || '')) return n;
        }
        return null;
    }

    function chnRow(item, idx, shelfTitle, first) {
        var doc = global.document;
        var row = doc.createElement('div');
        row.className = 'yt-cp-ch-row';
        row.setAttribute('data-idx', String(idx));
        // focusable, or the app's own focus model keeps the remote and the
        // cursor never moves (same reason the related rows carry tabindex)
        try { row.setAttribute('tabindex', '-1'); } catch (e) { }
        row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;padding:8px;' +
            'margin-bottom:4px;border-radius:3px;cursor:pointer;color:#fff;';

        var thumbWrap = doc.createElement('div');
        // shorts are vertical, so give them a narrower box instead of cropping
        var wide = !item.short;
        thumbWrap.style.cssText = 'position:relative;flex:0 0 auto;width:' + (wide ? '168px' : '84px') +
            ';height:94px;background:#000;border-radius:3px;overflow:hidden;';
        var img = doc.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        if (item.thumb) img.src = item.thumb;
        else img.alt = '';
        thumbWrap.appendChild(img);
        if (item.duration) {
            var dur = doc.createElement('div');
            dur.style.cssText = 'position:absolute;right:4px;bottom:4px;padding:1px 5px;' +
                'background:rgba(0,0,0,.8);border-radius:2px;font-size:14px;color:#fff;';
            dur.textContent = item.duration;
            thumbWrap.appendChild(dur);
        }
        if (item.live) {
            var live = doc.createElement('div');
            live.style.cssText = 'position:absolute;left:4px;top:4px;padding:1px 5px;' +
                'background:#c00;border-radius:2px;font-size:13px;color:#fff;';
            live.textContent = 'ЭФИР';
            thumbWrap.appendChild(live);
        }

        var box = doc.createElement('div');
        box.style.cssText = 'flex:1 1 auto;min-width:0;';
        if (first && shelfTitle) {
            var sh = doc.createElement('div');
            sh.className = 'yt-cp-ch-shelf';
            sh.style.cssText = 'font-size:14px;color:#8a8a8a;margin-bottom:5px;';
            sh.textContent = shelfTitle;
            box.appendChild(sh);
        }
        var t = doc.createElement('div');
        t.style.cssText = 'font-size:18px;line-height:1.25;max-height:2.6em;overflow:hidden;';
        t.textContent = item.title || item.id;
        var meta = [];
        if (item.author) meta.push(item.author);
        else if (chnData && chnData.title) meta.push(chnData.title);
        if (item.published) meta.push(item.published);
        if (item.views && !item.published) meta.push(item.views);
        if (item.short) meta.push('Shorts');
        var by = doc.createElement('div');
        by.className = 'yt-cp-ch-meta';
        by.style.cssText = 'margin-top:5px;font-size:15px;color:#b0b0b0;' +
            'max-height:2.4em;overflow:hidden;';
        by.textContent = meta.join(' · ');
        box.appendChild(t);
        box.appendChild(by);

        row.appendChild(thumbWrap);
        row.appendChild(box);
        return row;
    }

    function chnSetStatus(text) {
        if (!chnStatus) return;
        if (!text) { chnStatus.style.display = 'none'; chnStatus.textContent = ''; return; }
        chnStatus.textContent = text;
        chnStatus.style.display = 'block';
    }

    function chnFlatItems(data) {
        var out = [];
        var shelves = (data && data.shelves) || [];
        for (var i = 0; i < shelves.length; i++) {
            var items = shelves[i].items || [];
            for (var j = 0; j < items.length; j++) {
                out.push({ item: items[j], shelf: shelves[i].title || '' });
            }
        }
        return out;
    }

    function chnRender() {
        if (!chnBuildPanel()) return;
        var flat = chnFlatItems(chnData);
        chnItems = flat;
        while (chnScroll.firstChild) chnScroll.removeChild(chnScroll.firstChild);
        chnRows = [];

        var doc = global.document;
        var d = chnData;
        if (d) {
            var t = doc.getElementById('yt-cp-channel-title');
            if (t) t.textContent = d.title || 'Канал';
            var bits = [];
            if (d.handle) bits.push(d.handle);
            if (d.subscriberText) bits.push(d.subscriberText);
            if (d.videosText) bits.push(d.videosText);
            var s = doc.getElementById('yt-cp-channel-sub');
            if (s) s.textContent = bits.join(' · ');
            var av = doc.getElementById('yt-cp-channel-avatar');
            if (av) {
                if (d.avatar) { av.src = d.avatar; av.style.display = 'block'; }
                else av.style.display = 'none';
            }
        }
        chnSyncTabs();

        if (chnLoading && !flat.length) {
            chnSetStatus('Загрузка канала…');
            return;
        }
        if (!flat.length) {
            var why = 'В канале нет видео';
            if (chnData && chnData.error) why = chnData.error;
            chnSetStatus(chnLoading ? 'Загрузка канала…' : why);
            chnHighlight();
            return;
        }
        chnSetStatus('');

        var lastShelf = '';
        for (var i = 0; i < flat.length; i++) {
            var first = flat[i].shelf !== lastShelf;
            if (flat[i].shelf) lastShelf = flat[i].shelf;
            var row = chnRow(flat[i].item, i, flat[i].shelf, first);
            chnRows.push(row);
            chnScroll.appendChild(row);
        }
        if (chnIdx >= flat.length) chnIdx = flat.length - 1;
        if (chnIdx < 0) chnIdx = 0;
        chnHighlight();
    }

    function chnSyncTabs() {
        var doc = global.document;
        if (!doc) return;
        var host = doc.getElementById('yt-cp-channel-tabs');
        if (!host) return;
        var btns = host.getElementsByClassName('yt-cp-ch-tab');
        for (var i = 0; i < btns.length; i++) {
            var on = (i === chnTabIdx);
            btns[i].style.background = on ? '#fff' : 'transparent';
            btns[i].style.color = on ? '#111' : '#bbb';
            btns[i].style.borderColor = on ? '#fff' : '#444';
        }
    }

    function chnHighlight() {
        for (var i = 0; i < chnRows.length; i++) {
            var on = (i === chnIdx);
            chnRows[i].style.background = on ? '#fff' : 'transparent';
            chnRows[i].style.color = on ? '#111' : '#fff';
            // only the byline carries its own colour; the title inherits the row
            var meta = chnRows[i].getElementsByClassName('yt-cp-ch-meta');
            if (meta.length) meta[0].style.color = on ? '#555' : '#b0b0b0';
            var shelf = chnRows[i].getElementsByClassName('yt-cp-ch-shelf');
            if (shelf.length) shelf[0].style.color = on ? '#777' : '#8a8a8a';
            if (on) {
                // hold the DOM focus so the app's keydown handler does not walk
                // its own focus tree while our cursor sits still
                try { chnRows[i].focus(); } catch (e) { }
                try { chnRows[i].scrollIntoView({ block: 'nearest' }); } catch (e2) { }
            }
        }
    }

    function chnMove(dir) {
        if (!chnRows.length) return;
        var n = ((chnIdx + dir) % chnRows.length + chnRows.length) % chnRows.length;
        chnIdx = n;
        chnHighlight();
        // one row past the end is the "load more" stop
        if (dir > 0 && chnIdx >= chnRows.length - 1) chnLoadMore();
    }

    function playChnRow(idx) {
        var entry = chnItems[idx];
        var it = entry && entry.item;
        if (!it || !it.id) return;
        beacon('CP_CHN_PICK', { id: it.id, idx: idx, n: chnItems.length, ch: chnData && chnData.id });
        closeChannel();
        if (it.id === (active ? active.id : '')) { showTransport(); return; }
        chainGo(it, 1, true);
    }

    function chnUrl(tab, continuation) {
        var u = base + '/api/channel/' + encodeURIComponent(chnKey) + '?tab=' + encodeURIComponent(tab);
        if (continuation) u += '&continuation=' + encodeURIComponent(continuation);
        return u;
    }

    function chnFetch(tab, continuation) {
        if (!chnKey) return;
        chnLoading = true;
        var req = ++chnRequest;
        if (!continuation) {
            chnData = null;
            chnIdx = 0;
            chnRender();
        }
        xhrText(chnUrl(tab, continuation), function (res) {
            if (req !== chnRequest) return;
            chnLoading = false;
            if (!res) {
                chnData = chnData || { shelves: [], error: 'Канал недоступен' };
                if (chnOpenNow()) chnRender();
                beacon('CP_CHN_FAIL', { ch: chnKey, tab: tab, paged: !!continuation });
                return;
            }
            var data = null;
            try { data = JSON.parse(res); } catch (e) {
                beacon('CP_CHN_BADJSON', { ch: chnKey, tab: tab });
                chnData = chnData || { shelves: [], error: 'Канал недоступен' };
                if (chnOpenNow()) chnRender();
                return;
            }
            var appended = false;
            if (continuation) {
                // keep what is on screen and append the page
                var base0 = chnData || { shelves: [] };
                var more = (data && data.shelves) || [];
                for (var i = 0; i < more.length; i++) {
                    base0.shelves.push({ title: more[i].title || '', items: more[i].items || [] });
                }
                chnData = base0;
                chnData.continuation = data.continuation || null;
                // the page answer counts only its own items, so the running
                // total has to be rebuilt after appending
                var total = 0;
                for (var s = 0; s < chnData.shelves.length; s++) {
                    total += (chnData.shelves[s].items || []).length;
                }
                chnData.videoCount = total;
                appended = true;
            } else {
                chnData = data;
            }
            if (!chnOpenNow()) return;
            // a re-render wipes the scroll position, so put it back or the list
            // jumps to the top every time a page is appended
            var keepScroll = appended ? chnScroll.scrollTop : 0;
            chnRender();
            if (keepScroll) { try { chnScroll.scrollTop = keepScroll; } catch (e) { } }
        });
    }

    function chnLoadMore() {
        if (chnLoading) return;
        if (!chnData || !chnData.continuation) return;
        beacon('CP_CHN_MORE', { ch: chnData.id, n: chnItems.length });
        chnFetch((chnData && chnData.tab) || CHN_TABS[chnTabIdx].key, chnData.continuation);
    }

    function chnGoTab(n) {
        if (n < 0 || n >= CHN_TABS.length || n === chnTabIdx) return;
        chnTabIdx = n;
        chnFetch(CHN_TABS[n].key, null);
        chnSyncTabs();
    }

    function openChannel(key, tab) {
        if (!key) return false;
        if (!chnBuildPanel()) return false;
        chnOpen = true;
        chnPanel.style.display = 'flex';
        chnKey = String(key);
        if (tab) {
            for (var i = 0; i < CHN_TABS.length; i++) {
                if (CHN_TABS[i].key === tab) { chnTabIdx = i; break; }
            }
        } else {
            chnTabIdx = 0;
        }
        chnFetch(CHN_TABS[chnTabIdx].key, null);
        if (chnPanel.focus) { try { chnPanel.blur(); } catch (e) { } }
        showTransport();
        beacon('CP_CHN_OPEN', { ch: chnKey, tab: CHN_TABS[chnTabIdx].key });
        return true;
    }

    function closeChannel() {
        if (!chnPanel) return;
        chnPanel.style.display = 'none';
        chnOpen = false;
        chnRequest++;                 // drop an in-flight answer for a closed panel
        beacon('CP_CHN_CLOSE', {});
    }

    function chnPanelKey(e) {
        if (!chnOpenNow()) return false;
        var code = e.keyCode || e.which || 0;
        var map = { 8: 'Back', 13: 'Enter', 27: 'Escape', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
        var key = e.key || '';
        if (map[code]) key = map[code];
        if (key === 'Backspace') key = 'Back';
        var handled = true;
        switch (key) {
            case 'ArrowDown':
                chnMove(1);
                break;
            case 'ArrowUp':
                chnMove(-1);
                break;
            case 'ArrowRight':
                chnGoTab(chnTabIdx + 1 >= CHN_TABS.length ? 0 : chnTabIdx + 1);
                break;
            case 'ArrowLeft':
                chnGoTab(chnTabIdx - 1 < 0 ? CHN_TABS.length - 1 : chnTabIdx - 1);
                break;
            case 'Escape':
            case 'Back':
                closeChannel();
                break;
            case 'Enter':
            case ' ':
            case 'space':
                playChnRow(chnIdx);
                break;
            default:
                handled = false;
        }
        if (!handled) return false;
        // browsing the list counts as player activity, otherwise the transport
        // (and with it the drawer) times out from under the user's finger
        showTransport();
        if (e.preventDefault) e.preventDefault();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return true;
    }

    function relLabelSync() {
        var b = relBtn;
        if (!b) return;
        var n = relCandidates().length;
        var t = n ? 'Похожие (' + n + ')' : 'Похожие';
        var lab = b.querySelector('.label');
        if (lab && lab.textContent !== t) lab.textContent = t;
    }

    /* The quality button carries the level in effect, so the row answers the
       "what am I watching right now" question without opening the menu. */
    function trQualityLabelSync() {
        var b = trBtnEls && trBtnEls['yt-cp-qbtn'];
        if (!b) return;
        var lab = b.querySelector('.label');
        var t = 'Качество: ' + qualityLabel();
        if (lab && lab.textContent !== t) lab.textContent = t;
    }

    readStoredQuality();
    readChainPref();

    function syncUI() {
        try {
            var bhalf = global.document && global.document.getElementById('bottom-half');
            if (bhalf && bhalf.style.pointerEvents !== 'none') bhalf.style.pointerEvents = 'none'; // the app's nav backdrop otherwise swallows every click on the transport
            // the top title-tray follows the transport: it hides together with the navigation
            var tray = global.document && global.document.getElementById('title-tray');
            if (tray) {
                try {
                    var tcn = trEl();
                    var trayHidden = !!(tcn && tcn.className && tcn.className.indexOf('hidden') >= 0);
                    var want = trayHidden ? 'none' : 'block';
                    if (tray.style.display !== want) tray.style.display = want;
                } catch (e3) { }
            }
            bindInputElements();
            updateQualityLabel();
            samplePlaybackHealth();
            if (ensureNavRow()) {
                relLabelSync();
                trQualityLabelSync();
                renderTrFocus();
            }
            var tc = trEl();
            if (!tc) { trSeen = false; return; }
            if (!trSeen) {
                trSeen = true;
                trVisible = false;
                setTransport(false);
            }
            if (trVisible) {
                if (Date.now() - lastTrActive > TR_HIDE_MS) {
                    trVisible = false;
                    setTransport(false);
                    if (qMenuOpen()) closeQualityMenu();   // the menu hangs off the transport
                    if (relOpenNow()) closeRelPanel();     // ...and so does the related drawer
                } else setTransport(true);
            } else {
                setTransport(false);
            }
            if (active && active.engEl) {
                var el = active.engEl;
                chainCheck();           // near-end fallback if "ended" never fires
                var ct = el.currentTime || 0;
                var dur = el.duration;
                var live = !(isFinite(dur) && dur > 0);
                var pct = (!live && dur > 0) ? Math.min(100, ((ct / dur) * 100)) : 0;
                // Every one of these writes is guarded: syncUI runs every 150ms
                // and re-assigning an unchanged width/text still counts as a
                // mutation, which the app reacts to on every tick.
                var played = global.document.querySelector('#progress-bar .progress-bar-played');
                var disc = global.document.querySelector('#progress-bar .progress-bar-disc');
                var loaded = global.document.querySelector('#progress-bar .progress-bar-loaded');
                var wPct = pct + '%';
                if (played && played.style.width !== wPct) played.style.width = wPct;
                if (disc && disc.style.left !== wPct) disc.style.left = wPct;
                if (loaded) {
                    var bEnd = 0, i;
                    if (el.buffered) for (i = 0; i < el.buffered.length; i++) bEnd = Math.max(bEnd, el.buffered.end(i));
                    var lPct = (!live && dur > 0 ? Math.min(100, (bEnd / dur) * 100) : 0) + '%';
                    if (loaded.style.width !== lPct) loaded.style.width = lPct;
                }
                var et = global.document.querySelector('#player-time-elapsed');
                var tt = global.document.querySelector('.player-time-total');
                if (et) {
                    var etx = fmtTime(ct);
                    if (et.textContent !== etx) et.textContent = etx;
                    try { if (et.className.indexOf('no-model') >= 0) et.classList.remove('no-model'); } catch (err) { }
                }
                if (tt) {
                    var ttx = live ? '' : fmtTime(dur);
                    if (tt.textContent !== ttx) tt.textContent = ttx;
                }
                try { tc.classList.toggle('live-playback', !!live); } catch (err) { }
                // the app renders skip/rewind/forward greyed out because its own
                // player model never reports a state, we drive all of them
                trSyncIcon();
                // the 2016 app keeps its loading spinner forever because its own
                // player model never reports "started" — hide it once we actually play
                if (el.readyState >= 2 || (el.currentTime || 0) > 0) {
                    var spin = global.document.querySelector('#spinner');
                    if (spin && spin.style.display !== 'none') spin.style.display = 'none';
                    var lid = global.document.querySelector('.loading-indicator');
                    if (lid && lid.style.display !== 'none') lid.style.display = 'none';
                    var fid = global.document.querySelector('.fallback-loading-indicator');
                    if (fid && fid.style.display !== 'none') fid.style.display = 'none';
                }
            }
            if (appSettings.hideOnScreenNav) {
                var legend = global.document.querySelector('#legend');
                if (legend && legend.style.display !== 'none') legend.style.display = 'none';
            }
            // NOTE: #title-tray and .player-video-text (top title + round avatar) are
            // intentionally NOT hidden here — they are the persistent top header now.
            if (!appSettings.showToggleVideoInfo && !infoPanelUser) {
                // the setting only decides whether the panel can be opened from the
                // app's own legend; once the user pressed our Info button the panel
                // is theirs and must survive this tick
                var info = infoPanelEls();
                for (var ii = 0; ii < info.length; ii++) {
                    try { if (info[ii].style.display !== 'none') info[ii].style.display = 'none'; } catch (e2) { }
                }
            }
        } catch (e) { }
    }

    setInterval(syncUI, 150);

    /* ---- input: mouse / touch / remote ----
       All four control paths funnel into the same player actions:
         keys        → handleKey (arrows, space, enter, Esc/Back, media keys)
         remote/LG   → same keydown events (Back=461/8, PlayPause=179, Rewind=412,
                       FF=417/227, Next/Prev track=415/416/413/414) plus Magic
                       Remote pointer = mouse path
         mouse       → hover keeps transport alive, click video toggles play,
                       click/drag the seekbar to scrub, wheel = volume,
                       click transport buttons to activate them
         touch       → tap toggles play, swipe left/right = seek ±10s,
                       swipe up/down = volume, drag the seekbar to scrub */

    function isWatchSurface() { return !!(watchSurface() && trEl()); }

    function isSnapped() {
        var w = watchSurface();
        try { return w ? w.classList.contains('snapped') : false; } catch (e) { return false; }
    }

    function inTransport(t) {
        try { return !!(t && t.closest && t.closest('#transport-controls,#title-tray,#html5-video-info-panel,#yt-cp-quality-menu')); } catch (e) { return false; }
    }

    function inQualityMenu(t) {
        try { return !!(t && t.closest && t.closest('#yt-cp-quality-menu')); } catch (e) { return false; }
    }

    function pokeTransport() { trVisible = true; lastTrActive = Date.now(); setTransport(true); }

    function seekToFrac(f) {
        var el = active && active.engEl;
        if (!el) return;
        var dur = el.duration;
        if (!(isFinite(dur) && dur > 0)) return;
        var nt = Math.max(0, Math.min(dur, f * dur));
        try { el.currentTime = nt; } catch (e) { }
        beacon('CP_SEEK', { t: Math.round(nt * 10) / 10 });
    }

    function changeVolume(delta) {
        var el = active && active.engEl;
        if (!el) return;
        var v = Math.max(0, Math.min(1, (el.volume || 0) + delta));
        try { el.volume = v; } catch (e) { }
        var fw = global.document && global.document.querySelector('.html5-main-video');
        if (fw && fw !== el) { try { fw.volume = v; } catch (e) { } }
        beacon('CP_VOL', { v: Math.round(v * 100) / 100 });
    }

    function bindInputDocument() {
        var doc = global.document;
        if (!doc) return;

        doc.addEventListener('mousemove', function (e) {
            if (!isWatchSurface() || isSnapped()) return;
            if (inTransport(e.target)) return;
            pokeTransport();
        }, true);

        var downX = 0, downY = 0, downT = 0;
        doc.addEventListener('mousedown', function (e) {
            if (qMenuOpen() && !inQualityMenu(e.target)) closeQualityMenu();
            if (!isWatchSurface() || isSnapped()) return;
            if (inTransport(e.target)) return;
            var t = e.target;
            if (!t || !t.closest || !t.closest('#player,#movie_player')) return;
            downX = e.clientX; downY = e.clientY; downT = Date.now();
        }, true);
        doc.addEventListener('mouseup', function (e) {
            if (!isWatchSurface() || isSnapped() || !downT) return;
            var dx = e.clientX - downX, dy = e.clientY - downY;
            downT = 0;
            if (Math.abs(dx) > 24 || Math.abs(dy) > 24) return;
            pokeTransport();
            trTogglePlay();
        }, true);

        doc.addEventListener('wheel', function (e) {
            if (!isWatchSurface() || isSnapped()) return;
            if (inTransport(e.target)) return;
            var t = e.target;
            if (!t || !t.closest || !t.closest('#player,#movie_player')) return;
            changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
            // without passive:false the browser marks this listener passive and
            // refuses the preventDefault, so the page scrolled behind the player
            if (e.preventDefault) e.preventDefault();
        }, { capture: true, passive: false });

        var tX = 0, tY = 0, tT = 0;
        doc.addEventListener('touchstart', function (e) {
            if (qMenuOpen() && !inQualityMenu(e.target)) closeQualityMenu();
            if (!isWatchSurface() || isSnapped()) return;
            if (inTransport(e.target)) return;
            var t = e.target;
            if (!t || !t.closest || !t.closest('#player,#movie_player')) return;
            var c = e.changedTouches && e.changedTouches[0];
            if (!c) return;
            tX = c.clientX; tY = c.clientY; tT = Date.now();
        }, true);
        doc.addEventListener('touchend', function (e) {
            if (!isWatchSurface() || isSnapped() || !tT) return;
            var c = e.changedTouches && e.changedTouches[0];
            if (!c) return;
            var dx = c.clientX - tX, dy = c.clientY - tY, dt = Date.now() - tT;
            tT = 0;
            if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { pokeTransport(); trSeek(dx < 0 ? SEEK_STEP : -SEEK_STEP); return; }
            if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { pokeTransport(); changeVolume(dy < 0 ? 0.05 : -0.05); return; }
            if (dt < 450) { pokeTransport(); trTogglePlay(); }
        }, true);
    }

    var barEl = null;

    function bindInputElements() {
        var doc = global.document;
        if (!doc) return;

        var bar = doc.querySelector('#progress-bar');
        if (bar && bar !== barEl) {
            barEl = bar;
            try { bar.style.touchAction = 'none'; } catch (x) { }
                var scrubbing = false;
                var fracFrom = function (ev) {
                    var r = bar.getBoundingClientRect();
                    if (!r || !r.width) return null;
                    var x = ev.clientX !== undefined ? ev.clientX : (ev.changedTouches && ev.changedTouches[0].clientX);
                    return Math.max(0, Math.min(1, (x - r.left) / r.width));
                };
                var begin = function (ev) {
                    if (!isWatchSurface() || isSnapped()) return;
                    scrubbing = true;
                    var f = fracFrom(ev);
                    if (f !== null) seekToFrac(f);
                    try { bar.setPointerCapture(ev.pointerId); } catch (e2) { }
                    if (ev.preventDefault) ev.preventDefault();
                };
                var move = function (ev) {
                    if (!scrubbing) return;
                    var f = fracFrom(ev);
                    if (f !== null) seekToFrac(f);
                    if (ev.preventDefault) ev.preventDefault();
                };
                var end = function () { scrubbing = false; };
                if (global.PointerEvent) {
                    bar.addEventListener('pointerdown', begin);
                    bar.addEventListener('pointermove', move);
                    bar.addEventListener('pointerup', end);
                    bar.addEventListener('pointercancel', end);
                } else {
                    bar.addEventListener('mousedown', begin);
                    bar.addEventListener('mousemove', move);
                    bar.addEventListener('mouseup', end);
                    bar.addEventListener('mouseleave', end);
                    bar.addEventListener('touchstart', begin, { passive: false });
                    bar.addEventListener('touchmove', move, { passive: false });
                    bar.addEventListener('touchend', end);
                }
        }
    }

    try { bindInputDocument(); } catch (e) { }
    try { bindInputElements(); } catch (e) { }

    /* webOS/LG can deliver one physical remote press as TWO keydowns with the
       same (or logically-equivalent) keyCode ~50ms apart. Deduplicate by logical
       key so a single press steps once — in the player AND in the app's own page
       navigation. Held auto-repeat (e.repeat) is kept for continuous seek/scroll. */
    var lastKeyName = null;
    var lastKeyAt = 0;
    var KEY_DUP_MS = 150;
    function dupeKeyName(code, k) {
        if (code === 8 || code === 27 || code === 461 || code === 462) return 'back';
        if (code === 178 || code === 179 || code === 415 || code === 19) return 'play';
        return k === ' ' ? 'space' : code;
    }
    function keydownRoot(e) {
        var code = e.keyCode || e.which || 0;
        var nm = dupeKeyName(code, e.key || '');
        var st = e.timeStamp ||
            (global.performance && global.performance.now ? global.performance.now() : Date.now());
        // the quality list and the related drawer are exempt: walking a list has
        // no side effects, and swallowing a fast press there just looks like
        // broken navigation
        if (!qMenuOpen() && !relOpenNow() && !chnOpenNow() && nm && nm === lastKeyName && !e.repeat && (st - lastKeyAt) > 0 && (st - lastKeyAt) < KEY_DUP_MS) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            return;
        }
        lastKeyName = nm;
        lastKeyAt = st;
        handleKey(e);
    }

    function isBackKey(e) {
        var code = e.keyCode || e.which || 0;
        return e.key === 'Escape' || e.key === 'Backspace' ||
            code === 8 || code === 27 || code === 461 || code === 462;
    }

    function handleKey(e) {
        var tgt = e.target;
        var tag = (tgt && (tgt.tagName || '')) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (tgt && tgt.isContentEditable)) return;

        // The quality dropdown swallows navigation while it is open, whatever
        // the rest of the player is doing (it lives outside the app's focus model).
        if (qMenuOpen() && qualityMenuKey(e)) return;
        // ...and so does the related drawer, which must also win over the
        // transport's own arrow handling while it is up
        if (relOpenNow() && relPanelKey(e)) return;
        // The info panel is a plain overlay without its own key handler, so it
        // has to be closed here: otherwise Back/Escape would quit the video with
        // the panel still covering it, and the user could not get the video back
        if (infoPanelOpen() && isBackKey(e)) {
            setInfoPanel(false);
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            return;
        }
        // the channel drawer does too, and it closes the related one first so
        // the two never fight over the same arrow key
        if (chnOpenNow()) {
            if (relOpenNow()) closeRelPanel();
            if (chnPanelKey(e)) return;
        }

        var w = watchSurface();
        var tc = trEl();
        if (!w || !tc) return;                     // only own keys while the watch surface exists
        var hash = '';
        try { hash = global.location && global.location.hash || ''; } catch (err) { }
        if (hash.indexOf('/watch') === -1) { closeQualityMenu(); closeRelPanel(); closeChannel(); return; } // non-watch screens: let the app handle its own nav
        if (!active) { closeQualityMenu(); closeRelPanel(); closeChannel(); return; } // no running session: let the app drive the screen
        var snapped = false;
        try { snapped = w.classList.contains('snapped'); } catch (err) { }
        if (snapped) return;                       // let the app navigate the behind grid
        // The app's More Actions menu used to be a dead end: it re-rendered
        // #button-list, took the remote focus, and every key we saw was answered
        // with a bare return. Our navigation no longer reads that list at all, so
        // there is nothing to recover from - the keys below are simply ours.

        var k = e.key || '';
        var code = e.keyCode || e.which || 0;
        var key = k === ' ' ? 'space' : (k || String.fromCharCode(code));
        var kmap = {
            8: 'Back', 32: ' ', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
            13: 'Enter', 27: 'Escape',
            179: 'MediaPlayPause', 178: 'MediaPlayPause', 415: 'MediaPlay', 19: 'MediaPause',
            412: 'MediaRewind', 417: 'MediaFastForward', 227: 'MediaFastForward',
            413: 'MediaNextTrack', 416: 'MediaNextTrack', 414: 'MediaPrevTrack',
            461: 'Back', 462: 'Back'
        };
        if (kmap[code]) key = kmap[code];
        var eat = function () {
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        };
        switch (key) {
            case ' ':
            case 'space':
                if (e.repeat) break;
                showTransport();
                trTogglePlay();
                eat();
                break;
            case 'MediaPlayPause':
                if (e.repeat) break;
                showTransport();
                trTogglePlay();
                eat();
                break;
            case 'MediaPlay':
                showTransport();
                trSetPaused(false);
                eat();
                break;
            case 'MediaPause':
                showTransport();
                trSetPaused(true);
                eat();
                break;
            case 'MediaStop':
                try { beacon('CP_KBD', { k: 'stop', id: active ? active.id : null }); } catch (err) { }
                var stopId2 = active ? active.id : null;
                stopActive();
                if (stopId2) suppressQuit(stopId2);
                break;
            case 'MediaRewind':
                showTransport();
                trSeek(-SEEK_STEP);
                eat();
                break;
            case 'MediaPrevTrack':
                showTransport();
                chainSkipPrev();
                eat();
                break;
            case 'MediaFastForward':
                showTransport();
                trSeek(SEEK_STEP);
                eat();
                break;
            case 'MediaNextTrack':
                showTransport();
                chainSkipNext();
                eat();
                break;
            case 'ArrowLeft':
                showTransport();
                trNavHoriz(-1);
                eat();
                break;
            case 'ArrowRight':
                showTransport();
                trNavHoriz(1);
                eat();
                break;
            case 'ArrowDown':
                showTransport();
                trNavVert(1);
                eat();
                break;
            case 'ArrowUp':
                showTransport();
                trNavVert(-1);
                eat();
                break;
            case 'Enter':
                if (trVisible && trActivate()) eat();
                break;
            case 'Back':
            case 'Backspace':
            case 'Escape':
                try { beacon('CP_KBD', { k: key.toLowerCase(), id: active ? active.id : null }); } catch (err) { }
                var quitId2 = active ? active.id : null;
                stopActive();
                if (quitId2) suppressQuit(quitId2);
                break;
        }
    }

    /* Keys must be seen before the app's own capture-phase handlers run, and
       app-prod.js binds those on window/document long after us. index.html
       installs a window-capture listener as its very first script and parks the
       event here; without that bootstrap we fall back to the document. */
    function bindKeydown() {
        if (global.__ytCpKeydown) { global.__ytCpKeydown = keydownRoot; return true; }
        return false;
    }

    try {
        if (!bindKeydown()) global.document.addEventListener('keydown', keydownRoot, true);
    } catch (e) { }

    try {
        global.addEventListener('hashchange', function () { stopIfLeftWatch('hashchange'); }, false);
    } catch (e2) { }

    /* be visible before tv-player.js uses us */
    var Api = {
        start: start,
        startById: startById,
        isActive: function () { return !!active; },
        activeVideo: function () { return active ? active.id : null; },
        getQuality: function () { return { height: currentHeight(), levels: qualityList.slice(), auto: qualityIdx < 0 }; },
        setQuality: setQualityTo,
        cycleQuality: cycleQuality,
        openQualityMenu: openQualityMenu,
        toggleQualityMenu: toggleQualityMenu,
        closeQualityMenu: closeQualityMenu,
        getChainEnabled: chainEnabled,
        setChainEnabled: setChainEnabled,
        playRelated: chainNext,
        skipNext: chainSkipNext,
        skipPrev: chainSkipPrev,
        openRelated: openRelPanel,
        closeRelated: closeRelPanel,
        toggleRelated: toggleRelPanel,
        getRelated: function () { return relCandidates().slice(); },
        openChannel: openChannel,
        closeChannel: closeChannel,
        isChannelOpen: chnOpenNow,
        getChannel: function () { return chnData; },
        getChannelItems: function () { return chnItems.map(function (e) { return e.item; }); },
        setChannelTab: function (key) {
            for (var i = 0; i < CHN_TABS.length; i++) {
                if (CHN_TABS[i].key === key) { chnGoTab(i); return true; }
            }
            return false;
        },
        getHistory: function () { return chainPath.slice(); },
        getWatchJournal: function () {
            // diagnostics only: the journal is otherwise invisible from the page
            return histSession
                ? { id: histSession.id, watched: Math.round(histSession.watched), reported: Math.round(histSession.reported), profile: histProfileId() }
                : null;
        },
        /* Which profile this browser is writing under, so it can be told apart
           from the others sharing the backend. */
        getProfile: function () { return histProfileId(); },
        stop: stopActive,
        _remount: remount,
        _engineEl: function () { return active ? active.engEl : null; }
    };

    global.YTCustomPlayer = Api;

    // Publish the profile before the app issues its first /api/browse, so the
    // History tab is asked for as the right viewer.
    histProfileId();

    if (global.document) {
        if (global.document.readyState === 'complete' || global.document.readyState === 'interactive') {
            poll();
        } else {
            global.document.addEventListener('DOMContentLoaded', poll);
        }
    }
})(window);