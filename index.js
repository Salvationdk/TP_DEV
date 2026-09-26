/**
 * TizenPluto - Pluto TV AdBlock for TizenBrew
 * Kører transparent i baggrunden uden at påvirke fjernbetjeningen.
 */

(function () {
  'use strict';

  const LOG = (...a) => console.log('[TizenPluto]', ...a);

  // ─── 1. Netværks-intercept (VOD SSAI Stripping) ─────────────────────────

  const AD_MARKERS = [
    '_ad/creative', 
    '_ad%2fcreative', 
    '_ad_bumper', 
    '/ad/creative'
  ];

  function isSessionUrl(url) {
    return typeof url === 'string' && (
      url.includes('session.json') || url.includes('/v2/session') || url.includes('/v3/session') || (url.includes('stitcher') && url.includes('session'))
    );
  }

  function isManifestUrl(url) {
    return typeof url === 'string' && (url.includes('.mpd') || url.includes('manifest') || url.includes('service-manifest'));
  }

  function isAdUrl(url) {
    if (typeof url !== 'string') return false;
    const u = url.toLowerCase();
    return AD_MARKERS.some(marker => u.includes(marker)) || u.includes('pubads') || u.includes('doubleclick');
  }

  function stripSessionJson(text) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.adBreaks)) data.adBreaks = [];
      
      if (Array.isArray(data.clips)) {
        data.clips = data.clips.filter(c => {
          const type = (c.type || '').toLowerCase();
          return type !== 'creative' && type !== 'ad' && !c.adPodId;
        });
      }
      
      if (data.stitcherSession && Array.isArray(data.stitcherSession.adBreaks)) {
        data.stitcherSession.adBreaks = [];
      }
      return JSON.stringify(data);
    } catch (e) {
      return text;
    }
  }

  function stripDashAdPeriods(mpdText) {
    try {
      return mpdText.replace(/<Period[\s\S]*?<\/Period>/gi, (period) => {
        const lower = period.toLowerCase();
        if (AD_MARKERS.some(m => lower.includes(m))) {
          LOG('Dropped ad Period');
          return ''; 
        }
        return period;
      });
    } catch (e) {
      return mpdText;
    }
  }

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';

    if (isAdUrl(url) && !isManifestUrl(url) && !isSessionUrl(url)) {
      return new Response('', { status: 204 });
    }

    const res = await _fetch.apply(this, args);

    if (isSessionUrl(url) || isManifestUrl(url)) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        let newBody = isSessionUrl(url) ? stripSessionJson(text) : (text.includes('<Period') ? stripDashAdPeriods(text) : text);

        return new Response(newBody, {
          status: res.status, statusText: res.statusText, headers: res.headers
        });
      } catch (e) { LOG('Fetch rewrite failed', e); }
    }
    return res;
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._plutoUrl = url;
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._plutoUrl || '';

    if (isAdUrl(url) && !isManifestUrl(url) && !isSessionUrl(url)) {
      Object.defineProperty(this, 'status', { value: 204 });
      Object.defineProperty(this, 'responseText', { value: '' });
      setTimeout(() => this.dispatchEvent(new Event('load')), 0);
      return;
    }

    if (isSessionUrl(url) || isManifestUrl(url)) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState === 4 && this.responseText) {
          try {
            let body = this.responseText;
            if (isSessionUrl(url)) body = stripSessionJson(body);
            else if (isManifestUrl(url) && body.includes('<Period')) body = stripDashAdPeriods(body);
            
            Object.defineProperty(this, 'responseText', { value: body });
            Object.defineProperty(this, 'response', { value: body });
          } catch (_) {}
        }
      });
    }
    return _send.apply(this, args);
  };

  // ─── 2. Live-TV Slate via ID3/In-band Metadata ────────────────────────────

  let adOverlay = null;

  function ensureOverlay() {
    if (adOverlay) return adOverlay;
    adOverlay = document.createElement('div');
    adOverlay.id = 'pluto-adblock-slate';
    Object.assign(adOverlay.style, {
      position: 'fixed', inset: '0', background: '#000',
      zIndex: '999999', display: 'none', alignItems: 'center',
      justifyContent: 'center', color: '#444', fontFamily: 'sans-serif',
      fontSize: '28px', pointerEvents: 'none'
    });
    adOverlay.textContent = 'Ad break';
    document.documentElement.appendChild(adOverlay);
    return adOverlay;
  }

  function setSlateState(isAd) {
    const overlay = ensureOverlay();
    overlay.style.display = isAd ? 'flex' : 'none';

    document.querySelectorAll('video').forEach(v => {
      if (isAd) {
        if (!v.muted) {
          v.dataset.wasMuted = 'false';
          v.muted = true;
        } else if (v.dataset.wasMuted !== 'false') {
          v.dataset.wasMuted = 'true';
        }
      } else {
        if (v.dataset.wasMuted === 'false') {
          v.muted = false;
          v.dataset.wasMuted = ''; 
        }
      }
    });
  }

  function attachMetadataListener(video) {
    if (video.dataset.metadataAttached) return;
    video.dataset.metadataAttached = 'true';

    const checkCueForAd = (cue) => {
      if (!cue) return;
      let textData = '';
      if (cue.text) textData = cue.text.toLowerCase();
      if (cue.value && cue.value.data) {
        try { textData += String.fromCharCode.apply(null, new Uint8Array(cue.value.data)).toLowerCase(); } 
        catch (e) {}
      }
      
      if (textData.includes('adbreak') || textData.includes('scte35') || textData.includes('ad-pod')) {
        setSlateState(true);
      }
    };

    Array.from(video.textTracks).forEach(track => {
      if (track.kind === 'metadata') {
        track.mode = 'hidden';
        track.addEventListener('cuechange', () => {
          if (track.activeCues && track.activeCues.length > 0) {
            Array.from(track.activeCues).forEach(checkCueForAd);
          } else {
            setSlateState(false);
          }
        });
      }
    });

    video.addEventListener('addtexttrack', (e) => {
      const track = e.track;
      if (track.kind === 'metadata') {
        track.mode = 'hidden';
        track.addEventListener('cuechange', () => {
          if (track.activeCues && track.activeCues.length > 0) {
            Array.from(track.activeCues).forEach(checkCueForAd);
          } else {
            setSlateState(false);
          }
        });
      }
    });
  }

  const mo = new MutationObserver(() => {
    document.querySelectorAll('video').forEach(attachMetadataListener);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  LOG('Loaded – Adblocker kører i baggrunden.');
})();
        
