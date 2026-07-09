#!/usr/bin/env node

/**
 * rru-kaltura-youtube-crawler-batch.js
 *
 * Batch Moodle media crawler/downloader for RRU courses.
 *
 * Key design rule:
 *   The main Moodle page is ONLY used for Moodle course/activity pages.
 *   Kaltura/API/media resolution uses APIRequestContext or a temporary resolver page.
 *
 * Install:
 *   npm init -y
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Run:
 *   RRU_USERNAME='dclouston' RRU_PASSWORD='your-password-here' node rru-kaltura-youtube-crawler-batch.js RRU_course_list.csv --output "/path/to/output"
 *
 * CSV:
 *   Can contain a header with url/course/name columns, or simply one Moodle URL per row.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, request } = require('playwright');

const CONFIG = {
  username: process.env.RRU_USERNAME || '',
  password: process.env.RRU_PASSWORD || '',

  headless: true,

  moodleHost: 'csonline.royalroads.ca',
  mediaHost: 'media.royalroads.ca',
  youtubeHosts: [
    'www.youtube.com',
    'youtube.com',
    'youtu.be',
    'www.youtube-nocookie.com',
    'youtube-nocookie.com',
  ],
  kalturaHosts: [
    'kaf.moodle.royalroads.ca',
    'api.ca.kaltura.com',
    'api.cap2.ovp.kaltura.com',
    'cfvod.cap2.ovp.kaltura.com',
    'cdnapisec.kaltura.com',
    'cdnapi.kaltura.com',
    'cdnsecakmi.kaltura.com',
    'cdnakmi.kaltura.com',
  ],

  allowedDownloadHosts: [
    'csonline.royalroads.ca',
    'media.royalroads.ca',
    'api.ca.kaltura.com',
    'api.cap2.ovp.kaltura.com',
    'cfvod.cap2.ovp.kaltura.com',
    'cdnapisec.kaltura.com',
    'cdnapi.kaltura.com',
    'cdnsecakmi.kaltura.com',
    'cdnakmi.kaltura.com',
  ],

  ignoredExtensions: new Set([
    '.html', '.htm', '.php', '.svg', '.css', '.js', '.map', '.json',
    '.woff', '.woff2', '.ttf', '.eot', '.ico',
  ]),

  mediaExtensions: new Set([
    '.mp4', '.mov', '.m4v', '.webm', '.avi', '.wmv', '.mp3', '.m4a', '.wav',
    '.aac', '.ogg', '.oga', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf',
    '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.zip',
  ]),

  // Do not save HLS manifests as final media files.
  manifestExtensions: new Set(['.m3u8', '.mpd']),

  authStatePath: path.resolve(process.cwd(), 'rru-auth-state.json'),

  navigationTimeoutMs: 60000,
  downloadTimeoutMs: 120000,
  delayBetweenActivitiesMs: 250,

  maxActivityLinks: 2000,
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    input: '',
    output: path.resolve(process.cwd(), 'output'),
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (a === '--output' || a === '-o') {
      out.output = path.resolve(args[++i]);
    } else if (a === '--headed') {
      CONFIG.headless = false;
    } else if (a === '--headless') {
      CONFIG.headless = true;
    } else if (!out.input) {
      out.input = a;
    }
  }

  if (!out.input) {
    console.error('Usage: node rru-kaltura-youtube-crawler-batch.js <course-url-or-csv> --output "/path/to/output"');
    process.exit(1);
  }

  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function sanitizeName(name, fallback = 'untitled') {
  let s = String(name || '').trim();
  s = decodeHtmlEntities(s);
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/[\/\\:*?"<>|]/g, ' - ');
  s = s.replace(/\s+-\s+/g, ' - ');
  s = s.replace(/[. ]+$/g, '');
  s = s.slice(0, 140).trim();
  return s || fallback;
}

function folderNameFromTitle(index, title, url) {
  const n = String(index).padStart(3, '0');
  const clean = sanitizeName(title || activityIdFromUrl(url) || 'Activity');
  return `${n} ${clean}`;
}

function courseFolderName(name, url) {
  const cleanName = sanitizeName(name || 'Course');
  const id = getUrlParam(url, 'id');
  if (id && !cleanName.includes(`id=${id}`)) return `${cleanName} (id=${id})`;
  return cleanName;
}

function hashShort(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

function tryUrl(u, base) {
  try {
    return new URL(decodeHtmlEntities(u), base).toString();
  } catch {
    return null;
  }
}

function getHostname(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getExtFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    return path.extname(p).toLowerCase();
  } catch {
    return '';
  }
}

function getUrlParam(u, key) {
  try {
    return new URL(u).searchParams.get(key);
  } catch {
    return '';
  }
}

function activityIdFromUrl(u) {
  const id = getUrlParam(u, 'id');
  if (id) return `id=${id}`;
  try {
    const url = new URL(u);
    return sanitizeName(url.pathname.split('/').filter(Boolean).slice(-2).join(' '));
  } catch {
    return '';
  }
}

function canonicalActivityUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';

    const id = url.searchParams.get('id');
    const pathname = url.pathname;

    if (id && /\/mod\/[^/]+\/view\.php$/.test(pathname)) {
      const keep = new URLSearchParams();
      keep.set('id', id);

      // Lessons and books can expose multiple real content pages under the same
      // activity id. Preserve these keys so they are not deduped away.
      if (/\/mod\/lesson\/view\.php$/.test(pathname) && url.searchParams.has('pageid')) {
        keep.set('pageid', url.searchParams.get('pageid'));
      }

      if (/\/mod\/book\/view\.php$/.test(pathname) && url.searchParams.has('chapterid')) {
        keep.set('chapterid', url.searchParams.get('chapterid'));
      }

      return `${url.origin}${pathname}?${keep.toString()}`;
    }

    if (id && /\/course\/view\.php$/.test(pathname)) {
      return `${url.origin}${pathname}?id=${id}`;
    }

    return url.toString();
  } catch {
    return u;
  }
}

function isAllowedDownloadUrl(u) {
  const host = getHostname(u);
  return CONFIG.allowedDownloadHosts.includes(host);
}

function shouldIgnoreUrl(u) {
  const ext = getExtFromUrl(u);
  if (CONFIG.ignoredExtensions.has(ext)) return true;
  if (CONFIG.manifestExtensions.has(ext)) return true;

  const lower = u.toLowerCase();

  if (lower.includes('/comment/')) return true;
  if (lower.includes('downloadall')) return true;
  if (lower.includes('/grade/')) return true;
  if (lower.includes('/report/')) return true;
  if (lower.includes('/backup/')) return true;
  if (lower.includes('/restore')) return true;
  if (lower.includes('/filter/manage')) return true;
  if (lower.includes('/admin/roles/')) return true;
  if (lower.includes('/login/logout')) return true;

  return false;
}

function looksLikeDirectMedia(u) {
  const ext = getExtFromUrl(u);
  if (CONFIG.mediaExtensions.has(ext)) return true;

  const lower = u.toLowerCase();
  return (
    lower.includes('/draftfile.php/') ||
    lower.includes('/pluginfile.php/') ||
    lower.includes('/webservice/pluginfile.php/') ||
    lower.includes('/playmanifest/')
  );
}

function filenameFromUrl(u, contentDisposition = '') {
  const cdMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i);
  if (cdMatch) {
    const raw = cdMatch[1] || cdMatch[2];
    try {
      return sanitizeName(decodeURIComponent(raw));
    } catch {
      return sanitizeName(raw);
    }
  }

  try {
    const url = new URL(u);
    let base = decodeURIComponent(url.pathname.split('/').pop() || '');
    base = base.split('?')[0];

    if (!base || !path.extname(base)) {
      const entryId = url.pathname.match(/entryId\/([^/]+)/i)?.[1] || url.searchParams.get('entry_id');
      const flavorId = url.pathname.match(/flavorId\/([^/]+)/i)?.[1];
      if (entryId && flavorId) base = `${entryId}_${flavorId}.mp4`;
      else if (entryId) base = `${entryId}.mp4`;
      else base = `download_${hashShort(u)}`;
    }

    return sanitizeName(base);
  } catch {
    return `download_${hashShort(u)}`;
  }
}

function uniqueFilePath(dir, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let i = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${i}${parsed.ext}`);
    i += 1;
  }

  return candidate;
}

function parseCsvOrSingleInput(input) {
  if (/^https?:\/\//i.test(input)) {
    return [{ url: input, name: '' }];
  }

  const raw = fs.readFileSync(input, 'utf8');
  const rows = parseSimpleCsv(raw);

  if (!rows.length) return [];

  const header = rows[0].map(x => x.trim().toLowerCase());
  const hasHeader = header.some(h => ['url', 'course', 'course_url', 'course url', 'link', 'name', 'title'].includes(h));

  const start = hasHeader ? 1 : 0;
  const urlIdx = hasHeader
    ? Math.max(header.indexOf('url'), header.indexOf('course_url'), header.indexOf('course url'), header.indexOf('link'))
    : 0;

  const nameIdx = hasHeader
    ? Math.max(header.indexOf('name'), header.indexOf('title'), header.indexOf('course'))
    : -1;

  const courses = [];

  for (let i = start; i < rows.length; i += 1) {
    const row = rows[i];
    const url = (row[urlIdx] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;

    courses.push({
      url,
      name: nameIdx >= 0 ? (row[nameIdx] || '').trim() : '',
    });
  }

  return courses;
}

function parseSimpleCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch !== '\r') {
        cell += ch;
      }
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

class LogWriter {
  constructor(filePath) {
    this.filePath = filePath;
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, 'course,activity_folder,activity_url,type,status,url,file,error\n');
    }
  }

  write(row) {
    const cols = [
      row.course || '',
      row.activityFolder || '',
      row.activityUrl || '',
      row.type || '',
      row.status || '',
      row.url || '',
      row.file || '',
      row.error || '',
    ];

    fs.appendFileSync(this.filePath, cols.map(csvEscape).join(',') + '\n');
  }
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function safeGoto(page, url, options = {}) {
  const opts = {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navigationTimeoutMs,
    ...options,
  };

  try {
    return await page.goto(url, opts);
  } catch (err) {
    console.log(`Navigation warning for ${url}: ${err.message}`);
    return null;
  }
}

async function pageNeedsLogin(page) {
  const url = page.url();

  if (/\/login\/|login|signin|sign-in|saml|cas|auth|adfs/i.test(url)) {
    return true;
  }

  const passwordFields = await page.locator('input[type="password"]').count().catch(() => 0);
  if (passwordFields > 0) return true;

  const loginButtons = await page
    .locator('button:has-text("Log in"), button:has-text("Login"), input[value*="Log in" i], input[value*="Login" i], #loginbtn')
    .count()
    .catch(() => 0);

  return loginButtons > 0;
}

async function autoLoginIfNeeded(page, targetUrl = '') {
  if (!CONFIG.username || !CONFIG.password) {
    console.log('No RRU_USERNAME/RRU_PASSWORD found. Manual login would be required.');
    return false;
  }

  async function isLoggedInOrCourseVisible() {
    const currentUrl = page.url();

    if (
      currentUrl.includes('/moodle/course/view.php') ||
      currentUrl.includes('/moodle/mod/')
    ) {
      const hasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0);
      if (hasPasswordField === 0) return true;
    }

    const logoutCount = await page
      .locator('a[href*="logout"], a:has-text("Log out"), a:has-text("Logout")')
      .count()
      .catch(() => 0);

    return logoutCount > 0;
  }

  async function fillFirstVisible(selectors, value, label) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        if (!(await loc.count())) continue;

        await loc.waitFor({ state: 'visible', timeout: 5000 });
        await loc.click({ timeout: 5000 });
        await loc.fill(value, { timeout: 5000 });

        console.log(`Filled ${label} using selector: ${selector}`);
        return loc;
      } catch {}
    }

    return null;
  }

  async function clickFirstVisible(selectors, label) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();
        if (!(await loc.count())) continue;

        await loc.waitFor({ state: 'visible', timeout: 5000 });

        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
          loc.click({ timeout: 8000 }),
        ]);

        console.log(`Clicked ${label} using selector: ${selector}`);
        return true;
      } catch {}
    }

    return false;
  }

  if (await isLoggedInOrCourseVisible()) {
    return true;
  }

  if (!(await pageNeedsLogin(page))) {
    return false;
  }

  console.log('Login page detected. Attempting automatic login...');
  console.log(`Current login URL: ${page.url()}`);

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);

  const usernameLocator = await fillFirstVisible([
    'input[name="username"]',
    'input#username',
    'input[name="user"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[type="text"]',
  ], CONFIG.username, 'username');

  const passwordLocator = await fillFirstVisible([
    'input[name="password"]',
    'input#password',
    'input[name="pass"]',
    'input[id*="pass" i]',
    'input[type="password"]',
  ], CONFIG.password, 'password');

  if (!usernameLocator || !passwordLocator) {
    console.log('Automatic login failed because username/password fields were not found.');
    return false;
  }

  const clicked = await clickFirstVisible([
    'button[type="submit"]',
    'input[type="submit"]',
    '#loginbtn',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'input[value*="Log in" i]',
    'input[value*="Login" i]',
  ], 'login submit button');

  if (!clicked) {
    console.log('No login button found. Pressing Enter in password field.');
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
      passwordLocator.press('Enter').catch(() => page.keyboard.press('Enter')),
    ]);
  }

  await page.waitForTimeout(3000);

  if (targetUrl && !page.url().includes('/moodle/course/view.php') && !page.url().includes('/moodle/mod/')) {
    console.log('Returning to requested Moodle URL after login...');
    await safeGoto(page, targetUrl);
    await page.waitForTimeout(1500);
  }

  const ok = await isLoggedInOrCourseVisible();

  if (ok) {
    await page.context().storageState({ path: CONFIG.authStatePath }).catch(() => {});
    console.log('Automatic login appears successful.');
    return true;
  }

  console.log(`Automatic login may not have completed. Current URL: ${page.url()}`);
  return false;
}

async function ensureLoggedInForUrl(page, targetUrl) {
  if (!(await pageNeedsLogin(page))) return true;

  console.log(`Login required while processing: ${targetUrl}`);
  const ok = await autoLoginIfNeeded(page, targetUrl);

  if (!ok) {
    console.log(`Login retry failed for: ${targetUrl}`);
    return false;
  }

  if (canonicalActivityUrl(page.url()) !== canonicalActivityUrl(targetUrl)) {
    await safeGoto(page, targetUrl);
    await page.waitForTimeout(1000);
  }

  if (await pageNeedsLogin(page)) {
    console.log(`Still on login page after retry: ${targetUrl}`);
    return false;
  }

  return true;
}

async function getCourseTitle(page, fallbackUrl) {
  const candidates = [
    'h1',
    '.page-header-headings h1',
    '.coursename',
    'title',
  ];

  for (const sel of candidates) {
    try {
      if (sel === 'title') {
        const title = await page.title();
        if (title) return sanitizeName(title.replace(/\s*\|\s*RRU Moodle.*$/i, ''));
      }

      const txt = await page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => '');
      if (txt) return sanitizeName(txt);
    } catch {}
  }

  const id = getUrlParam(fallbackUrl, 'id');
  return id ? `Course (id=${id})` : 'Course';
}

async function expandCourseIndex(page) {
  await page.waitForTimeout(1000);

  const selectors = [
    '[data-action="expandallcourseindexsections"]',
    'a:has-text("Expand all")',
    'button:has-text("Expand all")',
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch {}
  }
}

async function collectActivityLinks(page, courseUrl) {
  await expandCourseIndex(page);

  const base = courseUrl;

  const links = await page.evaluate(() => {
    const out = [];

    function visibleText(el) {
      return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    function add(href, text, reason) {
      if (!href) return;
      const abs = absoluteUrl(href);
      if (!abs) return;
      out.push({
        href: abs,
        text: String(text || reason || '').replace(/\s+/g, ' ').trim(),
      });
    }

    document.querySelectorAll('a[href]').forEach(a => {
      add(a.getAttribute('href'), visibleText(a), 'link');
    });

    // Moodle lessons/books often expose child pages through Jump to... menus or
    // previous/next links after the parent activity has opened.
    document.querySelectorAll('select.urlselect option[value], #jump-to-activity option[value], option[value]').forEach(opt => {
      const v = opt.getAttribute('value');
      if (v) add(v, visibleText(opt), 'option');
    });

    // Moodle lessons frequently expose branch/answer navigation through forms
    // instead of plain links. Preserve hidden id/pageid fields from those forms.
    document.querySelectorAll('form').forEach(form => {
      const action = form.getAttribute('action') || location.href;
      const label =
        visibleText(form) ||
        form.getAttribute('aria-label') ||
        form.getAttribute('title') ||
        'lesson form';

      try {
        const url = new URL(action, location.href);

        form.querySelectorAll('input[name], button[name], select[name], textarea[name]').forEach(input => {
          const name = input.getAttribute('name');
          if (!name) return;

          let value = input.getAttribute('value') || '';

          if (!value && input.tagName === 'SELECT') {
            value =
              input.querySelector('option[selected]')?.getAttribute('value') ||
              input.querySelector('option')?.getAttribute('value') ||
              '';
          }

          if (!value) return;

          const lowerName = name.toLowerCase();
          if (['id', 'pageid', 'chapterid', 'courseid'].includes(lowerName)) {
            url.searchParams.set(name, value);
          }
        });

        if (
          url.pathname.includes('/mod/lesson/view.php') ||
          url.pathname.includes('/mod/book/view.php') ||
          url.pathname.includes('/mod/page/view.php')
        ) {
          add(url.href, label, 'form');
        }
      } catch {}
    });

    // Moodle themes/plugins sometimes store navigation URLs in data attributes.
    document.querySelectorAll('[data-url], [data-href], [data-link], [data-target]').forEach(el => {
      for (const attr of ['data-url', 'data-href', 'data-link', 'data-target']) {
        const v = el.getAttribute(attr);
        if (v && /\/mod\/(lesson|book|page)\//i.test(v)) {
          add(v, visibleText(el), attr);
        }
      }
    });

    // Some previous/next lesson buttons use onclick JavaScript.
    document.querySelectorAll('[onclick]').forEach(el => {
      const onclick = el.getAttribute('onclick') || '';
      const matches = [
        ...onclick.matchAll(/https?:\/\/[^'" <>)]+/gi),
        ...onclick.matchAll(/['"]([^'"]*\/mod\/(?:lesson|book|page)\/view\.php[^'"]*)['"]/gi),
      ];

      for (const m of matches) {
        add(m[1] || m[0], visibleText(el), 'onclick');
      }
    });

    // Last-resort scrape. Lesson pageid links can appear in escaped HTML/scripts.
    const html = document.documentElement.innerHTML || '';
    const embeddedMatches = [
      ...html.matchAll(/https?:\\?\/\\?\/[^'" <>)\\]+\/moodle\/mod\/(?:lesson|book)\/view\.php[^'" <>)\\]+/gi),
      ...html.matchAll(/\/moodle\/mod\/(?:lesson|book)\/view\.php\?[^'" <>)\\]+/gi),
    ];

    for (const m of embeddedMatches) {
      const raw = String(m[0] || '')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/&#038;/g, '&');
      add(raw, 'embedded lesson/book link', 'html');
    }

    return out.filter(item => item.href);
  });

  const seen = new Set();
  const activities = [];

  for (const item of links) {
    const abs = tryUrl(item.href, base);
    if (!abs) continue;

    const url = new URL(abs);

    if (url.hostname !== CONFIG.moodleHost) continue;
    if (!url.pathname.includes('/moodle/mod/')) continue;
    if (!url.pathname.endsWith('/view.php')) continue;

    const lower = abs.toLowerCase();
    const action = (url.searchParams.get('action') || '').toLowerCase();
    if (['grading', 'grader', 'downloadall', 'download', 'editsubmission', 'viewpluginpage'].includes(action)) continue;
    if (url.searchParams.has('sesskey')) continue;
    if (lower.includes('/mod/forum/discuss.php')) continue;
    if (lower.includes('/mod/assign/view.php') && lower.includes('action=grading')) continue;

    const canonical = canonicalActivityUrl(abs);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    activities.push({
      url: canonical,
      title: sanitizeName(item.text || activityIdFromUrl(canonical) || 'Activity'),
    });

    if (activities.length >= CONFIG.maxActivityLinks) break;
  }

  return activities;
}

async function getPagePath(page) {
  return page.evaluate(() => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function addUnique(parts, value) {
      const text = cleanText(value);
      if (!text) return;
      if (/^(dashboard|my courses|site home|courses)$/i.test(text)) return;
      if (!parts.includes(text)) parts.push(text);
    }

    const parts = [];

    document.querySelectorAll(
      '.breadcrumb li, nav.breadcrumb li, ol.breadcrumb li, [aria-label="breadcrumb"] li, .breadcrumb-item'
    ).forEach(item => addUnique(parts, item.textContent));

    const title =
      cleanText(document.querySelector('.activity-header h1')?.textContent) ||
      cleanText(document.querySelector('.page-header-headings h1')?.textContent) ||
      cleanText(document.querySelector('h1')?.textContent) ||
      cleanText(document.title) ||
      cleanText(location.href);

    if (title) addUnique(parts, title);

    const isLesson =
      document.body?.classList?.contains('path-mod-lesson') ||
      location.href.includes('/mod/lesson/view.php');

    const isBook =
      document.body?.classList?.contains('path-mod-book') ||
      location.href.includes('/mod/book/view.php');

    if (isLesson) {
      const selectors = [
        '.lesson-content h1',
        '.lesson-content h2',
        '.lesson-content h3',
        '.contents h1',
        '.contents h2',
        '.contents h3',
        '.box.contents h1',
        '.box.contents h2',
        '.box.contents h3',
        '#region-main .contents h1',
        '#region-main .contents h2',
        '#region-main .contents h3',
        '#region-main .box h1',
        '#region-main .box h2',
        '#region-main .box h3',
        '#region-main h2',
        '#region-main h3',
        '.lessonpagetitle',
        '.lesson-page-title',
        '.mod_lesson-title',
      ];

      for (const selector of selectors) {
        const text = cleanText(document.querySelector(selector)?.textContent);
        if (!text) continue;
        if (text === title) continue;
        if (/^(previous|next|continue|contents|question|response|yes|no|submit|navigation|untitled)$/i.test(text)) continue;
        addUnique(parts, text);
        break;
      }
    }

    if (isBook) {
      const selectors = [
        '.book_content h1',
        '.book_content h2',
        '.book_content h3',
        '.book_chapter_title',
        '.chapter h1',
        '.chapter h2',
        '.chapter h3',
        '#region-main .book_content h1',
        '#region-main .book_content h2',
        '#region-main .book_content h3',
        '#region-main h2',
        '#region-main h3',
      ];

      for (const selector of selectors) {
        const text = cleanText(document.querySelector(selector)?.textContent);
        if (!text) continue;
        if (text === title) continue;
        if (/^(previous|next|continue|contents|question|response|yes|no|submit|navigation|untitled)$/i.test(text)) continue;
        addUnique(parts, text);
        break;
      }
    }

    return parts.join(' / ');
  });
}

function badActivityTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  return /^(previous|next|continue|contents|question|response|yes|no|submit|navigation|untitled)$/i.test(clean);
}

function bestTitleFromPagePath(pagePath, fallback = 'Activity') {
  const parts = String(pagePath || '')
    .split('/')
    .map(part => sanitizeName(part))
    .filter(part => part && !badActivityTitle(part));

  if (parts.length) return parts[parts.length - 1];

  const cleanFallback = sanitizeName(fallback || 'Activity');
  return badActivityTitle(cleanFallback) ? 'Activity' : cleanFallback;
}

async function getPageTitle(page, fallback) {
  const pageUrl = page.url();
  const isLessonOrBook = /\/mod\/(lesson|book)\/view\.php/i.test(pageUrl);

  if (isLessonOrBook) {
    try {
      const pagePath = await getPagePath(page);
      const title = bestTitleFromPagePath(pagePath, fallback);
      if (title && title !== 'Activity') return title;
    } catch {}
  }

  const selectors = [
    '.activity-header h1',
    '.page-header-headings h1',
    'h1.h2',
    'h1',
    'h2',
  ];

  for (const sel of selectors) {
    try {
      const txt = await page.locator(sel).first().innerText({ timeout: 2500 }).catch(() => '');
      const clean = sanitizeName(txt);
      if (clean && !badActivityTitle(clean)) return clean;
    } catch {}
  }

  if (isLessonOrBook) {
    try {
      return bestTitleFromPagePath(await getPagePath(page), fallback);
    } catch {}
  }

  try {
    const title = await page.title();
    const clean = sanitizeName(title.replace(/\s*\|\s*RRU Moodle.*$/i, ''));
    if (clean && !badActivityTitle(clean)) return clean;
  } catch {}

  const cleanFallback = sanitizeName(fallback || 'Activity');
  return badActivityTitle(cleanFallback) ? 'Activity' : cleanFallback;
}



async function collectDirectMediaFromDom(page, activityUrl) {
  const items = await page.evaluate(() => {
    const urls = [];

    function add(u, reason) {
      if (!u) return;
      urls.push({ url: u, reason });
    }

    document.querySelectorAll('img[src]').forEach(el => add(el.src, 'img'));
    document.querySelectorAll('source[src]').forEach(el => add(el.src, 'source'));
    document.querySelectorAll('video[src]').forEach(el => add(el.src, 'video'));
    document.querySelectorAll('audio[src]').forEach(el => add(el.src, 'audio'));
    document.querySelectorAll('a[href]').forEach(el => add(el.href, 'link'));
    document.querySelectorAll('[style]').forEach(el => {
      const style = el.getAttribute('style') || '';
      const matches = [...style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)];
      for (const m of matches) add(m[1], 'css-url');
    });

    return urls;
  });

  const out = [];
  const seen = new Set();

  for (const item of items) {
    const abs = tryUrl(item.url, activityUrl);
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    if (!isAllowedDownloadUrl(abs)) continue;
    if (shouldIgnoreUrl(abs)) continue;

    if (looksLikeDirectMedia(abs)) {
      out.push({ url: abs, reason: item.reason });
    }
  }

  return out;
}

async function collectIframes(page) {
  const frames = await page.evaluate(() => {
    return [...document.querySelectorAll('iframe[src]')].map((iframe, index) => ({
      index,
      src: iframe.src,
      id: iframe.id || '',
      title: iframe.title || '',
      width: iframe.getAttribute('width') || '',
      height: iframe.getAttribute('height') || '',
    }));
  });

  return frames;
}


function youtubeWatchUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

function isYoutubeUrl(u) {
  const host = getHostname(u);
  if (CONFIG.youtubeHosts.includes(host)) return true;
  return /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|^youtu\.be$/i.test(host);
}

function extractYoutubeFromText(text) {
  if (!text) return '';

  const decoded = decodeHtmlEntities(String(text)).replace(/\\\//g, '/');

  const patterns = [
    /https?:\/\/www\.youtube\.com\/watch\?[^"'<>\s]*[?&]v=([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtube\.com\/watch\?[^"'<>\s]*[?&]v=([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/www\.youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/www\.youtube-nocookie\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtube-nocookie\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /[?&]v=([a-zA-Z0-9_-]{11})/i,
    /\/embed\/([a-zA-Z0-9_-]{11})/i,
    /"referenceId"\s*:\s*"([a-zA-Z0-9_-]{11})"/i,
    /referenceId['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{11})['"]/i,
    /videoId['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{11})['"]/i,
    /loadVideoById\(['"]([a-zA-Z0-9_-]{11})['"]\)/i,
    /cueVideoById\(['"]([a-zA-Z0-9_-]{11})['"]\)/i,
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match && match[1]) return youtubeWatchUrl(match[1]);
  }

  return '';
}

async function tryExtractYoutubeByFetching(context, iframeUrl) {
  try {
    const response = await context.request.get(iframeUrl, {
      timeout: 30000,
      maxRedirects: 5,
    });

    if (!response.ok()) return '';

    const body = await response.text();
    return extractYoutubeFromText(`${iframeUrl}\n${body}`);
  } catch {
    return '';
  }
}

async function tryExtractYoutubeByOpeningFrame(context, iframeUrl) {
  const probePage = await context.newPage();
  probePage.setDefaultTimeout(5000);
  probePage.setDefaultNavigationTimeout(45000);

  let youtubeUrl = extractYoutubeFromText(iframeUrl);

  const inspectText = value => {
    const found = extractYoutubeFromText(value);
    if (found && !youtubeUrl) youtubeUrl = found;
  };

  probePage.on('request', request => inspectText(request.url()));
  probePage.on('response', response => inspectText(response.url()));
  probePage.on('console', message => inspectText(message.text()));

  try {
    await probePage.addInitScript(() => {
      window.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;

        try {
          const data = JSON.parse(event.data);
          if (data.event !== 'command' || !data.args || !data.args[0]) return;

          const videoId = typeof data.args[0] === 'string'
            ? data.args[0]
            : data.args[0].videoId;

          if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            console.log(`[RR_YOUTUBE_ID] ${videoId}`);
          }
        } catch {}
      }, true);
    });

    await probePage.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await probePage.waitForTimeout(1500);

    inspectText(await probePage.content());

    for (const selector of [
      'button[aria-label*="Play" i]',
      '.playkit-control-play-pause',
      '.playkit-player button',
      'button',
      '[role="button"]',
      '.largePlayBtn',
      '.playButton',
    ]) {
      if (youtubeUrl) break;

      try {
        const loc = probePage.locator(selector).first();
        if (await loc.count()) {
          await loc.click({ timeout: 1500, force: true });
          await probePage.waitForTimeout(1500);
        }
      } catch {}
    }

    for (const frame of probePage.frames()) {
      inspectText(frame.url());

      try {
        inspectText(await frame.content());
      } catch {}
    }

    await probePage.waitForTimeout(1500);
  } catch {
  } finally {
    await probePage.close().catch(() => {});
  }

  return youtubeUrl || '';
}

async function resolveYoutubeForIframe(context, iframeUrl) {
  if (!iframeUrl) return '';

  const fromUrl = extractYoutubeFromText(iframeUrl);
  if (fromUrl) return fromUrl;

  let youtubeUrl = await tryExtractYoutubeByFetching(context, iframeUrl);
  if (youtubeUrl) return youtubeUrl;

  youtubeUrl = await tryExtractYoutubeByOpeningFrame(context, iframeUrl);
  return youtubeUrl || '';
}

function extractKalturaEntryIdsFromText(text) {
  const ids = new Set();

  const patterns = [
    /entry_id=([0-9a-z_]+)/gi,
    /entryId\/([0-9a-z_]+)/gi,
    /entryid\/([0-9a-z_]+)/gi,
    /entryId["']?\s*:\s*["']([0-9a-z_]+)["']/gi,
    /entry_id["']?\s*:\s*["']([0-9a-z_]+)["']/gi,
    /kentryid=["']([0-9a-z_]+)["']/gi,
    /loadMedia\(\s*\{\s*entryId\s*:\s*["']([0-9a-z_]+)["']/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) ids.add(m[1]);
  }

  return [...ids];
}

function extractUiConfIdFromText(text) {
  const patterns = [
    /uiconf_id[=/]([0-9]+)/i,
    /uiConfId["']?\s*:\s*["']?([0-9]+)/i,
    /kuiconfid=["']([0-9]+)["']/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }

  return '';
}

function extractPartnerIdFromText(text) {
  const patterns = [
    /partner_id[=/]([0-9]+)/i,
    /partnerId["']?\s*:\s*["']?([0-9]+)/i,
    /\/p\/([0-9]+)\//i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }

  return '143';
}

function extractJsonObjectAfter(text, marker) {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  const start = text.indexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let esc = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function tryParseJsonish(s) {
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {}

  try {
    const normalized = s
      .replace(/\\\//g, '/')
      .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');

    return JSON.parse(normalized);
  } catch {}

  return null;
}

function buildKalturaFlavorUrl({ partnerId, entryId, flavorId, format = 'url' }) {
  return `https://api.cap2.ovp.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/flavorId/${flavorId}/format/${format}/protocol/https/a.mp4`;
}

function buildKalturaDownloadManifestUrl({ partnerId, entryId }) {
  return `https://api.cap2.ovp.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/flavorParamIds/0`;
}

async function fetchTextWithCookies(context, url) {
  try {
    const resp = await context.request.get(url, {
      timeout: CONFIG.downloadTimeoutMs,
      maxRedirects: 5,
    });

    if (!resp.ok()) {
      return {
        ok: false,
        status: resp.status(),
        url,
        text: '',
        headers: resp.headers(),
      };
    }

    return {
      ok: true,
      status: resp.status(),
      url: resp.url(),
      text: await resp.text(),
      headers: resp.headers(),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      url,
      text: '',
      headers: {},
      error: err.message,
    };
  }
}

async function resolveKalturaFromIframe(context, iframeUrl) {
  const resolved = [];

  const htmlResp = await fetchTextWithCookies(context, iframeUrl);
  const html = htmlResp.text || '';

  const allText = `${iframeUrl}\n${html}`;
  const entryIds = extractKalturaEntryIdsFromText(allText);
  const partnerId = extractPartnerIdFromText(allText);
  const uiConfId = extractUiConfIdFromText(allText);

  const packageJson = extractJsonObjectAfter(html, 'window.kalturaIframePackageData');
  const packageData = tryParseJsonish(packageJson);

  if (packageData?.entryResult?.meta) {
    const meta = packageData.entryResult.meta;
    const contextData = packageData.entryResult.contextData || {};
    const entryId = meta.id || packageData.playerConfig?.entryId || entryIds[0];
    const name = meta.name || entryId || 'Kaltura video';

    if (meta.downloadUrl) {
      resolved.push({
        type: 'kaltura-downloadUrl',
        url: meta.downloadUrl.replace(/\\\//g, '/'),
        filenameHint: `${sanitizeName(name)}.${meta.fileExt || 'mp4'}`,
      });
    }

    const flavors = Array.isArray(contextData.flavorAssets) ? contextData.flavorAssets : [];
    const source = flavors.find(f => String(f.tags || '').includes('source') && f.id) ||
      flavors.sort((a, b) => Number(b.sizeInBytes || b.size || 0) - Number(a.sizeInBytes || a.size || 0))[0];

    if (entryId && source?.id) {
      resolved.push({
        type: 'kaltura-flavor-source',
        url: buildKalturaFlavorUrl({
          partnerId: String(meta.partnerId || partnerId || '143'),
          entryId,
          flavorId: source.id,
          format: 'url',
        }),
        filenameHint: `${sanitizeName(name)}.${source.fileExt || 'mp4'}`,
      });
    }

    if (entryId) {
      resolved.push({
        type: 'kaltura-download-manifest',
        url: buildKalturaDownloadManifestUrl({
          partnerId: String(meta.partnerId || partnerId || '143'),
          entryId,
        }),
        filenameHint: `${sanitizeName(name)}.mp4`,
      });
    }
  }

  for (const entryId of entryIds) {
    resolved.push({
      type: 'kaltura-entry-download-manifest',
      url: buildKalturaDownloadManifestUrl({ partnerId, entryId }),
      filenameHint: `${entryId}.mp4`,
    });
  }

  // Last resort: some iframe sources are newer Playkit pages. Use temp page only.
  // The main Moodle page is never touched.
  if (!resolved.length && htmlResp.ok) {
    const directUrls = extractUrlsFromText(html, iframeUrl)
      .filter(u => isAllowedDownloadUrl(u))
      .filter(u => !shouldIgnoreUrl(u))
      .filter(u => looksLikeDirectMedia(u));

    for (const u of directUrls) {
      resolved.push({
        type: 'kaltura-html-url',
        url: u,
        filenameHint: '',
      });
    }
  }

  return dedupeResolved(resolved);
}

function dedupeResolved(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    if (!item.url) continue;
    const key = item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function extractUrlsFromText(text, base) {
  const urls = new Set();

  const patterns = [
    /https?:\\?\/\\?\/[^"' <>)\\]+/gi,
    /["']([^"']*(?:draftfile|pluginfile|playManifest|media\.royalroads\.ca|csonline\.royalroads\.ca)[^"']*)["']/gi,
    /src=["']([^"']+)["']/gi,
    /href=["']([^"']+)["']/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      let raw = m[1] || m[0];
      raw = raw.replace(/\\\//g, '/');
      raw = decodeHtmlEntities(raw);
      const abs = tryUrl(raw, base);
      if (abs) urls.add(abs);
    }
  }

  return [...urls];
}

async function downloadUrl(context, url, dir, log, rowBase, filenameHint = '') {
  if (!url) return false;
  if (!isAllowedDownloadUrl(url)) return false;
  if (shouldIgnoreUrl(url)) return false;

  try {
    const resp = await context.request.get(url, {
      timeout: CONFIG.downloadTimeoutMs,
      maxRedirects: 10,
    });

    const status = resp.status();
    const headers = resp.headers();
    const contentType = headers['content-type'] || '';
    const finalUrl = resp.url();

    if (!resp.ok()) {
      log.write({
        ...rowBase,
        type: 'download',
        status: `failed ${status}`,
        url,
        error: `HTTP ${status}`,
      });
      return false;
    }

    const ext = getExtFromUrl(finalUrl) || getExtFromUrl(url);

    if (CONFIG.manifestExtensions.has(ext)) {
      return false;
    }

    if (contentType.includes('text/html')) {
      return false;
    }

    if (contentType.includes('image/svg')) {
      return false;
    }

    let filename = filenameHint ? sanitizeName(filenameHint) : filenameFromUrl(finalUrl, headers['content-disposition'] || '');

    if (!path.extname(filename)) {
      const guessed = guessExtFromContentType(contentType);
      if (guessed) filename += guessed;
    }

    const filePath = uniqueFilePath(dir, filename);
    const body = await resp.body();
    fs.writeFileSync(filePath, body);

    log.write({
      ...rowBase,
      type: 'download',
      status: 'downloaded',
      url: finalUrl,
      file: filePath,
    });

    console.log(`      Downloaded: ${path.basename(filePath)}`);
    return true;
  } catch (err) {
    log.write({
      ...rowBase,
      type: 'download',
      status: 'failed',
      url,
      error: err.message,
    });
    return false;
  }
}

function guessExtFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();

  if (ct.includes('video/mp4')) return '.mp4';
  if (ct.includes('quicktime')) return '.mov';
  if (ct.includes('audio/mpeg')) return '.mp3';
  if (ct.includes('audio/mp4')) return '.m4a';
  if (ct.includes('image/jpeg')) return '.jpg';
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/gif')) return '.gif';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('application/pdf')) return '.pdf';
  if (ct.includes('wordprocessingml')) return '.docx';
  if (ct.includes('presentationml')) return '.pptx';
  if (ct.includes('spreadsheetml')) return '.xlsx';
  if (ct.includes('application/zip')) return '.zip';

  return '';
}

async function processActivity(page, activity, index, courseName, courseDir, log) {
  console.log(`\n[${index}] ${activity.url}`);

  await safeGoto(page, activity.url);
  const loggedIn = await ensureLoggedInForUrl(page, activity.url);

  if (!loggedIn) {
    console.log(`  Skipping because login could not be restored.`);
    log.write({
      course: courseName,
      activityFolder: activity.title,
      activityUrl: activity.url,
      type: 'activity',
      status: 'login-failed',
      url: activity.url,
    });
    return;
  }

  await page.waitForTimeout(800);

  const title = await getPageTitle(page, activity.title || activity.url);
  const activityFolder = folderNameFromTitle(index, title, activity.url);
  const activityDir = path.join(courseDir, activityFolder);
  ensureDir(activityDir);

  console.log(`  Page title/folder: ${activityFolder}`);

  const rowBase = {
    course: courseName,
    activityFolder,
    activityUrl: activity.url,
  };

  const directMedia = await collectDirectMediaFromDom(page, activity.url);
  console.log(`  Direct media links found: ${directMedia.length}`);

  for (const media of directMedia) {
    await downloadUrl(page.context(), media.url, activityDir, log, rowBase);
  }

  const iframes = await collectIframes(page);
  console.log(`  Iframes found: ${iframes.length}`);

  for (let i = 0; i < iframes.length; i += 1) {
    const iframe = iframes[i];
    const iframeUrl = tryUrl(iframe.src, activity.url);
    if (!iframeUrl) continue;

    console.log(`    iframe ${i + 1}/${iframes.length}: ${iframeUrl}`);

    const host = getHostname(iframeUrl);
    const isYoutube = isYoutubeUrl(iframeUrl) || !!extractYoutubeFromText(iframeUrl);
    const isKaltura = CONFIG.kalturaHosts.includes(host) || /kaltura|entry_id|entryId|uiconf_id/i.test(iframeUrl);

    if (isYoutube) {
      const youtubeUrl = extractYoutubeFromText(iframeUrl) || iframeUrl;
      console.log(`      YouTube: ${youtubeUrl}`);
      log.write({
        ...rowBase,
        type: 'youtube',
        status: 'resolved',
        url: youtubeUrl,
        file: youtubeUrl,
      });
    } else if (isKaltura) {
      console.log('      Checking for wrapped YouTube/external YouTube first...');
      const youtubeUrl = await resolveYoutubeForIframe(page.context(), iframeUrl);

      if (youtubeUrl) {
        console.log(`      YouTube: ${youtubeUrl}`);
        log.write({
          ...rowBase,
          type: 'youtube',
          status: 'resolved-from-kaltura',
          url: youtubeUrl,
          file: youtubeUrl,
        });
        continue;
      }

      console.log('      No YouTube link found. Trying direct Kaltura API/video download...');
      const resolved = await resolveKalturaFromIframe(page.context(), iframeUrl);
      console.log(`      Kaltura resolved URLs: ${resolved.length}`);

      let downloadedAny = false;

      for (const r of resolved) {
        const ok = await downloadUrl(page.context(), r.url, activityDir, log, rowBase, r.filenameHint);
        downloadedAny = downloadedAny || ok;
        if (ok) break;
      }

      if (!downloadedAny) {
        log.write({
          ...rowBase,
          type: 'kaltura',
          status: 'not-downloaded',
          url: iframeUrl,
          error: 'No direct downloadable Kaltura URL succeeded',
        });
      }
    } else if (isAllowedDownloadUrl(iframeUrl) && !shouldIgnoreUrl(iframeUrl)) {
      await downloadUrl(page.context(), iframeUrl, activityDir, log, rowBase);
    } else {
      console.log(`      skipped non-target iframe: ${iframeUrl}`);
    }
  }
}

async function processCourse(browser, course, outputRoot) {
  console.log(`\n========================================`);
  console.log(`Course: ${course.url}`);
  console.log(`========================================`);

  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
  };

  if (fs.existsSync(CONFIG.authStatePath)) {
    contextOptions.storageState = CONFIG.authStatePath;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(CONFIG.navigationTimeoutMs);

  await safeGoto(page, course.url);

  if (await pageNeedsLogin(page)) {
    await autoLoginIfNeeded(page, course.url);
  }

  await ensureLoggedInForUrl(page, course.url);

  const courseTitle = course.name || await getCourseTitle(page, course.url);
  const courseName = courseFolderName(courseTitle, course.url);
  const courseDir = path.join(outputRoot, courseName);
  ensureDir(courseDir);

  const log = new LogWriter(path.join(courseDir, 'download-log.csv'));

  console.log(`Course folder: ${courseDir}`);

  const activities = await collectActivityLinks(page, course.url);

  console.log(`\nFound ${activities.length} visible course/activity links:`);

  fs.writeFileSync(
    path.join(courseDir, 'activity-list.csv'),
    'number,title,url\n' + activities.map((a, i) => [
      i + 1,
      csvEscape(a.title),
      csvEscape(a.url),
    ].join(',')).join('\n') + '\n'
  );

  const activityQueue = [...activities];
  const queuedActivityUrls = new Set(activityQueue.map(a => canonicalActivityUrl(a.url)));
  const processedActivityUrls = new Set();

  for (let i = 0; i < activityQueue.length; i += 1) {
    const activity = activityQueue[i];
    const canonical = canonicalActivityUrl(activity.url);

    if (processedActivityUrls.has(canonical)) continue;
    processedActivityUrls.add(canonical);

    await processActivity(page, activity, i + 1, courseName, courseDir, log);

    // Lessons/books can reveal additional pageid/chapterid URLs only after the
    // current activity has loaded. Add them to the same queue instead of using
    // the main Moodle page for media resolution.
    const discovered = await collectActivityLinks(page, page.url()).catch(() => []);

    for (const found of discovered) {
      const foundCanonical = canonicalActivityUrl(found.url);
      if (queuedActivityUrls.has(foundCanonical) || processedActivityUrls.has(foundCanonical)) continue;

      queuedActivityUrls.add(foundCanonical);
      activityQueue.push(found);
      console.log(`  Added discovered activity link: ${found.title} | ${found.url}`);
    }

    await sleep(CONFIG.delayBetweenActivitiesMs);
  }

  if (activityQueue.length !== activities.length) {
    fs.writeFileSync(
      path.join(courseDir, 'activity-list-expanded.csv'),
      'number,title,url\n' + activityQueue.map((a, i) => [
        i + 1,
        csvEscape(a.title),
        csvEscape(a.url),
      ].join(',')).join('\n') + '\n'
    );
  }

  await context.storageState({ path: CONFIG.authStatePath }).catch(() => {});
  await context.close();
}

async function main() {
  const args = parseArgs(process.argv);
  const outputRoot = args.output;
  ensureDir(outputRoot);

  const courses = parseCsvOrSingleInput(args.input);

  if (!courses.length) {
    console.error('No course URLs found.');
    process.exit(1);
  }

  console.log(`Output root: ${outputRoot}`);
  console.log(`Courses found: ${courses.length}`);
  console.log(`Headless: ${CONFIG.headless}`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
  });

  try {
    for (const course of courses) {
      await processCourse(browser, course, outputRoot);
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});