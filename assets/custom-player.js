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
    global.__CUSTOM_PLAYER_VERSION = '20261020';

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
    EngineNativeHls.prototype.setQuality = function (h) {
        var el = this.conf && this.conf.el;
        if (!el) return;
        var baseUrl = String(this.conf.hlsUrl || '').split('?')[0];
        if (!baseUrl) return;
        var t = el.currentTime || 0;
        var playing = el.paused === false;
        try { el.pause(); } catch (e) { }
        el.removeAttribute('src');
        try { el.load(); } catch (e) { }
        var onMeta = function () {
            el.removeEventListener('loadedmetadata', onMeta);
            try { if (t > 1 && isFinite(el.duration) && t < el.duration) el.currentTime = t; } catch (e) { }
            if (playing && el.paused) { var p = el.play(); if (p && p.catch) p.catch(function () { }); }
        };
        el.addEventListener('loadedmetadata', onMeta);
        el.src = baseUrl + (h ? '?q=' + h : '');
        try { el.load(); } catch (e) { }
        beacon('CP_Q_RESTART', { h: h || 0, t: Math.round(t * 10) / 10 });
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
    EngineHlsJs.prototype.setPendingQ = function (h) {
        this._pendingQ = h || null;
        if (this._hls && this._hls.levels && this._hls.levels.length) this.setQuality(h);
    };
    EngineHlsJs.prototype.setQuality = function (h) {
        var hls = this._hls;
        if (!hls || !hls.levels || !hls.levels.length) { this._pendingQ = h || null; return; }
        var idx = -1, i;
        if (h) { for (i = 0; i < hls.levels.length; i++) if (hls.levels[i].height === h) { idx = i; break; } }
        try { hls.currentLevel = idx; } catch (e) { }
        beacon('HLSJS_Q', { h: h || 0, idx: idx, levels: hls.levels.length });
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
        var fireFirst = function () {
            if (firstFired || !current()) return;
            firstFired = true;
            beacon('MSE_FIRST_APPEND', { len: sb.buffered && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : -1 });
            if (onFirst) onFirst();
        };
        var finish = function () {
            if (finished) return;
            finished = true;
            if (done && current()) done();
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

    function defaultVideo(links) {
        var candidates = (links || []).filter(function (l) { return l && l.url && linkMime(l).indexOf('video/') === 0; });
        if (!candidates.length) return null;
        var preferred = [360, 240, 480, 144, 720, 1080, 1440, 2160, 4320], i, j;
        for (i = 0; i < preferred.length; i++) {
            for (j = 0; j < candidates.length; j++) if (formatHeight(candidates[j]) === preferred[i]) return candidates[j];
        }
        return candidates[0];
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

    var qualityList = [];
    var qualityIdx = -1;
    var qualityListId = '';
    var qualityMode = '';
    var qualityRequest = 0;
    var storedHeight = 0;

    function readStoredQuality() {
        storedHeight = 0;
        try {
            var v = parseInt(global.localStorage && global.localStorage.getItem('ytc_quality'), 10);
            if (isFinite(v) && v > 0) storedHeight = v;
        } catch (e) { }
    }

    function qualityLabel() {
        var h = currentHeight();
        return h ? h + 'p' : 'Auto';
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
        xhrText(base + '/api/hls/' + encodeURIComponent(id), function (t) {
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
        saveQuality();
        applyQuality();
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
        saveQuality();
        applyQuality();
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

    function updateQualityLabel() {
        try {
            var span = global.document && global.document.querySelector('#button-list .yt-cp-quality > span');
            if (span && span.textContent !== qualityLabel()) span.textContent = qualityLabel();
        } catch (e) { }
    }

    readStoredQuality();

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
        else if (/yt-cp-quality/.test(cl)) cycleQuality();
        else if (/icon-home/.test(cl)) goHome();
    }

    function syncUI() {
        try {
            bindInputElements();
            updateQualityLabel();
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
                    else if (/yt-cp-quality/.test(cl)) cycleQuality();
                    else if (/icon-home/.test(cl)) goHome();
                    pokeTransport();
                    if (e.preventDefault) e.preventDefault();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                }, true);
        }

        if (bl) {
            try {
                if (!bl.querySelector('.yt-cp-quality')) {
                    var qBtn = doc.createElement('div');
                    qBtn.className = 'yt-cp-quality button';
                    qBtn.setAttribute('tabindex', '-1');
                    qBtn.title = 'Quality';
                    qBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;min-width:64px;height:40px;padding:0 12px;margin:0 6px;font-size:20px;line-height:40px;text-align:center;color:rgba(255,255,255,0.9);background:rgba(0,0,0,0.55);border-radius:4px;cursor:pointer;';
                    qBtn.innerHTML = '<span>Auto</span>';
                    bl.appendChild(qBtn);
                }
            } catch (e2) { }
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
        if (nm && nm === lastKeyName && !e.repeat && (st - lastKeyAt) > 0 && (st - lastKeyAt) < KEY_DUP_MS) {
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

        var w = watchSurface();
        var tc = trEl();
        if (!w || !tc) return;                     // only own keys while the watch surface exists
        var hash = '';
        try { hash = global.location && global.location.hash || ''; } catch (err) { }
        if (hash.indexOf('/watch') === -1) return; // non-watch screens: let the app handle its own nav
        if (!active) return;                       // no running session: let the app drive the screen
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

    try { global.document.addEventListener('keydown', keydownRoot, true); } catch (e) { }

    /* be visible before tv-player.js uses us */
    var Api = {
        start: start,
        startById: startById,
        isActive: function () { return !!active; },
        activeVideo: function () { return active ? active.id : null; },
        getQuality: function () { return { height: currentHeight(), levels: qualityList.slice(), auto: qualityIdx < 0 }; },
        setQuality: setQualityTo,
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