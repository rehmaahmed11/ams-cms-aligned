// Focused tests for the two plugin features:
//   - zip upload: install / replace / toggle / delete a plugin package
//   - robots.txt: editable file, default rendering, sitemap line behaviour
//
//   npm run build && node --test tests/plugins.test.mjs
//
// A packaged plugin is the same kind of thing as a snippet: stored in the
// hooks table, injected into the public pages, toggleable and deletable from
// the admin. The robots file is served at /robots.txt — the saved text, with
// the sitemap line added or dropped to match the Sitemap plugin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { createHarness } from './helpers.mjs';
import { FIXTURE, fixtureFiles } from './fixture-theme.mjs';

const panel = createHarness();
const THEME = FIXTURE;

/** Builds a small zip in memory (first file stored, the rest deflated). */
function makeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text), nameBuf = Buffer.from(name);
    const method = i === 0 ? 0 : 8;
    const data = method ? deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, data); central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

async function uploadPlugin(files, name = 'plugin.zip') {
  const bytes = typeof files === 'string' ? makeZip({ 'plugin.json': files }) : files;
  const body = new FormData();
  body.set('_csrf', await panel.csrf());
  body.append('plugin', new Blob([bytes], { type: 'application/zip' }), name);
  const res = await panel.request(`${panel.admin}/plugins/upload`, { method: 'POST', body });
  return res;
}

async function uploadPackage(manifest, codeName, code) {
  return uploadPlugin(makeZip({
    'plugin.json': JSON.stringify({ file: codeName, ...manifest }),
    [codeName]: code,
  }));
}

