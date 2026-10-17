import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright';

const source = await readFile(new URL('../youtube-allowlist.user.js', import.meta.url), 'utf8');
const channelId = 'UCVO32ccc4-bA_5HtnAx9rqw';
const ownVideo = 'abcdefghijk';
const otherVideo = 'other123456';
const home = 'https://www.youtube.com/@takapi-shindanshi/videos';
const watch = id => `https://www.youtube.com/watch?v=${id}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const player = details => `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: details })};`;
const channel = id => `var ytInitialData = ${JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: id } } })};`;

function response(url) {
  const id = new URL(url).searchParams.get('v');
  return {
    status: 200, finalUrl: url,
    responseText: id ? player({ videoId: id, channelId: id === ownVideo ? channelId : 'UC_OTHER', title: 'brace } quote " escape \\ and ;' }) : channel(channelId),
  };
}

for (const [name, engine] of Object.entries({ chromium, webkit })) describe(`${name} userscript`, () => {
  let browser, context, page, requests, errors, handler;

  before(async () => { browser = await engine.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    requests = [];
    errors = [];
    handler = async details => response(details.url);
    context = await browser.newContext(devices['iPhone 13']);
    await context.exposeBinding('__verify', async (_, details) => {
      requests.push(details);
      return handler(details);
    });
    // Emulate only the privileged manager API. The unmodified userscript runs in the browser.
    await context.addInitScript({ content: `(() => {
      if (!['www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(location.hostname)) return;
      const GM = { xmlHttpRequest(details) {
        let reject;
        const promise = new Promise((resolve, fail) => {
          reject = fail;
          window.__verify(details).then(resolve, fail);
        });
        promise.abort = () => { if (!window.__ignoreAbort) reject(new Error('Aborted')); };
        return promise;
      } };
      ${source}
    })();` });
    await context.route('**/*', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><h2>Original content</h2><video autoplay></video><audio autoplay></audio><ytm-related-item-section-renderer>Recommendations</ytm-related-item-section-renderer></body></html>',
    }));
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
  });
  afterEach(async () => {
    await context?.close();
    assert.deepEqual(errors, [], 'No uncaught script errors');
  });

  async function state(expected) {
    await page.waitForFunction(value => document.documentElement.getAttribute('data-youtube-allowlist') === value, expected);
  }

  async function visit(url, expected) {
    await page.goto(url);
    await state(expected);
    if (expected === 'blocked') {
      await page.waitForTimeout(150);
      assert.equal(await page.locator('html').getAttribute('data-youtube-allowlist'), 'blocked');
    }
  }

  async function navigate(path, events = true) {
    await page.evaluate(({ path, events }) => {
      if (events) document.dispatchEvent(new Event('yt-navigate-start'));
      history.pushState({}, '', path);
      if (events) document.dispatchEvent(new Event('yt-navigate-finish'));
    }, { path, events });
  }

  test('unknown routes stay hidden without verification requests', async () => {
    for (const path of ['/', '/results?search_query=takapi', '/@other', '/watch?v=bad', '/@takapi-shindanshi/unknown', '/shorts/abcdefghijk/extra']) {
      await visit(`https://www.youtube.com${path}`, 'blocked');
      assert.equal(await page.locator('h2').isVisible(), false);
      assert.equal(await page.locator('#youtube-allowlist-block').isVisible(), true);
      assert.equal(await page.locator('#youtube-allowlist-block a').getAttribute('href'), home);
    }
    assert.equal(requests.length, 0);
  });

  test('approved channel tabs and mobile video routes are verified', async () => {
    for (const url of [home, `https://www.youtube.com/channel/${channelId}/streams`, 'https://www.youtube.com/@TAKAPI-SHINDANSHI/shorts', watch(ownVideo), `https://m.youtube.com/watch?v=${ownVideo}`, `https://m.youtube.com/shorts/${ownVideo}`, `https://www.youtube.com/live/${ownVideo}`, `https://www.youtube-nocookie.com/embed/${ownVideo}`]) {
      await visit(url, 'allowed');
      assert.equal(await page.locator('h2').isVisible(), true);
      assert.equal(await page.locator('#youtube-allowlist-block').isVisible(), false);
      assert.equal(await page.locator('ytm-related-item-section-renderer').isVisible(), false);
    }
    assert.ok(requests.length >= 8);
    for (const request of requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.anonymous, true);
      assert.equal(request.timeout, 15000);
      assert.equal(new URL(request.url).origin, 'https://www.youtube.com');
    }
  });

  test('other uploader cannot be authorized by recommended channel metadata', async () => {
    handler = async details => ({ ...response(details.url), responseText: player({ videoId: otherVideo, channelId: 'UC_OTHER', recommended: { channelId } }) });
    await visit(watch(otherVideo), 'blocked');
  });

  test('video identity must match, even when uploader is approved', async () => {
    handler = async details => ({ ...response(details.url), responseText: player({ videoId: otherVideo, channelId }) });
    await visit(watch(ownVideo), 'blocked');
  });

  test('channel approval uses channel metadata, not recommendation IDs', async () => {
    handler = async details => ({ ...response(details.url), responseText: `${channel('UC_OTHER')} /* ${channelId} */` });
    await visit(home, 'blocked');
  });

  test('missing, malformed and truncated verification metadata fail closed', async () => {
    for (const html of ['', '<html>Consent required</html>', 'var ytInitialPlayerResponse = {', 'var ytInitialPlayerResponse = {bad};', 'var ytInitialPlayerResponse = "bad";', 'var ytInitialPlayerResponse = {};']) {
      handler = async details => ({ ...response(details.url), responseText: html });
      await visit(watch(ownVideo), 'blocked');
    }
  });

  test('HTTP errors, redirects and network failures never unlock content', async () => {
    for (const override of [{ status: 403 }, { finalUrl: 'https://consent.youtube.com/' }, { finalUrl: 'http://www.youtube.com/watch?v=abcdefghijk' }, { finalUrl: watch(otherVideo) }, { finalUrl: 'https://www.youtube.com.evil.test/watch?v=abcdefghijk' }, { finalUrl: undefined }]) {
      handler = async details => ({ ...response(details.url), ...override });
      await visit(watch(ownVideo), 'blocked');
    }
    for (const message of ['Network failure', 'Timeout']) {
      handler = async () => { throw new Error(message); };
      await visit(watch(ownVideo), 'blocked');
    }
  });

  test('verification pending keeps page and media blocked', async () => {
    handler = async details => { await delay(400); return response(details.url); };
    await page.goto(watch(ownVideo));
    await state('blocked');
    assert.equal(await page.locator('h2').isVisible(), false);
    assert.equal(await page.locator('video').getAttribute('autoplay'), null);
    assert.equal(await page.locator('audio').getAttribute('autoplay'), null);
    await state('allowed');
  });

  test('SPA navigation revokes approval synchronously before the URL changes', async () => {
    await visit(watch(ownVideo), 'allowed');
    const locked = await page.evaluate(() => {
      document.dispatchEvent(new Event('yt-navigate-start'));
      return document.documentElement.getAttribute('data-youtube-allowlist');
    });
    assert.equal(locked, 'blocked');
    await navigate(`/watch?v=${otherVideo}`);
    await state('blocked');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('html').getAttribute('data-youtube-allowlist'), 'blocked');
  });

  test('silent mobile SPA transitions are detected without YouTube events', async () => {
    await visit(`https://m.youtube.com/watch?v=${ownVideo}`, 'allowed');
    await navigate(`/watch?v=${otherVideo}`, false);
    await state('blocked');
    await navigate(`/watch?v=${ownVideo}`, false);
    await state('allowed');
  });

  test('stale successful verification cannot unlock a new denied route', async () => {
    handler = async details => { await delay(details.url.includes(ownVideo) ? 400 : 10); return response(details.url); };
    await page.goto(watch(ownVideo));
    await page.evaluate(() => { window.__ignoreAbort = true; });
    await navigate(`/watch?v=${otherVideo}`);
    await page.waitForTimeout(600);
    await state('blocked');
  });

  test('cancellation of old verification does not undo a newer approval', async () => {
    handler = async details => { await delay(details.url.includes(otherVideo) ? 400 : 10); return response(details.url); };
    await page.goto(watch(otherVideo));
    await navigate(`/watch?v=${ownVideo}`);
    await state('allowed');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('html').getAttribute('data-youtube-allowlist'), 'allowed');
  });

  test('late failure cannot undo a newer approval when abort is ignored', async () => {
    handler = async details => {
      if (details.url.includes(otherVideo)) { await delay(400); throw new Error('Late failure'); }
      return response(details.url);
    };
    await page.goto(watch(otherVideo));
    await page.evaluate(() => { window.__ignoreAbort = true; });
    await navigate(`/watch?v=${ownVideo}`);
    await state('allowed');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('html').getAttribute('data-youtube-allowlist'), 'allowed');
  });

  test('reload, history and page restoration verify again', async () => {
    await visit(watch(ownVideo), 'allowed');
    const count = requests.length;
    await page.reload();
    await state('allowed');
    assert.ok(requests.length > count);
    await navigate(`/watch?v=${otherVideo}`);
    await state('blocked');
    await page.goBack();
    await state('allowed');
    handler = async details => ({ ...response(details.url), status: 503 });
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await state('blocked');
  });

  test('same-origin link clicks revoke access immediately', async () => {
    await visit(watch(ownVideo), 'allowed');
    const locked = await page.evaluate(id => {
      const link = document.createElement('a');
      link.href = `/watch?v=${id}`;
      link.textContent = 'Other video';
      link.addEventListener('click', event => event.preventDefault());
      document.body.append(link);
      link.click();
      return document.documentElement.getAttribute('data-youtube-allowlist');
    }, otherVideo);
    assert.equal(locked, 'blocked');
  });

  test('blocked play events pause both audio and video, including silent URL changes', async () => {
    await visit(watch(ownVideo), 'allowed');
    const paused = await page.evaluate(id => {
      history.pushState({}, '', `/watch?v=${id}`);
      return ['video', 'audio'].map(tag => {
        const media = document.querySelector(tag);
        let calls = 0;
        media.pause = () => { calls++; };
        media.dispatchEvent(new Event('play'));
        return calls;
      });
    }, otherVideo);
    assert.ok(paused.every(calls => calls >= 1));
    await state('blocked');
  });

  test('blocked gate survives body replacement without mutation loops', async () => {
    await visit('https://www.youtube.com/', 'blocked');
    await page.evaluate(() => {
      document.documentElement.querySelector('style').remove();
      const body = document.createElement('body');
      body.innerHTML = '<h2>Replacement content</h2><video autoplay></video>';
      document.body.replaceWith(body);
    });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('h2').isVisible(), false);
    assert.equal(await page.locator('#youtube-allowlist-block').count(), 1);
    assert.equal(await page.locator('#youtube-allowlist-block').isVisible(), true);
    assert.equal(await page.locator('video').getAttribute('autoplay'), null);
  });

  test('child frames do not inherit approval or make verification requests', async () => {
    await visit(watch(ownVideo), 'allowed');
    const count = requests.length;
    await page.evaluate(id => {
      const frame = document.createElement('iframe');
      frame.src = `https://www.youtube-nocookie.com/embed/${id}`;
      document.body.append(frame);
    }, ownVideo);
    const frame = await page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/embed/') });
    await frame.waitForFunction(() => document.documentElement.getAttribute('data-youtube-allowlist') === 'blocked');
    assert.equal(await frame.locator('h2').isVisible(), false);
    assert.equal(requests.length, count);
  });

  test('unrelated websites are untouched', async () => {
    await page.goto('https://example.com/');
    assert.equal(await page.locator('html').getAttribute('data-youtube-allowlist'), null);
    assert.equal(await page.locator('h2').isVisible(), true);
    assert.equal(requests.length, 0);
  });
});

test('standalone install metadata uses only the required privileged API', () => {
  assert.ok(source.startsWith('// ==UserScript==\n'));
  assert.match(source, /\/\/ @run-at\s+document-start/);
  assert.deepEqual([...source.matchAll(/\/\/ @grant\s+(\S+)/g)].map(match => match[1]), ['GM.xmlHttpRequest']);
  assert.deepEqual([...source.matchAll(/\/\/ @connect\s+(\S+)/g)].map(match => match[1]), ['www.youtube.com']);
  assert.equal(source.includes('@require'), false);
  assert.equal(source.includes('chrome.runtime'), false);
});
