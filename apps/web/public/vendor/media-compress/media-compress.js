/*!
 * MWAR media-compress v1 — Layer 1 (on the user's device) of the 2-layer media limits.
 *   compressImage(file)  -> WebP (JPEG where the browser cannot encode WebP), longest edge <= 1080 px, <= 200 KB
 *   compressVideo(file)  -> MP4 under 720p (target 540p, ~1.1 Mbps), <= 3 minutes
 * Loaded on demand (home feed, profile, chat) by apps/web/src/lib/mediaCompress.ts; the API gate
 * (Layer 2) rejects anything larger, and the page then reloads this file with ?v=<timestamp>.
 */
(function () {
  'use strict';
  var VERSION = 1;
  var IMG_MAX_EDGE = 1080;
  var IMG_TARGET_BYTES = 200 * 1024;
  var VIDEO_MAX_SECONDS = 180;
  var VIDEO_TARGET_SHORT = 540;
  var VIDEO_MAX_LONG = 1280;
  var VIDEO_MAX_SHORT = 720;
  var VIDEO_BITRATE = 1100000;
  var VIDEO_PASSTHROUGH_BYTES = 40 * 1024 * 1024;

  function err(code, msg) {
    var e = new Error(msg || code);
    e.code = code;
    return e;
  }

  function loadImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return createImageBitmap(file);
      });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(err('IMAGE_UNREADABLE'));
      };
      img.src = url;
    });
  }

  function toBlob(canvas, type, q) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, type, q);
    });
  }

  var webpOk = null;
  function canWebp() {
    if (webpOk !== null) return Promise.resolve(webpOk);
    var c = document.createElement('canvas');
    c.width = c.height = 2;
    return toBlob(c, 'image/webp', 0.8).then(function (b) {
      webpOk = !!b && b.type === 'image/webp';
      return webpOk;
    });
  }

  /** opts: { maxEdge, maxBytes, maxWidth, maxHeight, crop: false|'cover', forceWebp } */
  function compressImage(file, opts) {
    opts = opts || {};
    var maxEdge = opts.maxEdge || IMG_MAX_EDGE;
    var maxBytes = opts.maxBytes || IMG_TARGET_BYTES;
    if (!file || !/^image\//.test(file.type)) return Promise.reject(err('NOT_IMAGE'));
    return Promise.all([loadImage(file), canWebp()]).then(function (r) {
      var img = r[0];
      var type = r[1] ? 'image/webp' : 'image/jpeg';
      if (opts.forceWebp && !r[1]) throw err('NO_WEBP', 'This browser cannot create WebP images');
      var nw = img.width || img.naturalWidth;
      var nh = img.height || img.naturalHeight;
      if (!nw || !nh) throw err('IMAGE_UNREADABLE');
      // Source crop (cover) for fixed boxes such as the 1200x400 profile cover
      var sx = 0, sy = 0, sw = nw, sh = nh, w, h;
      if (opts.maxWidth && opts.maxHeight && opts.crop === 'cover') {
        var target = opts.maxWidth / opts.maxHeight;
        if (nw / nh > target) {
          sw = Math.round(nh * target);
          sx = Math.round((nw - sw) / 2);
        } else {
          sh = Math.round(nw / target);
          sy = Math.round((nh - sh) / 2);
        }
        w = Math.min(opts.maxWidth, sw);
        h = Math.round((w * opts.maxHeight) / opts.maxWidth);
      } else {
        var scale = Math.min(1, maxEdge / Math.max(nw, nh));
        w = Math.max(1, Math.round(nw * scale));
        h = Math.max(1, Math.round(nh * scale));
      }
      var quality = 0.8;
      var attempt = 0;
      function step() {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) throw err('NO_CANVAS');
        if (type === 'image/jpeg') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        return toBlob(canvas, type, quality).then(function (blob) {
          if (!blob) throw err('ENCODE_FAILED');
          if (blob.size <= maxBytes) {
            if (img.close) img.close();
            return { blob: blob, width: w, height: h, type: blob.type };
          }
          if (++attempt >= 10) throw err('IMAGE_TOO_LARGE', 'Image is too large even after compression');
          if (quality > 0.55) quality = Math.round((quality - 0.1) * 100) / 100;
          else {
            w = Math.max(1, Math.round(w * 0.82));
            h = Math.max(1, Math.round(h * 0.82));
          }
          return step();
        });
      }
      return step();
    });
  }

  function videoMeta(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      v.onloadedmetadata = function () {
        resolve({ el: v, url: url, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      };
      v.onerror = function () {
        URL.revokeObjectURL(url);
        reject(err('VIDEO_UNREADABLE'));
      };
      v.src = url;
    });
  }

  function mp4RecorderType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
    var types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    return null;
  }

  /**
   * opts.onProgress(0..1). Already-small MP4s (<= 1280x720, <= 40 MB) are kept as they are; anything
   * else is re-encoded in real time through <canvas> + MediaRecorder (MP4 / H.264).
   */
  function compressVideo(file, opts) {
    opts = opts || {};
    if (!file || !/^video\//.test(file.type)) return Promise.reject(err('NOT_VIDEO'));
    return videoMeta(file).then(function (m) {
      if (!isFinite(m.duration) || m.duration > VIDEO_MAX_SECONDS + 0.5) {
        URL.revokeObjectURL(m.url);
        throw err('VIDEO_TOO_LONG');
      }
      var long = Math.max(m.width, m.height);
      var short = Math.min(m.width, m.height);
      if (file.type === 'video/mp4' && long <= VIDEO_MAX_LONG && short <= VIDEO_MAX_SHORT && file.size <= VIDEO_PASSTHROUGH_BYTES) {
        URL.revokeObjectURL(m.url);
        if (opts.onProgress) opts.onProgress(1);
        return { blob: file, width: m.width, height: m.height, durationSec: m.duration, type: 'video/mp4', transcoded: false };
      }
      var mime = mp4RecorderType();
      if (!mime) {
        URL.revokeObjectURL(m.url);
        throw err('VIDEO_NO_ENCODER');
      }
      var scale = Math.min(1, VIDEO_TARGET_SHORT / short, VIDEO_MAX_LONG / long);
      var w = Math.round((m.width * scale) / 2) * 2;
      var h = Math.round((m.height * scale) / 2) * 2;
      return new Promise(function (resolve, reject) {
        var v = m.el;
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        var stream = canvas.captureStream(30);
        try {
          var src = v.captureStream ? v.captureStream() : v.mozCaptureStream ? v.mozCaptureStream() : null;
          if (src) src.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
        } catch (e) { /* no audio */ }
        var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: 96000 });
        var chunks = [];
        var raf = 0;
        var done = false;
        rec.ondataavailable = function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        rec.onstop = function () {
          cancelAnimationFrame(raf);
          URL.revokeObjectURL(m.url);
          var blob = new Blob(chunks, { type: 'video/mp4' });
          if (opts.onProgress) opts.onProgress(1);
          resolve({ blob: blob, width: w, height: h, durationSec: m.duration, type: 'video/mp4', transcoded: true });
        };
        rec.onerror = function () {
          URL.revokeObjectURL(m.url);
          reject(err('VIDEO_ENCODE_FAILED'));
        };
        function draw() {
          if (done) return;
          ctx.drawImage(v, 0, 0, w, h);
          if (opts.onProgress && m.duration) opts.onProgress(Math.min(0.99, v.currentTime / m.duration));
          raf = requestAnimationFrame(draw);
        }
        v.onended = function () {
          done = true;
          if (rec.state !== 'inactive') rec.stop();
        };
        v.muted = false;
        v.volume = 0;
        v.currentTime = 0;
        rec.start(1000);
        v.play().then(draw).catch(function () {
          // Autoplay with sound refused: record silently
          v.muted = true;
          v.play().then(draw).catch(function () {
            reject(err('VIDEO_ENCODE_FAILED'));
          });
        });
      });
    });
  }

  window.MwarMediaCompress = {
    version: VERSION,
    compressImage: compressImage,
    compressVideo: compressVideo,
    limits: { IMG_MAX_EDGE: IMG_MAX_EDGE, IMG_TARGET_BYTES: IMG_TARGET_BYTES, VIDEO_MAX_SECONDS: VIDEO_MAX_SECONDS },
  };
})();