/** The admin list row for a package, found through its name anchor. */
async function packageRow(name) {
  const text = (await panel.get(`${panel.admin}/plugins`)).text;
  const m = text.match(new RegExp(`<a href="[^"]*/plugins/(\\d+)">${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
  assert.ok(m, `plugin "${name}" is listed`);
  return Number(m[1]);
}

/** Uploads the fixture theme so public pages render (the app ships none). */
async function useTheme() {
  const body = new FormData();
  body.set('_csrf', await panel.csrf());
  body.append('theme', new Blob([makeZip(fixtureFiles())], { type: 'application/zip' }), `${THEME.slug}.zip`);
  const res = await panel.request(`${panel.admin}/themes/upload`, { method: 'POST', body });
  assert.match(res.location || '', /installed|updated/);
  const row = (await panel.get(`${panel.admin}/themes`)).text.match(new RegExp(`data-theme-id="(\\d+)"[^>]*data-theme-slug="${THEME.slug}"`));
  assert.ok(row, 'the uploaded theme is listed');
  await panel.adminPost(`/themes/${row[1]}/activate`, {});
  return row[1];
}

before(async () => {
  await panel.start();
  await panel.install();
  await useTheme();
});

after(async () => {
  await panel.stop();
  panel.cleanup();
});

/* ==========================================================================
   Zip upload: install, replace, toggle, delete.
   ========================================================================== */

test('a plugin package installs from a zip and is injected, toggleable and deletable', async () => {
  const res = await uploadPackage(
    { name: 'E2E Analytics Kit', hook: 'footer', slug: 'e2e-kit', version: '1.0.0', description: 'Tracking tag' },
    'kit.js', '<script>window.__e2eKit = "on";</script><!-- e2e-kit-marker -->',
  );
  assert.match(res.location, /installed/, res.location);
  assert.match(res.location, /E2E Analytics Kit/);

  const list = (await panel.get(`${panel.admin}/plugins`)).text;
  assert.match(list, /E2E Analytics Kit/, 'the installed package is listed in Your plugins');
  assert.match(list, /v1\.0\.0/, 'the package shows its version');

  const page = await panel.anon('/');
  assert.match(page.text, /e2e-kit-marker/, 'the package code is injected into public pages');

  const id = await packageRow('E2E Analytics Kit');
  await panel.adminPost(`/plugins/${id}/toggle`, {});
  assert.doesNotMatch((await panel.anon('/')).text, /e2e-kit-marker/, 'deactivating the package removes it');
  await panel.adminPost(`/plugins/${id}/toggle`, {});
  assert.match((await panel.anon('/')).text, /e2e-kit-marker/, 'reactivating brings the package back');

  await panel.adminPost(`/plugins/${id}/delete`, {});
  const after = (await panel.get(`${panel.admin}/plugins`)).text;
  assert.doesNotMatch(after, /E2E Analytics Kit/, 'deleting the package removes it from the list');
  assert.doesNotMatch((await panel.anon('/')).text, /e2e-kit-marker/);
});

test('uploading the same package replaces it, keeping its on/off state', async () => {
  await uploadPackage(
    { name: 'E2E Analytics Kit', hook: 'footer', slug: 'e2e-kit', version: '1.0.0' },
    'kit.js', '<!-- e2e-kit-v1 -->',
  );
  const id = await packageRow('E2E Analytics Kit');
  await panel.adminPost(`/plugins/${id}/toggle`, {}); // deactivate before the replace

  const res = await uploadPackage(
    { name: 'E2E Analytics Kit', hook: 'footer', slug: 'e2e-kit', version: '1.1.0', description: 'Tracking tag v2' },
    'kit.js', '<!-- e2e-kit-v2 -->',
  );
  assert.match(res.location, /updated/, res.location);
  assert.match(res.location, /E2E Analytics Kit/);

  const list = (await panel.get(`${panel.admin}/plugins`)).text;
  assert.equal((list.match(/>E2E Analytics Kit<\/a>/g) || []).length, 1, 'one row, not two');
  assert.match(list, /v1\.1\.0/, 'the new version is listed');

  // The package was deactivated before the replace; that state survives.
  assert.doesNotMatch((await panel.anon('/')).text, /e2e-kit-v2/, 'on/off state is kept across a replace');

  await panel.adminPost(`/plugins/${id}/toggle`, {}); // reactivate
  assert.match((await panel.anon('/')).text, /e2e-kit-v2/, 'reactivating injects the new version');
  assert.doesNotMatch((await panel.anon('/')).text, /e2e-kit-v1/, 'the old version is gone');

  await panel.adminPost(`/plugins/${id}/delete`, {});
  assert.doesNotMatch((await panel.get(`${panel.admin}/plugins`)).text, /E2E Analytics Kit/);
});

test('invalid packages are refused and never installed', async () => {
  async function refuse(files, expectWhy) {
    const res = await uploadPlugin(files);
    assert.match(res.location || '', /err=/, expectWhy + ': the error flash is shown');
    assert.match(res.location || '', expectWhy, expectWhy);
  }

  // Not a zip at all.
  await refuse(Buffer.from('just a plain text file'), /not a plain file|zip/i);
  // The manifest is missing.
  await refuse(makeZip({ 'code.html': '<p>no manifest</p>' }), /plugin\.json/);
  // An unexpected extra file.
  await refuse(makeZip({
    'plugin.json': JSON.stringify({ name: 'Too Many Pack', hook: 'head', slug: 'too-many-pack', file: 'code.html' }),
    'code.html': '<p>hi</p>',
    'extra.css': 'body{color:red}',
  }), /unexpected file/);
  // The declared code file is missing.
  await refuse(makeZip({
    'plugin.json': JSON.stringify({ name: 'Ghost Pack', hook: 'head', slug: 'ghost-pack', file: 'missing.html' }),
  }), /not in the zip/);
  // Bad hook.
  await refuse(makeZip({
    'plugin.json': JSON.stringify({ name: 'Bad Hook Pack', hook: 'sidebar', slug: 'bad-hook-pack', file: 'code.html' }),
    'code.html': '<p>hi</p>',
  }), /hook/);
  // Name too short.
  await refuse(makeZip({
    'plugin.json': JSON.stringify({ name: 'ab', hook: 'head', slug: 'ab-pack', file: 'code.html' }),
    'code.html': '<p>hi</p>',
  }), /name/);

  const list = (await panel.get(`${panel.admin}/plugins`)).text;
  assert.doesNotMatch(list, /Nope Pack|Too Many Pack|Ghost Pack|Bad Hook Pack|ab-pack/i, 'nothing was installed');
});

/* ==========================================================================
   Robots.txt: editable file, default rendering, sitemap line behaviour.
   ========================================================================== */

test('the default robots file is served and the screen shows it', async () => {
  const origin = new URL(panel.base).origin;
  const res = await panel.anon('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.text, /User-agent: \*/);
  assert.match(res.text, /Allow: \//);
  assert.match(res.text, /Disallow: \/media\/backups\//);
  assert.match(res.text, new RegExp(`Sitemap: ${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the sitemap line is present by default');

  const screen = await panel.get(`${panel.admin}/plugins/robots-txt`);
  assert.equal(screen.status, 200);
  assert.match(screen.text, /robots\.txt content/);
  assert.match(screen.text, new RegExp(`Sitemap: ${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the screen shows the served default');
});

test('the owner edits robots.txt and the saved file is served', async () => {
  const custom = 'User-agent: *\nDisallow: /private/\n';
  await panel.adminPost('/plugins/robots-txt', { robots_txt: custom });

  const res = await panel.anon('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.text, /Disallow: \/private\//, 'the saved file is served');
  assert.match(res.text, /Sitemap: /, 'the sitemap line is appended when the plugin is on');

  // A file with its own Sitemap line is served as saved — never duplicated.
  await panel.adminPost('/plugins/robots-txt', { robots_txt: 'User-agent: *\nDisallow: /private/\nSitemap: https://example.com/own.xml\n' });
  const second = await panel.anon('/robots.txt');
  assert.match(second.text, /Sitemap: https:\/\/example\.com\/own\.xml/);
  assert.equal((second.text.match(/Sitemap:/g) || []).length, 1, 'one sitemap line, not two');

  // Sitemap off: the saved file is served with its sitemap lines dropped.
  await panel.adminPost('/plugins/toggle', { key: 'sitemap' });
  const sitemapOff = await panel.anon('/robots.txt');
  assert.doesNotMatch(sitemapOff.text, /Sitemap:/, 'no sitemap line when the sitemap plugin is off');
  assert.match(sitemapOff.text, /Disallow: \/private\//, 'the saved file still renders');
  await panel.adminPost('/plugins/toggle', { key: 'sitemap' }); // back on
});

test('robots stays 404 while the built-in is off, even with a custom file saved', async () => {
  await panel.adminPost('/plugins/toggle', { key: 'robots' }); // off
  assert.equal((await panel.anon('/robots.txt')).status, 404);
  await panel.adminPost('/plugins/toggle', { key: 'robots' }); // back on
  assert.equal((await panel.anon('/robots.txt')).status, 200);
});

test('reset to default reverts the file, and an empty box does the same', async () => {
  await panel.adminPost('/plugins/robots-txt', { robots_txt: 'User-agent: *\nDisallow: /private/\n' });
  const set = await panel.anon('/robots.txt');
  assert.match(set.text, /Disallow: \/private\//);

  await panel.adminPost('/plugins/robots-txt', { reset: '1' });
  const reverted = await panel.anon('/robots.txt');
  assert.doesNotMatch(reverted.text, /Disallow: \/private\//, 'reset restores the generated default');
  assert.match(reverted.text, /Allow: \//);

  await panel.adminPost('/plugins/robots-txt', { robots_txt: '   ' });
  const blank = await panel.anon('/robots.txt');
  assert.doesNotMatch(blank.text, /Disallow: \/private\//, 'an empty box also restores the default');
  assert.match(blank.text, /Allow: \//);
});
