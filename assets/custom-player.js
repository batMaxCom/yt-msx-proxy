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
    global.__CUSTOM_PLAYER_VERSION = '20261016';

    var appSettings = { hideOnScreenNav: false, showToggleVideoInfo: false };
    try {
        xhrText(global.location.origin + '/settings.json', function (t) {
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

    function xhrArray(url, ok, fail) {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.responseType = 'arraybuffer';
        x.onreadystatechange = function () {
            if (x.readyState === 4) {
                if (x.status >= 200 && x.status < 400) ok(x.response);
                else if (fail) fail(x.status);
            }
        };
        x.send(null);
    }

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

    function EngineNativeHls(conf) {
        this.conf = conf;
        Engine.call(this);
        var self = this;
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
            fragLoadingMaxRetry: 6
        });
        this._hls = hls;
        hls.attachMedia(conf.el);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            if (self.stopped) return;
            beacon('HLSJS_READY', { levels: hls.levels ? hls.levels.length : -1 });
            hideFrameworkEl();
            if (conf.el.paused) {
                var p = conf.el.play();
                if (p && p.catch) p.catch(function () { });
            }
        });
        hls.on(Hls.Events.ERROR, function (evt, data) {
            beacon('HLSJS_ERROR', { type: data && data.type, details: data && data.details, fatal: data && data.fatal });
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

    function EngineMseWebm(conf) {
        this.conf = conf;
        Engine.call(this);
        var self = this;
        var ms = new MediaSource();
        this._ms = ms;
        this._videoSb = null;
        this._audioSb = null;
        conf.el.src = URL.createObjectURL(ms);
        ms.addEventListener('sourceopen', function () {
            if (self.stopped || ms.readyState !== 'open') return;
            beacon('WEBM_SOURCEOPEN', { rs: ms.readyState, same: conf.el === (global.document && global.document.querySelector('.html5-main-video')) });
            try { self._videoSb = ms.addSourceBuffer(conf.video.mime); }
            catch (e) { beacon('WEBM_VIDEOSB_FAIL', { m: conf.video.mime, e: String(e) }); return; }
            try { if (conf.audio) self._audioSb = ms.addSourceBuffer(conf.audio.mime); }
            catch (e) { self._audioSb = null; }
            self._loadStream(conf.video.url, self._videoSb, function () {
                if (self.stopped) return;
                if (self._audioSb && conf.audio) self._loadStream(conf.audio.url, self._audioSb, null);
            }, function () { self._boot(); });
        });
    }
    EngineMseWebm.prototype = Object.create(Engine.prototype);
    EngineMseWebm.prototype.constructor = EngineMseWebm;

    EngineMseWebm.prototype._loadStream = function (url, sb, done, onFirst) {
        var self = this, firstFired = false;
        var fireFirst = function () {
            if (firstFired) return;
            firstFired = true;
            beacon('WEBM_FIRST_APPEND', { len: sb.buffered && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : -1 });
            if (onFirst) onFirst();
        };
        var finish = function () { if (done) done(); };
        var append = function (buf) {
            if (self.stopped) { finish(); return; }
            var go = function () {
                try { sb.appendBuffer(buf); }
                catch (e) { beacon('WEBM_APPEND_FAIL', { e: String(e), bytes: buf.byteLength }); finish(); return; }
                beacon('WEBM_FULL', { bytes: buf.byteLength, b: sb.buffered && sb.buffered.length ? +sb.buffered.end(sb.buffered.length - 1).toFixed(1) : -1, rs: self.conf.el.readyState });
                fireFirst();
                if (done) done();
            };
            if (sb.updating) sb.addEventListener('updateend', function h() { sb.removeEventListener('updateend', h); go(); });
            else go();
        };
        xhrArray(url, append, function (st) { beacon('WEBM_FETCH_FAIL', { s: st }); finish(); });
    };
    EngineMseWebm.prototype._boot = function () {
        if (this.stopped) return;
        var self = this, tries = 0;
        var kick = function () {
            if (self.stopped) return;
            var el = self.conf.el;
            var rs = el.readyState;
            try { beacon('WEBM_KICK', { rs: rs, t: Math.round((el.currentTime || 0) * 10) / 10, b: el.buffered && el.buffered.length ? +el.buffered.end(el.buffered.length - 1).toFixed(1) : -1 }); } catch (e) { }
            // once the decoder actually opened, stop kicking and hide the extra element
            if (rs >= 2) { hideFrameworkEl(); return; }
            var p = el.play();
            if (p && p.catch) p.catch(function () { });
            if (tries++ < 10) setTimeout(kick, 2500);
            else {
                // decoder wedged: remount a fresh engine on the same element
                try { beacon('WEBM_REMOUNT', { t: Math.round((el.currentTime || 0) * 10) / 10, rs: rs }); } catch (e) { }
                if (window.YTCustomPlayer && window.YTCustomPlayer._remount) {
                    window.YTCustomPlayer._remount(self.conf.el);
                }
            }
        };
        kick();
    };

    function EngineNoop() { Engine.call(this); }
    EngineNoop.prototype = Object.create(Engine.prototype);
    EngineNoop.prototype.constructor = EngineNoop;

    function EngineProgressive(conf) {
        this.conf = conf;
        Engine.call(this);
        var self = this;
        conf.el.src = conf.url;
        try { conf.el.load(); } catch (e) { }
        var t = setTimeout(function () {
            if (!self.stopped && conf.el.paused) {
                var p = conf.el.play();
                if (p && p.catch) p.catch(function () { });
            }
        }, 300);
        this._timer = t;
    }
    EngineProgressive.prototype = Object.create(Engine.prototype);
    EngineProgressive.prototype.constructor = EngineProgressive;

    /* ---------------- format picking ---------------- */

    function bestVideo(links) {
        var best = null, i;
        for (i = 0; i < links.length; i++) {
            var l = links[i];
            if (!l || !l.url) continue;
            var m = (l.mime || l.type || '').split(';')[0];
            if (m !== 'video/webm') continue;
            if (!best) { best = l; continue; }
            var h1 = parseInt((l.url.match(/itag=(\d+)/) || [])[1], 10);
            var h0 = parseInt((best.url.match(/itag=(\d+)/) || [])[1], 10);
            if ((!isNaN(h1) && !isNaN(h0) && h1 < h0)) best = l;
        }
        return best;
    }

    function bestAudio(links) {
        var i;
        for (i = 0; i < links.length; i++) {
            var l = links[i];
            if (l && l.url && (l.mime || l.type || '').split(';')[0] === 'audio/webm') return l;
        }
        return null;
    }

    function muxedUrl(links) {
        var i;
        for (i = 0; i < links.length; i++) if (links[i] && links[i].url && /itag=18/.test(links[i].url)) return links[i].url;
        return null;
    }

    function codecsForItag(url, kind) {
        var it = parseInt((url.match(/itag=(\d+)/) || [])[1], 10);
        if (kind === 'audio') return (it === 171 || it === 172) ? 'vorbis' : 'opus';
        return (it === 43 || it === 44 || it === 45) ? 'vp8' : 'vp9';
    }

    function mseMime(l, kind) {
        var b = kind === 'audio' ? 'audio/webm' : 'video/webm';
        var c = l.codecs || codecsForItag(l.url || '', kind);
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
        var el = active && active.engEl;
        if (el) {
            try { el.pause(); } catch (e) { }
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
        if (active && active.id === id && active.el === el && active.engEl && !active.engEl.paused) return true;

        stopActive();
        active = { id: id, el: el, engine: null };
        try { el.setAttribute('data-yt-custom', id); } catch (e) { }

        var hlsUrl = conf.hlsUrl || (base + '/api/hls/' + id);
        hlsUrl = absUrl(hlsUrl);
        beacon('CP_START', { id: id, engine: null, hlsUrl: hlsUrl.slice(0, 80) });

        var eng = null;
        var engEl = el;
        var links = conf.mediaLinks || [];

        if (nativeHlsOk(el)) {
            eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
            beacon('CP_ENGINE', { k: 'nativehls', id: id });
        } else if (global.Hls && global.Hls.isSupported && global.Hls.isSupported()) {
            // hls.js on desktop: every TS segment is a small, fresh upstream
            // request proxied by /api/hls — no sustained-download throttling.
            engEl = makeOwnEl();
            eng = new EngineHlsJs({ el: engEl, hlsUrl: hlsUrl });
            beacon('CP_ENGINE', { k: 'hlsjs', id: id });
        } else if (mseOk('video/webm; codecs="vp9"')) {
            var v = bestVideo(links);
            var au = bestAudio(links);
            if (v) {
                engEl = makeOwnEl();
                eng = new EngineMseWebm({
                    el: engEl,
                    video: { url: absUrl(v.url), mime: mseMime(v, 'video') },
                    audio: au ? { url: absUrl(au.url), mime: mseMime(au, 'audio') } : null
                });
                beacon('CP_ENGINE', { k: 'msewebm', id: id });
            } else {
                eng = new EngineNoop();
                beacon('CP_ENGINE', { k: 'msewebm', pending: true, id: id });
            }
        } else {
            eng = new EngineNoop();
            beacon('CP_ENGINE', { k: 'nomse', id: id });
        }

        if (eng && eng.constructor === EngineNoop) {
            var mu = conf.progLink && conf.progLink.url && !/api\/hls/.test(conf.progLink.url) ? conf.progLink.url : muxedUrl(links);
            if (mu) {
                engEl = makeOwnEl();
                eng = new EngineProgressive({ el: engEl, url: absUrl(mu) });
                beacon('CP_ENGINE', { k: 'progressive', id: id });
            } else {
                // last resort: hand the master playlist to the element (works only on real HLS browsers)
                eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
                beacon('CP_ENGINE', { k: 'lastresort-nativehls', id: id });
            }
        }

        active.engEl = engEl;
        active.ownEl = (engEl === el) ? null : engEl;
        active.engine = eng;
        onSeekHandler = onSeek;
        bindSeek(engEl);
        try { engEl.addEventListener('seeked', function () { beacon('CP_SEEKED', {}); }); } catch (e) { }
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
        xhrText(base + '/get_video_info?video_id=' + id, function (t) {
            if (!t || !el || active) { if (cb) cb(false); return; }
            var links = parseAdaptive(t);
            var hls = null, i;
            for (i = 0; i < links.length; i++) { if (links[i].url && /itag=hls/.test(links[i].url)) { hls = links[i].url; break; } }
            var ok = start({ id: id, el: el, mediaLinks: links, hlsUrl: hls || (base + '/api/hls/' + id) });
            if (cb) cb(ok);
        });
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

    function poll() {
        setTimeout(function () {
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
                var owned = active.el;
                var lost = (owned !== el);
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

    var TR_HIDE_MS = 3000;
    var SEEK_STEP = 10;
    var trSeen = false;
    var trVisible = false;
    var trFocus = 'seekbar';   // 'seekbar' | 'buttons'
    var trIdx = 0;
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

    function setTransport(visible) {
        var tc = trEl();
        var w = watchSurface();
        if (visible) {
            if (tc) tc.classList.remove('hidden');
            if (w) w.classList.add('transport-showing');
        } else {
            if (tc) tc.classList.add('hidden');
            if (w) w.classList.remove('transport-showing');
        }
    }

    function showTransport() {
        trVisible = true;
        lastTrActive = Date.now();
        setTransport(true);
        if (trFocus !== 'buttons') { trFocus = 'seekbar'; clearButtonFocus(); }
    }

    function clearButtonFocus() {
        var list = global.document && global.document.querySelectorAll('#button-list > div');
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
            try { list[i].classList.remove('focused'); list[i].classList.remove('selected'); } catch (e) { }
        }
    }

    function enabledButtons() {
        var list = global.document && global.document.querySelectorAll('#button-list > div');
        var out = [];
        if (!list) return out;
        for (var i = 0; i < list.length; i++) {
            var cl = (typeof list[i].className === 'string') ? list[i].className : '';
            if (/disabled/.test(cl)) continue;
            out.push(list[i]);
        }
        return out;
    }

    function focusButton(idx) {
        var bs = enabledButtons();
        if (!bs.length) return;
        trIdx = ((idx % bs.length) + bs.length) % bs.length;
        clearButtonFocus();
        var b = bs[trIdx];
        try { b.classList.add('focused'); } catch (e) { }
        if (/icon-player-play/.test(typeof b.className === 'string' ? b.className : '')) {
            try { b.classList.add('selected'); } catch (e) { }
        }
    }

    function navButtons(dir) {
        var bs = enabledButtons();
        if (!bs.length) return;
        var cur = -1, i;
        for (i = 0; i < bs.length; i++) { if (bs[i].classList.contains('focused')) cur = i; }
        if (cur < 0) cur = trIdx;
        focusButton(cur + dir);
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
        beacon('CP_KBD', { k: 'space', t: Math.round((el.currentTime || 0) * 10) / 10 });
    }

    function trSetPaused(pause) {
        var el = active && active.engEl;
        if (!el) return;
        try {
            if (pause) el.pause();
            else if (el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () { }); }
        } catch (e) { }
    }

    function goHome() {
        try { global.location.hash = '#/browse-sets?c=home'; } catch (e) { }
    }

    function activateFocusedButton() {
        var bs = enabledButtons();
        if (!bs.length) return;
        var i, b = null;
        for (i = 0; i < bs.length; i++) { if (bs[i].classList.contains('focused')) { b = bs[i]; break; } }
        if (!b) return;
        var cl = typeof b.className === 'string' ? b.className : '';
        if (/icon-player-play/.test(cl)) trTogglePlay();
        else if (/icon-player-rew/.test(cl)) trSeek(-SEEK_STEP);
        else if (/icon-player-ff/.test(cl)) trSeek(SEEK_STEP);
        else if (/icon-home/.test(cl)) goHome();
    }

    function syncUI() {
        try {
            bindInputElements();
            var tc = trEl();
            if (!tc) { trSeen = false; return; }
            if (!trSeen) {
                trSeen = true;
                trVisible = false;
                setTransport(false);
            }
            if (trVisible) {
                if (Date.now() - lastTrActive > TR_HIDE_MS) { trVisible = false; setTransport(false); }
                else setTransport(true);
            } else {
                setTransport(false);
            }
            if (active && active.engEl) {
                var el = active.engEl;
                var ct = el.currentTime || 0;
                var dur = el.duration;
                var live = !(isFinite(dur) && dur > 0);
                var pct = (!live && dur > 0) ? Math.min(100, ((ct / dur) * 100)) : 0;
                var played = global.document.querySelector('#progress-bar .progress-bar-played');
                var disc = global.document.querySelector('#progress-bar .progress-bar-disc');
                var loaded = global.document.querySelector('#progress-bar .progress-bar-loaded');
                if (played) played.style.width = pct + '%';
                if (disc) disc.style.left = pct + '%';
                if (loaded) {
                    var bEnd = 0, i;
                    if (el.buffered) for (i = 0; i < el.buffered.length; i++) bEnd = Math.max(bEnd, el.buffered.end(i));
                    loaded.style.width = (!live && dur > 0 ? Math.min(100, (bEnd / dur) * 100) : 0) + '%';
                }
                var et = global.document.querySelector('#player-time-elapsed');
                var tt = global.document.querySelector('.player-time-total');
                if (et) { et.textContent = fmtTime(ct); try { et.classList.remove('no-model'); } catch (err) { } }
                if (tt) tt.textContent = live ? '' : fmtTime(dur);
                try { tc.classList.toggle('live-playback', !!live); } catch (err) { }
                var sb = global.document.querySelectorAll('#button-list .icon-player-rew, #button-list .icon-player-ff');
                for (i = 0; i < sb.length; i++) try { sb[i].classList.remove('disabled'); } catch (err) { }
                // the 2016 app keeps its loading spinner forever because its own
                // player model never reports "started" — hide it once we actually play
                if (el.readyState >= 2 || (el.currentTime || 0) > 0) {
                    var spin = global.document.querySelector('#spinner');
                    if (spin) spin.style.display = 'none';
                    var lid = global.document.querySelector('.loading-indicator');
                    if (lid) lid.style.display = 'none';
                    var fid = global.document.querySelector('.fallback-loading-indicator');
                    if (fid) fid.style.display = 'none';
                }
            }
            if (appSettings.hideOnScreenNav) {
                var legend = global.document.querySelector('#legend');
                if (legend) legend.style.display = 'none';
            }
            if (!appSettings.showToggleVideoInfo) {
                var tvi = global.document.querySelector('.legend-item.toggle-video-info');
                if (tvi) tvi.style.display = 'none';
                var tray = global.document.querySelector('#title-tray');
                if (tray) tray.style.display = 'none';
                var pvt = global.document.querySelector('.player-video-text');
                if (pvt) pvt.style.display = 'none';
                var info = global.document.querySelectorAll('#html5-video-info-panel, .html5-video-info-panel, #movie_player .html5-video-info, .video-info-panel');
                for (var ii = 0; ii < info.length; ii++) {
                    try { info[ii].style.display = 'none'; } catch (e2) { }
                }
            }
        } catch (e) { }
    }

    setInterval(syncUI, 250);

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
        try { return !!(t && t.closest && t.closest('#transport-controls,#title-tray,#html5-video-info-panel')); } catch (e) { return false; }
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
            if (e.preventDefault) e.preventDefault();
        }, true);

        var tX = 0, tY = 0, tT = 0;
        doc.addEventListener('touchstart', function (e) {
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

    var btnEl = null, barEl = null;

    function bindInputElements() {
        var doc = global.document;
        if (!doc) return;

        var bl = doc.querySelector('#button-list');
        if (bl && bl !== btnEl) {
            btnEl = bl;
            bl.addEventListener('mouseover', function (e) {
                    if (!isWatchSurface() || isSnapped()) return;
                    var b = e.target && e.target.closest && e.target.closest('#button-list > div');
                    if (!b) return;
                    trVisible = true;
                    trFocus = 'buttons';
                    var bs = enabledButtons(), i;
                    for (i = 0; i < bs.length; i++) if (bs[i] === b) { focusButton(i); break; }
                    lastTrActive = Date.now();
                }, true);
                bl.addEventListener('click', function (e) {
                    if (!isWatchSurface() || isSnapped()) return;
                    var b = e.target && e.target.closest && e.target.closest('#button-list > div');
                    if (!b) return;
                    var cl = typeof b.className === 'string' ? b.className : '';
                    if (/icon-player-play/.test(cl)) trTogglePlay();
                    else if (/icon-player-rew/.test(cl)) trSeek(-SEEK_STEP);
                    else if (/icon-player-ff/.test(cl)) trSeek(SEEK_STEP);
                    else if (/icon-home/.test(cl)) goHome();
                    pokeTransport();
                    if (e.preventDefault) e.preventDefault();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                }, true);
        }

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

    function handleKey(e) {
        var tgt = e.target;
        var tag = (tgt && (tgt.tagName || '')) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (tgt && tgt.isContentEditable)) return;

        var w = watchSurface();
        var tc = trEl();
        if (!w || !tc) return;                     // only own keys while the watch surface exists
        var snapped = false;
        try { snapped = w.classList.contains('snapped'); } catch (err) { }
        if (snapped) return;                       // let the app navigate the behind grid

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
        if (kmap[code] && (!k || k.length === 1)) key = kmap[code];
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
            case 'MediaPrevTrack':
                showTransport();
                trSeek(-SEEK_STEP);
                eat();
                break;
            case 'MediaFastForward':
            case 'MediaNextTrack':
                showTransport();
                trSeek(SEEK_STEP);
                eat();
                break;
            case 'ArrowLeft':
                showTransport();
                if (trFocus === 'buttons') navButtons(-1);
                else trSeek(-SEEK_STEP);
                eat();
                break;
            case 'ArrowRight':
                showTransport();
                if (trFocus === 'buttons') navButtons(1);
                else trSeek(SEEK_STEP);
                eat();
                break;
            case 'ArrowDown':
            case 'ArrowUp':
                showTransport();
                if (key === 'ArrowDown' && trFocus === 'seekbar') { trFocus = 'buttons'; focusButton(0); }
                else if (key === 'ArrowUp' && trFocus === 'buttons') { trFocus = 'seekbar'; clearButtonFocus(); }
                eat();
                break;
            case 'Enter':
                if (trVisible && trFocus === 'buttons') { activateFocusedButton(); eat(); }
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

    try { global.document.addEventListener('keydown', handleKey, true); } catch (e) { }

    /* be visible before tv-player.js uses us */
    var Api = {
        start: start,
        startById: startById,
        isActive: function () { return !!active; },
        activeVideo: function () { return active ? active.id : null; },
        stop: stopActive,
        _remount: remount
    };

    global.YTCustomPlayer = Api;

    if (global.document) {
        if (global.document.readyState === 'complete' || global.document.readyState === 'interactive') {
            poll();
        } else {
            global.document.addEventListener('DOMContentLoaded', poll);
        }
    }
})(window);