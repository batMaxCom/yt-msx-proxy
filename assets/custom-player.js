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
       use a fresh element of our own; nativehls (TV) keeps the framework element. */
    function fitOwnEl(vid) {
        var host = global.document && global.document.querySelector('.html5-main-video');
        if (!host || !vid || vid.parentNode !== global.document.body) return;
        try {
            var r = host.getBoundingClientRect();
            if (!r || !(r.width > 0) || !(r.height > 0) || isNaN(r.left) || isNaN(r.top)) return;
            vid.style.position = 'fixed';
            vid.style.left = r.left + 'px';
            vid.style.top = r.top + 'px';
            vid.style.width = r.width + 'px';
            vid.style.height = r.height + 'px';
            try { vid.style.objectFit = global.getComputedStyle(host).objectFit || 'contain'; } catch (e) { }
        } catch (e) { }
    }

    function makeOwnEl() {
        var host = global.document && global.document.querySelector('.html5-main-video');
        var body = global.document && global.document.body;
        var vid = global.document.createElement('video');
        vid.setAttribute('playsinline', '');
        // Transparent until the first frame decodes, and pinned to the framework
        // video's exact on-screen box (fixed positioning + rect from
        // getBoundingClientRect) so it never spills over the navigation/title UI.
        vid.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;background:transparent;';
        try { if (body) body.appendChild(vid); } catch (e) { }
        fitOwnEl(vid);
        if (!ownElTimer) {
            ownElTimer = setInterval(function () {
                if (active && active.ownEl) fitOwnEl(active.ownEl);
            }, 800);
        }
        try { global.addEventListener('resize', function () { if (active && active.ownEl) fitOwnEl(active.ownEl); }); } catch (e) { }
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

    function poll() {
        setTimeout(function () {
            var id = getVideoId();
            var el = global.document && global.document.querySelector('.html5-main-video');
            if (!id || !el) { lastCandidate = 0; poll(); return; }
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

    /* ---- keyboard control: Esc quit, arrows volume/seek, space play/pause ---- */

    function handleKey(e) {
        if (!active || !active.engEl) return;
        var tgt = e.target;
        var tag = (tgt && (tgt.tagName || '')) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (tgt && tgt.isContentEditable)) return;
        var k = e.key || '';
        var code = e.keyCode || e.which || 0;
        var key = k === ' ' ? 'space' : (k || String.fromCharCode(code));
        var engEl = active.engEl;
        switch (key) {
            case ' ':
            case 'space':
                if (e.repeat) break;
                try {
                    if (engEl.paused) { var p = engEl.play(); if (p && p.catch) p.catch(function () { }); }
                    else engEl.pause();
                } catch (err) { }
                beacon('CP_KBD', { k: 'space', t: Math.round((engEl.currentTime || 0) * 10) / 10 });
                if (e.preventDefault) e.preventDefault();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                break;
            case 'ArrowUp':
            case 'ArrowDown':
                try {
                    var v = Math.max(0, Math.min(1, (engEl.volume || 0) + (key === 'ArrowUp' ? 0.1 : -0.1)));
                    engEl.volume = v;
                    var fw = global.document && global.document.querySelector('.html5-main-video');
                    if (fw && fw !== engEl) fw.volume = v;
                    beacon('CP_KBD', { k: key, v: Math.round(v * 100) / 100 });
                } catch (err) { }
                if (e.preventDefault) e.preventDefault();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                break;
            case 'ArrowLeft':
            case 'ArrowRight':
                try {
                    var dur = engEl.duration;
                    var max = isFinite(dur) && dur > 0 ? dur : Number.MAX_SAFE_INTEGER;
                    var nt = Math.max(0, Math.min(max, (engEl.currentTime || 0) + (key === 'ArrowRight' ? 10 : -10)));
                    engEl.currentTime = nt;
                    beacon('CP_KBD', { k: key, t: Math.round(nt * 10) / 10 });
                } catch (err) { }
                if (e.preventDefault) e.preventDefault();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                break;
            case 'Escape':
                try { beacon('CP_KBD', { k: 'esc', id: active.id }); } catch (err) { }
                stopActive();
                // do NOT swallow: the TV app handles Esc (27) itself and navigates back
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