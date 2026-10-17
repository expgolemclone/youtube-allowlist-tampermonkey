// ==UserScript==
// @name         YouTube Allowlist
// @namespace    https://github.com/expgolemclone/youtube-allowlist-tampermonkey
// @version      1.0.0
// @description  Only show the approved takapi channel. Best-effort page-level playback gate, not a network blocker.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @connect      www.youtube.com
// @grant        GM.xmlHttpRequest
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const channelId = 'UCVO32ccc4-bA_5HtnAx9rqw';
  const handle = '@takapi-shindanshi';
  const home = `https://www.youtube.com/${handle}/videos`;
  const hosts = new Set(['www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com']);
  const channelTabs = new Set(['', 'videos', 'shorts', 'streams', 'playlists', 'community', 'posts', 'about', 'search', 'featured']);
  const topFrame = window === window.top;
  const stateAttribute = 'data-youtube-allowlist';
  const style = document.createElement('style');
  style.textContent = `
    html:not([${stateAttribute}="allowed"]) body > :not(#youtube-allowlist-block) { display: none !important; }
    html[${stateAttribute}="allowed"] #youtube-allowlist-block,
    ytd-watch-next-secondary-results-renderer, ytd-mini-guide-renderer, ytd-guide-renderer,
    ytm-watch-next-secondary-results-renderer, ytm-related-item-section-renderer,
    .ytp-endscreen-content, .ytp-ce-element, .ytp-autonav-endscreen-upnext-container,
    .ytp-next-button { display: none !important; }
  `;
  const panel = document.createElement('main');
  panel.id = 'youtube-allowlist-block';
  const title = document.createElement('h1');
  title.textContent = 'YouTube Allowlist';
  const description = document.createElement('p');
  description.textContent = 'Only the approved channel is available. Unverified videos are blocked.';
  const link = document.createElement('a');
  link.href = home;
  link.target = '_top';
  link.textContent = 'Open takapi channel';
  panel.append(title, description, link);

  let allowed = false;
  let generation = 0;
  let lastUrl = '';
  let navigating = false;
  let request;

  function route(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password) return null;
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
    let id;
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    if (['shorts', 'live', 'embed'].includes(parts[0]) && parts.length === 2) id = parts[1];
    if (id && /^[\w-]{11}$/.test(id)) {
      return { kind: 'video', id, verifyUrl: `https://www.youtube.com/watch?v=${id}` };
    }
    const ownHandle = parts[0]?.toLowerCase() === handle;
    const ownId = parts[0] === 'channel' && parts[1] === channelId;
    const tabIndex = ownId ? 2 : 1;
    if ((ownHandle || ownId) && parts.length <= tabIndex + 1 && channelTabs.has(parts[tabIndex] ?? '')) {
      return { kind: 'channel', verifyUrl: home };
    }
    return null;
  }

  function assignedJson(html, variable) {
    const match = new RegExp(`(?:var\\s+)?${variable}\\s*=\\s*`).exec(html);
    if (!match) throw new Error(`Missing ${variable}`);
    const start = match.index + match[0].length;
    if (html[start] !== '{') throw new Error('Invalid JSON assignment');
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < html.length; index++) {
      const char = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
    throw new Error('Unterminated JSON assignment');
  }

  function approve(target, html) {
    if (target.kind === 'channel') {
      const data = assignedJson(html, 'ytInitialData');
      return data.metadata?.channelMetadataRenderer?.externalId === channelId;
    }
    const data = assignedJson(html, 'ytInitialPlayerResponse');
    return data.videoDetails?.videoId === target.id && data.videoDetails?.channelId === channelId;
  }

  function stopMedia() {
    for (const media of document.querySelectorAll('video, audio')) {
      if (!media.paused) media.pause();
      if (media.autoplay) media.autoplay = false;
    }
  }

  function render() {
    const root = document.documentElement;
    if (!root) return;
    const state = allowed ? 'allowed' : 'blocked';
    if (root.getAttribute(stateAttribute) !== state) root.setAttribute(stateAttribute, state);
    if (!style.isConnected) root.prepend(style);
    if (document.body && !panel.isConnected) document.body.prepend(panel);
    if (!allowed) stopMedia();
  }

  function lock() {
    generation++;
    allowed = false;
    const pending = request;
    request = undefined;
    pending?.abort();
    render();
  }

  async function check() {
    const url = location.href;
    if (url === lastUrl || navigating) return;
    lastUrl = url;
    lock();
    const target = route(url);
    if (!topFrame || !target) return;
    const ownGeneration = generation;
    try {
      request = GM.xmlHttpRequest({
        method: 'GET', url: target.verifyUrl, anonymous: true,
        headers: { 'Cache-Control': 'no-cache' }, timeout: 15000,
      });
      const response = await request;
      if (generation !== ownGeneration || location.href !== url || navigating) return;
      const finalUrl = new URL(response.finalUrl);
      allowed = response.status === 200 && finalUrl.origin === 'https://www.youtube.com'
        && route(finalUrl.href)?.verifyUrl === target.verifyUrl
        && approve(target, response.responseText);
    } catch {
      // A failed or cancelled request must never unlock a newer navigation.
      if (generation !== ownGeneration) return;
      allowed = false;
    } finally {
      if (generation === ownGeneration) {
        request = undefined;
        render();
      }
    }
  }

  document.addEventListener('play', event => {
    // URL polling alone would leave a playback window after an unannounced SPA transition.
    if (location.href !== lastUrl) check();
    if (!allowed && event.target instanceof HTMLMediaElement) event.target.pause();
  }, true);
  document.addEventListener('yt-navigate-start', () => {
    navigating = true;
    lastUrl = '';
    lock();
  });
  document.addEventListener('yt-navigate-finish', () => {
    navigating = false;
    lastUrl = '';
    check();
  });
  window.addEventListener('popstate', () => { lastUrl = ''; check(); });
  window.addEventListener('pageshow', () => { navigating = false; lastUrl = ''; check(); });
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a[href]');
    if (anchor && new URL(anchor.href).origin === location.origin && anchor.href !== location.href) {
      lastUrl = '';
      lock();
    }
  }, true);
  new MutationObserver(() => {
    if (location.href !== lastUrl) check();
    render();
  }).observe(document, { childList: true, subtree: true });
  setInterval(check, 100);
  render();
  check();
})();
