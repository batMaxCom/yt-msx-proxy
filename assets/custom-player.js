/*
 * CustomVideoPlayer — self-contained replacement for the framework playback.
 * Owns the .html5-main-video element, loads media directly through the
 * server proxy (/get_video_info, /api/hls, /api/stream) and never asks
 * for Flash. Strategy per environment:
 *   1. nativehls   — video element plays the master m3u8 (WebOS WAM, Safari...)
 *   2. msewebm     — MediaSource with whole VP9/Opus WebM streams (Chrome/desktop)
 *   3. progressive — single muxed MP4 (itag=18) served with Range support
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
        if (isTV) return true;
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
        var self = this, firstFired = false, appendCount = 0;
        var fireFirst = function () { if (!firstFired) { firstFired = true; beacon('WEBM_FIRST_APPEND', { len: sb.buffered && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : -1 }); if (onFirst) onFirst(); } };
        var finish = function () { if (done) done(); };
        var append = function (chunk, next) {
            if (self.stopped) { finish(); return; }
            var go = function () {
                try { sb.appendBuffer(chunk); }
                catch (e) { beacon('WEBM_APPEND_FAIL', { e: String(e) }); finish(); return; }
                if ((++appendCount % 20) === 0) beacon('WEBM_APPEND_N', { n: appendCount, b: sb.buffered && sb.buffered.length ? +sb.buffered.end(sb.buffered.length - 1).toFixed(1) : -1, d: self.conf.el.duration, rs: self.conf.el.readyState, ms: self._ms.readyState, conn: self.conf.el.isConnected });
                fireFirst();
                sb.addEventListener('updateend', function h() { sb.removeEventListener('updateend', h); next(); });
            };
            if (sb.updating) sb.addEventListener('updateend', function h() { sb.removeEventListener('updateend', h); go(); });
            else go();
        };
        if (global.fetch) {
            global.fetch(url).then(function (r) {
                if (!r.ok || !r.body || !r.body.getReader) { beacon('WEBM_FETCH_FAIL', { s: r.status }); finish(); return; }
                var reader = r.body.getReader();
                var pump = function () {
                    reader.read().then(function (res) {
                        if (self.stopped) { finish(); return; }
                        if (res.done) { finish(); return; }
                        append(res.value, pump);
                    }).catch(function (e) { beacon('WEBM_READ_FAIL', { e: String(e) }); finish(); });
                };
                pump();
            }).catch(function (e) { beacon('WEBM_FETCH_FAIL', { e: String(e) }); finish(); });
        } else {
            xhrArray(url, function (buf) { append(buf, finish); }, function (st) { beacon('WEBM_FETCH_FAIL', { s: st }); finish(); });
        }
    };
    EngineMseWebm.prototype._boot = function () {
        if (this.stopped) return;
        try { beacon('WEBM_BOOT', { err: this.conf.el.error ? this.conf.el.error.code : 0, ns: this.conf.el.networkState, rs: this.conf.el.readyState }); } catch (e) { }
        var p = this.conf.el.play();
        if (p && p.catch) p.catch(function () { });
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
    var onSeekHandler = onSeek;

    function stopActive() {
        if (active && active.el) {
            try { unbindSeek(active.el); } catch (e) { }
        }
        if (active) {
            try { if (active.engine && active.engine.close) active.engine.close(); } catch (e) { }
        }
        active = null;
    }

    function onSeek() {
        if (active && active.engine && active.engine.seek && active.el) {
            try { active.engine.seek(active.el.currentTime || 0); } catch (e) { }
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
        if (active && active.id === id && active.el === el && !el.paused) return true;

        stopActive();
        active = { id: id, el: el, engine: null };
        try { el.setAttribute('data-yt-custom', id); } catch (e) { }

        var hlsUrl = conf.hlsUrl || (base + '/api/hls/' + id);
        hlsUrl = absUrl(hlsUrl);
        beacon('CP_START', { id: id, engine: null, hlsUrl: hlsUrl.slice(0, 80) });

        var eng = null;
        var links = conf.mediaLinks || [];

        if (nativeHlsOk(el)) {
            eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
            beacon('CP_ENGINE', { k: 'nativehls', id: id });
        } else if (mseOk('video/webm; codecs="vp9"')) {
            var v = bestVideo(links);
            var au = bestAudio(links);
            if (v) {
                eng = new EngineMseWebm({
                    el: el,
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
                eng = new EngineProgressive({ el: el, url: absUrl(mu) });
                beacon('CP_ENGINE', { k: 'progressive', id: id });
            } else {
                // last resort: hand the master playlist to the element (works only on real HLS browsers)
                eng = new EngineNativeHls({ el: el, hlsUrl: hlsUrl });
                beacon('CP_ENGINE', { k: 'lastresort-nativehls', id: id });
            }
        }

        active.engine = eng;
        onSeekHandler = onSeek;
        bindSeek(el);
        try { el.addEventListener('seeked', function () { beacon('CP_SEEKED', {}); }); } catch (e) { }
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
                var lost = (owned !== el) || (el.readyState === 0 && !/^blob:/.test(el.currentSrc || el.src || ''));
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

    /* be visible before tv-player.js uses us */
    var Api = {
        start: start,
        startById: startById,
        isActive: function () { return !!active; },
        activeVideo: function () { return active ? active.id : null; },
        stop: stopActive
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