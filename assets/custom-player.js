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
    global.__CUSTOM_PLAYER_VERSION = '20261026';

    var appSettings = { hideOnScreenNav: false, showToggleVideoInfo: false };
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
        return x;
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
            fragLoadingMaxRetry: 6
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
        } else {
            // auto = best available rendition: the manifest is already sorted
            // ascending by BANDWIDTH, so the last level is the top quality.
            // Cap ABR there too, otherwise the player could climb past it.
            idx = hls.levels.length - 1;
            try { hls.autoLevelCapping = idx; } catch (e2) { }
        }
        try { hls.currentLevel = idx; } catch (e) { }
        beacon('HLSJS_Q', { h: h || 0, idx: idx, levels: hls.levels.length, auto: !h });
    };

    function EngineMseWebm(conf) {
        this.conf = conf;
        Engine.call(this);
        this._videoLinks = (conf.videoLinks || []).slice();
        if (!this._videoLinks.length && conf.video) this._videoLinks = [conf.video];
        this._audio = conf.audio || null;
        this._requests = [];
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

    EngineMseWebm.prototype.close = function () {
        Engine.prototype.close.call(this);
        this._clearMetadata();
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
            self._loadStream(video.url, self._videoSb, function () {
                if (self.stopped || generation !== self._generation) return;
                if (self._audioSb && self._audio) self._loadStream(self._audio.url, self._audioSb, null, null, generation);
            }, function () { self._boot(generation); }, generation);
        });
    };

    EngineMseWebm.prototype._loadStream = function (url, sb, done, onFirst, generation) {
        var self = this, firstFired = false, finished = false;
        var current = function () { return !self.stopped && generation === self._generation; };
        this._pending++;
        var fireFirst = function () {
            if (firstFired || !current()) return;
            firstFired = true;
            beacon('MSE_FIRST_APPEND', { len: sb.buffered && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : -1 });
            if (onFirst) onFirst();
        };
        var finish = function () {
            if (finished) return;
            finished = true;
            // done() may start the audio stream, which bumps _pending again
            if (done && current()) done();
            self._pending--;
            self._endOfStreamWhenComplete();
        };
        var append = function (buf) {
            if (!current()) { finish(); return; }
            var go = function () {
                if (!current()) { finish(); return; }
                try { sb.appendBuffer(buf); }
                catch (e) { beacon('MSE_APPEND_FAIL', { e: String(e), bytes: buf.byteLength }); finish(); return; }
                beacon('MSE_FULL', { bytes: buf.byteLength, b: sb.buffered && sb.buffered.length ? +sb.buffered.end(sb.buffered.length - 1).toFixed(1) : -1, rs: self.conf.el.readyState });
                fireFirst();
                finish();
            };
            if (sb.updating) sb.addEventListener('updateend', function h() { sb.removeEventListener('updateend', h); go(); });
            else go();
        };
        var request = xhrArray(url, append, function (st) {
            if (current()) beacon('MSE_FETCH_FAIL', { s: st });
            finish();
        });
        if (request) this._requests.push(request);
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
            if (tries++ < 10) setTimeout(kick, 2500);
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
        this._restoreTime = el ? (el.currentTime || 0) : 0;
        this._shouldPlay = !!(el && el.paused === false);
        this._openSource(video);
        beacon('MSE_Q', { h: formatHeight(video) || 0, requested: h || 0 });
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
        this._restoreTime = el ? (el.currentTime || 0) : 0;
        this._shouldPlay = !!(el && el.paused === false);
        this._loadSource(source);
        beacon('PROGRESSIVE_Q', { h: formatHeight(source) || 0, requested: h || 0 });
    };

    EngineProgressive.prototype.close = function () {
        Engine.prototype.close.call(this);
        this._clearMetadata();
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
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
            engEl = makeOwnEl();
            eng = new EngineHlsJs({ el: engEl, hlsUrl: hlsUrl });
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
            if (metaReady) metaShow();       // the panel lives and dies with the controls
        } else {
            if (tc) tc.classList.add('hidden');
            if (w) w.classList.remove('transport-showing');
            hideVideoMeta();
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
    var health = { at: 0, started: 0, progress: 0, media: -1, dropped: 0, total: 0, stalls: 0, bad: 0, good: 0, steps: 0, moves: 0, cycles: 0, id: '', own: false };
    var HEALTH_MS = 3000;            // sampling window
    var HEALTH_WARMUP_MS = 6000;     // wall clock, deliberately NOT currentTime: a
                                     // stream that dies before 6s must still be
                                     // allowed to ask for less, not stay frozen
    var HEALTH_PROGRESS_EPS = 0.05;  // how far the media has to move to count as progress
    var HEALTH_STARVE_MS = 1200;     // this much of a window with no progress is bad
    var HEALTH_STARVE_HARD_MS = 2400;// this much starving needs no second window
    var HEALTH_DROP_RATIO = 0.08;    // >8% dropped frames counts as "cannot keep up"
    var HEALTH_STALLS = 2;           // or this many rebuffer events in one window
    var HEALTH_BAD_RUN = 2;          // bad windows before stepping down
    var HEALTH_CLEAN_RATIO = 0.02;   // and this clean, with no stalls, before stepping up
    var HEALTH_GOOD_RUN = 5;         // clean windows before climbing - deliberately slower
    var HEALTH_MAX_STEPS = 3;        // downgrades per cycle
    var HEALTH_MAX_MOVES = 8;        // level changes per cycle
    var HEALTH_MAX_CYCLES = 2;       // down-and-up round trips per video, then it stops


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
        health.steps = 0; health.moves = 0; health.cycles = 0; health.own = false;
        health.id = active ? active.id : '';
    }

    function noteStall() {
        if (active) health.stalls++;
    }

    /* The guard may only act on Auto, or on a rung it moved to itself. A level the
       user picked by hand is off limits in both directions. */
    function healthMayAct() {
        if (health.cycles > HEALTH_MAX_CYCLES) return false;
        if (health.moves >= HEALTH_MAX_MOVES) return false;
        return qualityIdx < 0 || health.own;
    }

    function healthApply(idx) {
        health.moves++;
        health.own = true;
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

    function updateQualityLabel() {
        try {
            var span = global.document && global.document.querySelector('#button-list .icon-player-settings .label');
            if (span) {
                var text = 'Quality: ' + qualityLabel();
                if (span.textContent !== text) span.textContent = text;
            }
        } catch (e) { }
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
        return doc.querySelector('#button-list .icon-player-settings') ||
            doc.querySelector('.icon-player-settings');
    }

    function menuHost() {
        var doc = global.document;
        if (!doc) return null;
        return doc.querySelector('#player') || doc.querySelector('#movie_player') || doc.body;
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

    function buildQualityMenu() {
        if (qMenu) return qMenu;
        var doc = global.document;
        if (!doc || !doc.createElement) return null;
        var host = menuHost();
        if (!host) return null;
        var el = doc.createElement('div');
        el.id = 'yt-cp-quality-menu';
        el.style.cssText = 'position:fixed;z-index:60;display:none;min-width:200px;' +
            'padding:10px 0;background:#1f1f1f;color:#fff;border:2px solid #6b6b6b;border-radius:4px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,.65);text-align:left;pointer-events:auto;' +
            'font:normal 24px/1.4 Roboto,Arial,Helvetica,sans-serif;';
        try { host.appendChild(el); } catch (e) { return null; }
        el.addEventListener('mousedown', function (e) { if (e.stopPropagation) e.stopPropagation(); }, true);
        // rows bind their own click handler; this one is only a fallback for
        // targets inside a row that do not re-emit (the 2016 app stops bubbling)
        el.addEventListener('click', function (e) {
            var t = e.target && e.target.closest ? e.target.closest('.yt-cp-row') : null;
            if (!t) return;
            var idx = parseInt(t.getAttribute('data-idx'), 10);
            if (isNaN(idx) || idx === qMenuIdx) return;
            onQualityRowClick(idx, e);
        });
        el.addEventListener('mousemove', function (e) {
            var t = e.target && e.target.closest ? e.target.closest('.yt-cp-row') : null;
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
        xhrText(base + '/api/related?videoId=' + encodeURIComponent(id) + '&limit=20', function (res) {
            if (req !== chainRequest) return;
            chainLoadingFor = '';
            var data = null;
            try { data = JSON.parse(res); } catch (e) { beacon('CP_CHAIN_BADJSON', {}); chainFlushWaiters(null); return; }
            if (!data || !data.items || !data.items.length) {
                beacon('CP_CHAIN_EMPTY', { id: id, src: data && data.source });
                chainEmptyFor = id;          // don't keep re-asking for the same video
                chainFlushWaiters(null);
                return;
            }
            chainItems = data.items;
            beacon('CP_CHAIN_LIST', { id: id, n: chainItems.length, src: data.source });
            // resolve the up-next target right now, while the current video plays
            var first = pickChainItem(id);
            if (first) chainPrefetch(first.id);
            chainFlushWaiters(chainItems);
        });
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
       playback anyway), so the player asks for it and draws its own panel instead of
       trying to feed a 2016 renderer a 2025 response.

       Visibility rides on the transport timer: the panel shows with the controls and
       fades out with them, which is where the original client put this information. */
    var metaReq = 0;
    var metaReady = false;

    function loadVideoMeta(id) {
        var doc = global.document;
        if (!doc || !id) return;
        var seq = ++metaReq;
        hideVideoMeta();
        xhrText(base + '/api/video-meta/' + encodeURIComponent(id), function (t) {
            if (seq !== metaReq || !active || active.id !== id) return;   // moved on already
            var m = null;
            try { m = JSON.parse(t); } catch (e) { }
            if (!m || !m.title) return;
            renderVideoMeta(m);
        });
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
    function chainGo(entry, dir, manual) {
        if (!entry || !entry.id || chainBusy) return false;
        var cur = active ? active.id : getVideoId();
        if (!manual && cur && getVideoId() !== cur) return false;   // app is navigating on its own
        chainBusy = true;
        chainPendingFor = '';
        chainAdvanceTo(entry);
        beacon(dir < 0 ? 'CP_CHAIN_PREV' : 'CP_CHAIN_NEXT', { from: cur, to: entry.id, title: entry.title });
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
                if (ok) chainToast(entry, dir);
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

    readStoredQuality();
    readChainPref();

    function openMoreActions() {
        var list = global.document && global.document.querySelector('#button-list');
        var view = list && list.Xb;
        var component = view && view.parent;
        if (component && typeof component.VU === 'function') {
            try { component.VU(); return true; } catch (err) { }
        }
        var b = list && list.querySelector('.icon-ellipsis');
        if (!b) return false;
        try { b.click(); return true; } catch (err) { return false; }
    }

    function activateFocusedButton() {
        var bs = enabledButtons();
        if (!bs.length) return false;
        var i, b = null;
        for (i = 0; i < bs.length; i++) { if (bs[i].classList.contains('focused')) { b = bs[i]; break; } }
        if (!b) return false;
        var cl = typeof b.className === 'string' ? b.className : '';
        if (/icon-player-play/.test(cl)) { trTogglePlay(); return true; }
        if (/icon-player-next/.test(cl)) { return chainSkipNext(); }
        if (/icon-player-prev/.test(cl)) { return chainSkipPrev(); }
        if (/icon-player-rew/.test(cl)) { trSeek(-SEEK_STEP); return true; }
        if (/icon-player-ff/.test(cl)) { trSeek(SEEK_STEP); return true; }
        if (/yt-cp-quality|icon-player-settings/.test(cl)) { return toggleQualityMenu(b); }
        if (/icon-ellipsis/.test(cl)) return openMoreActions();
        if (/icon-home/.test(cl)) { goHome(); return true; }
        return false;
    }

    function syncUI() {
        try {
            bindInputElements();
            updateQualityLabel();
            samplePlaybackHealth();
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
                // the app renders skip/rewind/forward greyed out because its own
                // player model never reports a state, we drive all of them
                var sb = global.document.querySelectorAll('#button-list .icon-player-rew, #button-list .icon-player-ff, #button-list .icon-player-next, #button-list .icon-player-prev');
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

    function moreActionsOpen() {
        var bl = global.document && global.document.querySelector('#button-list');
        return !!(bl && bl.querySelector('.icon-ellipsis') && !bl.querySelector('.icon-player-play'));
    }

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
            if (e.preventDefault) e.preventDefault();
        }, true);

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
                    var handled = false;
                    if (/icon-player-play/.test(cl)) { trTogglePlay(); handled = true; }
                    else if (/icon-player-next/.test(cl)) { chainSkipNext(); handled = true; }
                    else if (/icon-player-prev/.test(cl)) { chainSkipPrev(); handled = true; }
                    else if (/icon-player-rew/.test(cl)) { trSeek(-SEEK_STEP); handled = true; }
                    else if (/icon-player-ff/.test(cl)) { trSeek(SEEK_STEP); handled = true; }
                    else if (/yt-cp-quality|icon-player-settings/.test(cl)) { toggleQualityMenu(b); handled = true; }
                    else if (/icon-home/.test(cl)) { goHome(); handled = true; }
                    else if (/icon-ellipsis/.test(cl)) {
                        trFocus = 'buttons';
                    }
                    pokeTransport();
                    if (handled) {
                        if (e.preventDefault) e.preventDefault();
                        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                    }
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
        // the quality list is exempt: walking a list has no side effects, and
        // swallowing a fast press there just looks like broken navigation
        if (!qMenuOpen() && nm && nm === lastKeyName && !e.repeat && (st - lastKeyAt) > 0 && (st - lastKeyAt) < KEY_DUP_MS) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            return;
        }
        lastKeyName = nm;
        lastKeyAt = st;
        handleKey(e);
    }

    function handleKey(e) {
        var tgt = e.target;
        var tag = (tgt && (tgt.tagName || '')) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (tgt && tgt.isContentEditable)) return;

        // The quality dropdown swallows navigation while it is open, whatever
        // the rest of the player is doing (it lives outside the app's focus model).
        if (qMenuOpen() && qualityMenuKey(e)) return;

        var w = watchSurface();
        var tc = trEl();
        if (!w || !tc) return;                     // only own keys while the watch surface exists
        var hash = '';
        try { hash = global.location && global.location.hash || ''; } catch (err) { }
        if (hash.indexOf('/watch') === -1) { closeQualityMenu(); return; } // non-watch screens: let the app handle its own nav
        if (!active) { closeQualityMenu(); return; } // no running session: let the app drive the screen
        var snapped = false;
        try { snapped = w.classList.contains('snapped'); } catch (err) { }
        if (snapped) return;                       // let the app navigate the behind grid
        if (moreActionsOpen()) return;

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
                showTransport();
                if (trFocus === 'seekbar') { trFocus = 'buttons'; focusButton(0); eat(); }
                break;
            case 'ArrowUp':
                showTransport();
                if (openMoreActions()) { trFocus = 'buttons'; eat(); }
                else if (trFocus === 'buttons') { trFocus = 'seekbar'; clearButtonFocus(); eat(); }
                break;
            case 'Enter':
                if (trVisible && trFocus === 'buttons' && activateFocusedButton()) eat();
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
        getHistory: function () { return chainPath.slice(); },
        stop: stopActive,
        _remount: remount,
        _engineEl: function () { return active ? active.engEl : null; }
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