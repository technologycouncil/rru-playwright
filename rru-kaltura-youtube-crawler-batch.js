// rru-kaltura-youtube-crawler-batch.js
//
// Install:
//   npm init playwright@latest
//   npm install playwright
//
// Run headless batch:
//   RRU_USERNAME="dclouston" RRU_PASSWORD="your-password" node rru-kaltura-youtube-crawler-batch.js RRU_course_list.csv --output "/path/to/output"
//
// Run visible for debugging:
//   RRU_USERNAME="dclouston" RRU_PASSWORD="your-password" node rru-kaltura-youtube-crawler-batch.js RRU_course_list.csv --headed --output "/path/to/output"
//
// Run one course URL:
//   RRU_USERNAME="dclouston" RRU_PASSWORD="your-password" node rru-kaltura-youtube-crawler-batch.js "https://csonline.royalroads.ca/moodle/course/view.php?id=1956" --output "./output"
//
// Notes:
// - This version checks Kaltura iframes for wrapped YouTube/external YouTube videos FIRST.
// - Only if no YouTube link is found does it try direct Kaltura API/video downloads.
// - Downloads assets that match the Tampermonkey highlighter rules:
//   media.royalroads.ca images and csonline.royalroads.ca iframes.
// - Also checks hyperlinks and downloads files linked from csonline.royalroads.ca
//   or media.royalroads.ca into the corresponding page folder.
// - HLS .m3u8 playlist files are skipped and not saved as successful downloads.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const INPUT = ARGS.find(arg => !arg.startsWith('--'));
const HEADLESS = !ARGS.includes('--headed');

function getArgValue(flagName, fallback = '') {
  const equalsArg = ARGS.find(arg => arg.startsWith(`${flagName}=`));
  if (equalsArg) return equalsArg.slice(flagName.length + 1);

  const flagIndex = ARGS.indexOf(flagName);
  if (flagIndex >= 0 && ARGS[flagIndex + 1] && !ARGS[flagIndex + 1].startsWith('--')) {
    return ARGS[flagIndex + 1];
  }

  return fallback;
}

if (!INPUT) {
  console.error(
    'Usage: node rru-kaltura-youtube-crawler-batch.js <course-url-or-csv-file> [--headed] [--output "/path/to/output"] [--max-pages 2000] [--download-concurrency 4]'
  );
  process.exit(1);
}

const OUTPUT_DIR = getArgValue('--output', path.join(__dirname, 'output'));
const MAX_PAGES_ARG = Number(getArgValue('--max-pages', '2000'));
const DOWNLOAD_CONCURRENCY_ARG = Number(getArgValue('--download-concurrency', '4'));

const CONFIG = {
  userDataDir: path.join(__dirname, 'rru-browser-profile'),
  outputRootDir: path.resolve(OUTPUT_DIR),
  crawlDelayMs: 50,
  maxPages: Number.isFinite(MAX_PAGES_ARG) && MAX_PAGES_ARG > 0 ? MAX_PAGES_ARG : 2000,
  downloadConcurrency: Number.isFinite(DOWNLOAD_CONCURRENCY_ARG) && DOWNLOAD_CONCURRENCY_ARG > 0
    ? Math.floor(DOWNLOAD_CONCURRENCY_ARG)
    : 4,

  allowedHost: 'csonline.royalroads.ca',
  mediaHost: 'media.royalroads.ca',
  kalturaHost: 'kaf.moodle.royalroads.ca',
  kalturaApiHost: 'api.ca.kaltura.com',
  kalturaCap2Host: 'api.cap2.ovp.kaltura.com',

  username: process.env.RRU_USERNAME || '',
  password: process.env.RRU_PASSWORD || '',
};

let results = [];
let seenRecords = new Set();
let resultIndexByKey = new Map();
let seenPageKeys = new Set();
let seenDownloadUrls = new Set();
let activityFolderNumbers = new Map();
let nextActivityFolderNumber = 1;
let lessonSubpageFolderNumbers = new Map();
let bookSubpageFolderNumbers = new Map();
let CURRENT_START_COURSE_ID = '';

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.avi',
  '.wmv',
  '.mkv',
]);

const IGNORABLE_DOWNLOAD_ERRORS = new Set([
  'Already downloaded this URL',
  'Skipped HTML page response',
  'Skipped SVG file',
  'Skipped HLS playlist .m3u8 response',
]);

function resetCourseState(startUrl) {
  results = [];
  seenRecords = new Set();
  resultIndexByKey = new Map();
  seenPageKeys = new Set();
  seenDownloadUrls = new Set();
  activityFolderNumbers = new Map();
  nextActivityFolderNumber = 1;
  lessonSubpageFolderNumbers = new Map();
  bookSubpageFolderNumbers = new Map();
  CURRENT_START_COURSE_ID = getCourseIdFromUrl(startUrl);
}

function readCourseUrls(input) {
  if (/^https?:\/\//i.test(input)) {
    return [input.trim()];
  }

  const filePath = path.resolve(input);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, 'utf8');

  const urls = [...text.matchAll(/https?:\/\/[^\s"',]+/gi)]
    .map(match => match[0].trim())
    .filter(url => url.includes('csonline.royalroads.ca/moodle/course/view.php'));

  return [...new Set(urls)];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeFilenamePart(value, fallback = 'file') {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || fallback;
}

function sanitizeFolderName(value, fallback = 'activity') {
  return sanitizeFilenamePart(value, fallback)
    .replace(/\.+$/g, '')
    .slice(0, 120) || fallback;
}

function ensureUniqueFilePath(filePath) {
  const parsed = path.parse(filePath);
  let candidate = filePath;
  let count = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${count}${parsed.ext}`);
    count += 1;
  }

  return candidate;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '');
  }
}

function getCourseIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get('id') || '';
  } catch {
    return '';
  }
}

function canonicalPageKey(value) {
  try {
    const url = new URL(value);
    url.hash = '';

    const keep = new URLSearchParams();

    if (url.searchParams.has('id')) {
      keep.set('id', url.searchParams.get('id'));
    }

    if (url.pathname.includes('/mod/lesson/view.php') && url.searchParams.has('pageid')) {
      keep.set('pageid', url.searchParams.get('pageid'));
    }

    if (url.pathname.includes('/mod/book/view.php') && url.searchParams.has('chapterid')) {
      keep.set('chapterid', url.searchParams.get('chapterid'));
    }

    url.search = keep.toString();
    return url.href;
  } catch {
    return normalizeUrl(value);
  }
}

function activityFolderBaseFromPage(pageTitle, pageUrl) {
  const parts = cleanText(pageTitle)
    .split('/')
    .map(p => p.trim())
    .filter(Boolean);

  const lastTitlePart = parts[parts.length - 1];

  if (lastTitlePart) {
    return sanitizeFolderName(lastTitlePart, 'activity');
  }

  try {
    const url = new URL(pageUrl);

    const activityPath = url.pathname
      .replace(/^\/moodle\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '-')
      .replace(/\.php$/i, '');

    const params = [];

    if (url.searchParams.has('id')) params.push(`id-${url.searchParams.get('id')}`);
    if (url.searchParams.has('pageid')) params.push(`pageid-${url.searchParams.get('pageid')}`);
    if (url.searchParams.has('chapterid')) params.push(`chapterid-${url.searchParams.get('chapterid')}`);

    const rawFolder = [activityPath, ...params].filter(Boolean).join('-');
    return sanitizeFolderName(rawFolder || 'activity', 'activity');
  } catch {
    return 'activity';
  }
}

function numberedRootFolder(key, baseFolder) {
  if (!activityFolderNumbers.has(key)) {
    const number = String(nextActivityFolderNumber).padStart(3, '0');
    activityFolderNumbers.set(key, `${number} - ${baseFolder}`);
    nextActivityFolderNumber += 1;
  }

  return activityFolderNumbers.get(key);
}

function numberedActivityFolderFromPage(pageTitle, pageUrl) {
  const baseFolder = activityFolderBaseFromPage(pageTitle, pageUrl);

  let key;

  try {
    key = canonicalPageKey(pageUrl);
  } catch {
    key = `${baseFolder}|${pageUrl}`;
  }

  return numberedRootFolder(key, baseFolder);
}

function lessonKeyFromUrl(pageUrl) {
  return activityKeyFromUrl(pageUrl, 'lesson');
}

function bookKeyFromUrl(pageUrl) {
  return activityKeyFromUrl(pageUrl, 'book');
}

function activityKeyFromUrl(pageUrl, fallbackPrefix) {
  try {
    const url = new URL(pageUrl);
    const id = url.searchParams.get('id');
    if (id) return `${url.origin}${url.pathname}?id=${id}`;
  } catch {
    // Fall through to the raw URL fallback.
  }

  return `${fallbackPrefix}|${pageUrl}`;
}

function lessonTitlePartsFromPage(pageTitle) {
  return cleanText(pageTitle)
    .split('/')
    .map(p => p.trim())
    .filter(Boolean);
}

function lessonFolderBaseFromPage(pageTitle, pageUrl) {
  return activityParentFolderBaseFromPage(pageTitle, pageUrl, isLessonUrl, 'lesson');
}

function bookFolderBaseFromPage(pageTitle, pageUrl) {
  return activityParentFolderBaseFromPage(pageTitle, pageUrl, isBookUrl, 'book');
}

function activityParentFolderBaseFromPage(pageTitle, pageUrl, isActivityUrl, fallback) {
  if (!isActivityUrl(pageUrl)) return '';

  const parts = lessonTitlePartsFromPage(pageTitle);
  const isSubpage = hasActivitySubpageParam(pageUrl);
  const activityName = isSubpage && parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];

  return sanitizeFolderName(activityName || activityFolderBaseFromPage(pageTitle, pageUrl), fallback);
}

function hasActivitySubpageParam(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.searchParams.has('pageid') || url.searchParams.has('chapterid');
  } catch {
    return false;
  }
}

function lessonSubpageFolderBaseFromPage(pageTitle, pageUrl) {
  return activitySubpageFolderBaseFromPage(pageTitle, pageUrl, 'lesson-page');
}

function bookSubpageFolderBaseFromPage(pageTitle, pageUrl) {
  return activitySubpageFolderBaseFromPage(pageTitle, pageUrl, 'book-page');
}

function activitySubpageFolderBaseFromPage(pageTitle, pageUrl, fallback) {
  const parts = lessonTitlePartsFromPage(pageTitle);
  const pageName = parts[parts.length - 1];

  return sanitizeFolderName(pageName || activityFolderBaseFromPage(pageTitle, pageUrl), fallback);
}

function numberedLessonSubpageFolderFromPage(pageTitle, pageUrl) {
  return numberedActivitySubpageFolderFromPage(
    lessonSubpageFolderNumbers,
    lessonKeyFromUrl(pageUrl),
    pageUrl,
    lessonSubpageFolderBaseFromPage(pageTitle, pageUrl)
  );
}

function numberedBookSubpageFolderFromPage(pageTitle, pageUrl) {
  return numberedActivitySubpageFolderFromPage(
    bookSubpageFolderNumbers,
    bookKeyFromUrl(pageUrl),
    pageUrl,
    bookSubpageFolderBaseFromPage(pageTitle, pageUrl)
  );
}

function numberedActivitySubpageFolderFromPage(folderNumbers, activityKey, pageUrl, baseFolder) {
  const subpageKey = canonicalPageKey(pageUrl);

  if (!folderNumbers.has(activityKey)) {
    folderNumbers.set(activityKey, {
      nextNumber: 1,
      folders: new Map(),
    });
  }

  const activityFolders = folderNumbers.get(activityKey);

  if (!activityFolders.folders.has(subpageKey)) {
    const number = String(activityFolders.nextNumber).padStart(3, '0');
    activityFolders.folders.set(subpageKey, `${number} - ${baseFolder}`);
    activityFolders.nextNumber += 1;
  }

  return activityFolders.folders.get(subpageKey);
}

function lessonActivityScopedDir(courseDir, pageTitle, pageUrl) {
  return subpageActivityScopedDir(
    courseDir,
    lessonKeyFromUrl(pageUrl),
    lessonFolderBaseFromPage(pageTitle, pageUrl),
    numberedLessonSubpageFolderFromPage(pageTitle, pageUrl)
  );
}

function bookActivityScopedDir(courseDir, pageTitle, pageUrl) {
  return subpageActivityScopedDir(
    courseDir,
    bookKeyFromUrl(pageUrl),
    bookFolderBaseFromPage(pageTitle, pageUrl),
    numberedBookSubpageFolderFromPage(pageTitle, pageUrl)
  );
}

function subpageActivityScopedDir(courseDir, activityKey, activityFolderBase, subpageFolder) {
  const activityFolder = numberedRootFolder(activityKey, activityFolderBase);
  const relativeFolder = path.join(activityFolder, subpageFolder);
  const dir = path.join(courseDir, relativeFolder);

  fs.mkdirSync(dir, { recursive: true });

  return { dir, folder: relativeFolder };
}

function lessonScopedFolderFromPage(pageTitle, pageUrl) {
  if (!isLessonUrl(pageUrl)) return '';

  const parts = cleanText(pageTitle)
    .split('/')
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length < 2) return '';

  const lessonName = parts[parts.length - 2];
  const pageName = parts[parts.length - 1];

  if (!lessonName || !pageName || lessonName === pageName) return '';

  return sanitizeFolderName(lessonName, 'lesson');
}

function activityScopedDir(courseDir, pageTitle, pageUrl) {
  if (isLessonUrl(pageUrl)) {
    return lessonActivityScopedDir(courseDir, pageTitle, pageUrl);
  }

  if (isBookUrl(pageUrl)) {
    return bookActivityScopedDir(courseDir, pageTitle, pageUrl);
  }

  const folder = numberedActivityFolderFromPage(pageTitle, pageUrl);
  const lessonFolder = lessonScopedFolderFromPage(pageTitle, pageUrl);
  const relativeFolder = lessonFolder ? path.join(lessonFolder, folder) : folder;
  const dir = path.join(courseDir, relativeFolder);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, folder: relativeFolder };
}

function getUrlExtension(urlValue) {
  try {
    const url = new URL(urlValue);
    const decodedPath = decodeURIComponent(url.pathname);
    return path.extname(decodedPath).toLowerCase();
  } catch {
    const withoutQuery = String(urlValue || '').split('?')[0];
    return path.extname(withoutQuery).toLowerCase();
  }
}

function isPhpExtension(ext) {
  return String(ext || '').toLowerCase() === '.php';
}

function isSvgUrl(urlValue) {
  return getUrlExtension(urlValue) === '.svg';
}

function isM3u8Url(urlValue) {
  try {
    const url = new URL(urlValue);
    return /\.m3u8$/i.test(url.pathname);
  } catch {
    return /\.m3u8(\?|$)/i.test(String(urlValue || ''));
  }
}

function isM3u8Filename(filename) {
  return /\.m3u8$/i.test(String(filename || ''));
}

function isVideoUrl(urlValue) {
  const ext = getUrlExtension(urlValue);
  return VIDEO_EXTENSIONS.has(ext);
}

function isLikelyVideoFilename(filename) {
  return VIDEO_EXTENSIONS.has(path.extname(filename || '').toLowerCase());
}

function shouldRecordDownloadResult(downloadResult) {
  if (!downloadResult) return false;
  if (downloadResult.downloadedFile) return true;
  if (!downloadResult.downloadError) return false;
  return !IGNORABLE_DOWNLOAD_ERRORS.has(downloadResult.downloadError);
}

function isKalturaIframeUrl(url) {
  if (!url) return false;

  return (
    url.includes(CONFIG.kalturaHost) ||
    url.includes(CONFIG.kalturaApiHost) ||
    url.includes(CONFIG.kalturaCap2Host) ||
    url.includes('static.kaltura.com') ||
    url.includes('filter/kaltura') ||
    url.includes('/embedIframeJs/') ||
    url.includes('entry_id=') ||
    url.includes('entryId=')
  );
}

function isYoutubeIframeUrl(url) {
  if (!url) return false;

  return (
    /https?:\/\/(www\.)?youtube\.com\/embed\/[a-zA-Z0-9_-]{11}/i.test(url) ||
    /https?:\/\/(www\.)?youtube-nocookie\.com\/embed\/[a-zA-Z0-9_-]{11}/i.test(url)
  );
}

function isHighlightedIframeUrl(url) {
  if (!url) return false;

  try {
    return new URL(url).hostname === CONFIG.allowedHost;
  } catch {
    return false;
  }
}

function isWantedIframeUrl(url) {
  return isHighlightedIframeUrl(url);
}

function isRoyalRoadsDownloadableUrl(urlValue) {
  try {
    const url = new URL(urlValue);

    return (
      url.href.startsWith('https://csonline.royalroads.ca') ||
      url.href.startsWith('http://csonline.royalroads.ca') ||
      url.href.startsWith('https://media.royalroads.ca') ||
      url.href.startsWith('http://media.royalroads.ca')
    );
  } catch {
    return false;
  }
}

function isMediaRoyalRoadsUrl(urlValue) {
  try {
    const url = new URL(urlValue);

    return (
      url.href.startsWith('https://media.royalroads.ca') ||
      url.href.startsWith('http://media.royalroads.ca')
    );
  } catch {
    return false;
  }
}

function isMoodlePageUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    const p = url.pathname;

    return (
      p.includes('/mod/page/view.php') ||
      p.includes('/mod/lesson/view.php') ||
      p.includes('/mod/book/view.php') ||
      p.includes('/mod/forum/view.php') ||
      p.includes('/course/view.php')
    );
  } catch {
    return false;
  }
}

function extensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();

  if (type.includes('application/vnd.apple.mpegurl')) return '.m3u8';
  if (type.includes('application/x-mpegurl')) return '.m3u8';
  if (type.includes('audio/mpegurl')) return '.m3u8';

  if (type.includes('video/mp4')) return '.mp4';
  if (type.includes('video/quicktime')) return '.mov';
  if (type.includes('video/webm')) return '.webm';
  if (type.includes('video/x-msvideo')) return '.avi';
  if (type.includes('video/x-ms-wmv')) return '.wmv';

  if (type.includes('audio/mpeg')) return '.mp3';
  if (type.includes('audio/mp4')) return '.m4a';
  if (type.includes('audio/wav')) return '.wav';
  if (type.includes('audio/aac')) return '.aac';
  if (type.includes('audio/ogg')) return '.ogg';
  if (type.includes('audio/flac')) return '.flac';

  if (type.includes('application/pdf')) return '.pdf';

  if (type.includes('application/vnd.ms-powerpoint')) return '.ppt';
  if (type.includes('application/vnd.openxmlformats-officedocument.presentationml.presentation')) return '.pptx';

  if (type.includes('application/msword')) return '.doc';
  if (type.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) return '.docx';

  if (type.includes('application/vnd.ms-excel')) return '.xls';
  if (type.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) return '.xlsx';

  if (type.includes('image/jpeg')) return '.jpg';
  if (type.includes('image/png')) return '.png';
  if (type.includes('image/gif')) return '.gif';
  if (type.includes('image/webp')) return '.webp';

  if (type.includes('text/plain')) return '.txt';
  if (type.includes('text/csv')) return '.csv';

  return '';
}

function isLikelyHtmlResponse(contentType) {
  return String(contentType || '').toLowerCase().includes('text/html');
}

function isLikelySvgResponse(contentType) {
  return String(contentType || '').toLowerCase().includes('image/svg+xml');
}

function isLikelyM3u8Response(contentType) {
  const type = String(contentType || '').toLowerCase();

  return (
    type.includes('application/vnd.apple.mpegurl') ||
    type.includes('application/x-mpegurl') ||
    type.includes('audio/mpegurl')
  );
}

function getFilenameFromContentDisposition(contentDisposition) {
  const header = String(contentDisposition || '');

  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '');
    }
  }

  const match = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (match && match[2]) {
    return match[2].trim();
  }

  return '';
}

function shouldSkipCrawlUrl(value) {
  try {
    const url = new URL(value);

    if (url.hostname !== CONFIG.allowedHost) return true;

    const pathname = url.pathname;

    if (!pathname.includes('/moodle/')) return true;

    if (pathname.includes('/course/view.php')) {
      const id = url.searchParams.get('id') || '';
      if (CURRENT_START_COURSE_ID && id && id !== CURRENT_START_COURSE_ID) return true;
    }

    const action = (url.searchParams.get('action') || '').toLowerCase();

    if ([
      'grading',
      'grader',
      'downloadall',
      'download',
      'editsubmission',
      'viewpluginpage',
    ].includes(action)) {
      return true;
    }

    if (url.searchParams.has('o')) return true;

    const noisyParams = [
      'tsort',
      'tdir',
      'thide',
      'rownum',
      'useridlistid',
      'nonjscomment',
      'comment_itemid',
      'comment_context',
      'comment_component',
      'comment_area',
      'perpage',
      'sort',
      'dir',
      'download',
      'sesskey',
    ];

    for (const param of noisyParams) {
      if (url.searchParams.has(param)) return true;
    }

    if (/logout|delete|remove|unenrol|edit=|grade|report/i.test(url.href)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function activityAllowedPattern(url) {
  return (
    url.includes('/mod/page/view.php') ||
    url.includes('/mod/lesson/view.php') ||
    url.includes('/mod/book/view.php') ||
    url.includes('/mod/resource/view.php') ||
    url.includes('/mod/url/view.php') ||
    url.includes('/mod/scorm/view.php') ||
    url.includes('/mod/folder/view.php') ||
    url.includes('/mod/assign/view.php') ||
    url.includes('/mod/forum/view.php') ||
    url.includes('/mod/quiz/view.php') ||
    url.includes('/mod/glossary/view.php') ||
    url.includes('/mod/choice/view.php') ||
    url.includes('/course/view.php')
  );
}

function isLessonUrl(value) {
  return isActivityTypeUrl(value, '/mod/lesson/view.php');
}

function isBookUrl(value) {
  return isActivityTypeUrl(value, '/mod/book/view.php');
}

function isActivityTypeUrl(value, pathnamePart) {
  try {
    return new URL(value).pathname.includes(pathnamePart);
  } catch {
    return false;
  }
}

function isSameActivityUrl(candidateValue, activityValue, pathnamePart) {
  try {
    const candidate = new URL(candidateValue);
    const activity = new URL(activityValue);

    return (
      candidate.hostname === CONFIG.allowedHost &&
      activity.hostname === CONFIG.allowedHost &&
      candidate.pathname === activity.pathname &&
      candidate.pathname.includes(pathnamePart) &&
      candidate.searchParams.get('id') === activity.searchParams.get('id')
    );
  } catch {
    return false;
  }
}

function isSameLessonUrl(candidateValue, lessonValue) {
  return isSameActivityUrl(candidateValue, lessonValue, '/mod/lesson/view.php');
}

function isSameBookUrl(candidateValue, bookValue) {
  return isSameActivityUrl(candidateValue, bookValue, '/mod/book/view.php');
}

function youtubeWatchUrl(videoId) {
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

function extractYoutubeFromText(text) {
  if (!text) return '';

  const patterns = [
    /https?:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/www\.youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /https?:\/\/www\.youtube-nocookie\.com\/embed\/([a-zA-Z0-9_-]{11})/i,
    /"referenceId"\s*:\s*"([a-zA-Z0-9_-]{11})"/i,
    /referenceId['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{11})['"]/i,
    /videoId['"]?\s*[:=]\s*['"]([a-zA-Z0-9_-]{11})['"]/i,
    /loadVideoById\(['"]([a-zA-Z0-9_-]{11})['"]\)/i,
    /cueVideoById\(['"]([a-zA-Z0-9_-]{11})['"]\)/i,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return youtubeWatchUrl(match[1]);
  }

  return '';
}

async function tryExtractYoutubeByFetching(context, iframeUrl) {
  try {
    const response = await context.request.get(iframeUrl, { timeout: 30000 });
    if (!response.ok()) return '';

    const body = await response.text();
    return extractYoutubeFromText(body);
  } catch {
    return '';
  }
}

async function tryExtractYoutubeByOpeningFrame(context, iframeUrl) {
  const probePage = await context.newPage();
  probePage.setDefaultTimeout(5000);
  probePage.setDefaultNavigationTimeout(45000);

  let youtubeUrl = '';

  const inspectText = text => {
    const found = extractYoutubeFromText(text);
    if (found && !youtubeUrl) youtubeUrl = found;
  };

  probePage.on('request', request => inspectText(request.url()));
  probePage.on('response', response => inspectText(response.url()));
  probePage.on('console', message => inspectText(message.text()));

  try {
    await probePage.addInitScript(() => {
      window.addEventListener('message', event => {
        try {
          const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
          console.log(`[RR_MESSAGE] ${raw}`);
        } catch {}
      }, true);

      const originalPostMessage = window.postMessage;
      window.postMessage = function patchedPostMessage(...args) {
        try {
          console.log(`[RR_POSTMESSAGE] ${JSON.stringify(args)}`);
        } catch {}
        return originalPostMessage.apply(this, args);
      };
    });

    await probePage.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await probePage.waitForTimeout(1500);

    inspectText(await probePage.content());

    for (const frame of probePage.frames()) {
      inspectText(frame.url());

      try {
        inspectText(await frame.content());
      } catch {}
    }

    for (const selector of [
      'button[aria-label*="Play" i]',
      '.playkit-control-play-pause',
      '.playkit-player button',
      'button',
      '[role="button"]',
      '.largePlayBtn',
      '.playButton',
      'video',
    ]) {
      if (youtubeUrl) break;

      try {
        const loc = probePage.locator(selector).first();

        if (await loc.count()) {
          await loc.click({ timeout: 1500, force: true });
          await probePage.waitForTimeout(1500);
        }
      } catch {}

      for (const frame of probePage.frames()) {
        inspectText(frame.url());

        try {
          inspectText(await frame.content());
        } catch {}
      }
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

  let youtubeUrl = await tryExtractYoutubeByFetching(context, iframeUrl);
  if (youtubeUrl) return youtubeUrl;

  youtubeUrl = await tryExtractYoutubeByOpeningFrame(context, iframeUrl);
  return youtubeUrl || '';
}

function addResult(record) {
  if (!record.url) return false;

  const key = `${record.type}|${normalizeUrl(record.url)}|${normalizeUrl(record.pageUrl)}`;
  const existingIndex = resultIndexByKey.get(key);
  const existing = existingIndex === undefined ? null : results[existingIndex];

  if (existing) {
    if (!existing.youtubeUrl && record.youtubeUrl) existing.youtubeUrl = record.youtubeUrl;
    if (!existing.downloadedFile && record.downloadedFile) existing.downloadedFile = record.downloadedFile;
    if (!existing.downloadedPath && record.downloadedPath) existing.downloadedPath = record.downloadedPath;
    if (!existing.downloadError && record.downloadError) existing.downloadError = record.downloadError;
    return false;
  }

  if (seenRecords.has(key)) return false;
  seenRecords.add(key);

  resultIndexByKey.set(key, results.length);

  results.push({
    type: record.type || 'unknown',
    url: record.url,
    youtubeUrl: record.youtubeUrl || '',
    downloadedFile: record.downloadedFile || '',
    downloadedPath: record.downloadedPath || '',
    downloadError: record.downloadError || '',
    pageTitle: record.pageTitle || '',
    pageUrl: record.pageUrl || '',
    alt: record.alt || '',
    foundAt: new Date().toISOString(),
  });

  return true;
}

async function autoLoginIfNeeded(page) {
  if (!CONFIG.username || !CONFIG.password) {
    console.log('No RRU_USERNAME/RRU_PASSWORD environment variables found. Skipping auto-login.');
    return false;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(500);

  const hasPasswordField = await page.locator('input[type="password"]').count().catch(() => 0);

  const looksLikeLoginPage =
    /login|signin|sign-in|saml|cas|auth|adfs/i.test(page.url()) ||
    hasPasswordField > 0;

  if (!looksLikeLoginPage) {
    return false;
  }

  console.log('Login page detected. Attempting automatic login...');
  console.log(`Current login URL: ${page.url()}`);

  const usernameSelectors = [
    'input[name="username"]',
    'input[name="user"]',
    'input[name="j_username"]',
    'input[name="email"]',
    'input[name="login"]',
    'input[name="UserName"]',
    'input[name="userName"]',
    'input[id="username"]',
    'input[id="user"]',
    'input[id="email"]',
    'input[id="login"]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[type="email"]',
    'input[type="text"]',
  ];

  const passwordSelectors = [
    'input[name="password"]',
    'input[name="pass"]',
    'input[name="j_password"]',
    'input[name="Password"]',
    'input[id="password"]',
    'input[id="pass"]',
    'input[id*="pass" i]',
    'input[type="password"]',
  ];

  async function fillFirstVisible(selectors, value, label) {
    for (const selector of selectors) {
      try {
        const loc = page.locator(selector).first();

        if (!(await loc.count())) continue;

        await loc.waitFor({ state: 'visible', timeout: 5000 });
        await loc.click({ timeout: 3000 });
        await loc.fill('', { timeout: 3000 });
        await loc.type(value, { delay: 10, timeout: 10000 });

        console.log(`Filled ${label} using selector: ${selector}`);
        return loc;
      } catch {}
    }

    console.log(`Could not find visible ${label} field.`);
    return null;
  }

  const usernameLocator = await fillFirstVisible(usernameSelectors, CONFIG.username, 'username');
  const passwordLocator = await fillFirstVisible(passwordSelectors, CONFIG.password, 'password');

  if (!usernameLocator || !passwordLocator) {
    console.log('Automatic login failed because one or both fields were not filled.');
    return false;
  }

  await page.waitForTimeout(300);

  let submitted = false;

  try {
    submitted = await passwordLocator.evaluate(el => {
      const form = el.closest('form');
      if (!form) return false;

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }

      return true;
    });
  } catch {}

  if (submitted) {
    console.log('Submitted login form via parent form.');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  const stillLooksLikeLogin =
    (await page.locator('input[type="password"]').count().catch(() => 0)) > 0 ||
    /login|signin|sign-in|saml|cas|auth|adfs/i.test(page.url());

  if (stillLooksLikeLogin) {
    const submitSelectors = [
      'form button[type="submit"]',
      'form input[type="submit"]',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Sign In")',
      'input[value*="Log in" i]',
      'input[value*="Login" i]',
      'input[value*="Sign in" i]',
    ];

    let clicked = false;

    for (const selector of submitSelectors) {
      try {
        const loc = page.locator(selector).first();

        if (!(await loc.count())) continue;

        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
          loc.click({ timeout: 5000 }),
        ]);

        clicked = true;
        console.log(`Clicked login submit using selector: ${selector}`);
        await page.waitForTimeout(2500);
        break;
      } catch {}
    }

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      console.log('Submitted login with Enter.');
    }
  }

  const finalPasswordCount = await page.locator('input[type="password"]').count().catch(() => 0);

  if (finalPasswordCount === 0 && !/login|signin|sign-in|saml|cas|auth|adfs/i.test(page.url())) {
    console.log('Automatic login appears successful.');
    return true;
  }

  console.log('Automatic login may not have completed.');
  console.log(`Current URL after login attempt: ${page.url()}`);
  return false;
}

async function expandCoursePageIfPossible(page) {
  const expandSelectors = [
    'button:has-text("Expand all")',
    'a:has-text("Expand all")',
    '[data-action="expandallcourseindexsections"]',
    'button:has-text("Show all")',
    'a:has-text("Show all")',
    'button[aria-expanded="false"]',
    '[role="button"][aria-expanded="false"]',
    '.section .collapsed',
    '.course-section .collapsed',
  ];

  for (const selector of expandSelectors) {
    for (let i = 0; i < 50; i++) {
      try {
        const loc = page.locator(selector).first();
        if (!(await loc.count())) break;

        await loc.click({ timeout: 1000, force: true });
        await page.waitForTimeout(100);
      } catch {
        break;
      }
    }
  }

  await page.waitForTimeout(300);
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

    if (title && !parts.includes(title)) parts.push(title);

    const isLesson =
      document.body?.classList?.contains('path-mod-lesson') ||
      location.href.includes('/mod/lesson/view.php');

    const isBook =
      document.body?.classList?.contains('path-mod-book') ||
      location.href.includes('/mod/book/view.php');

    if (isLesson || isBook) {
      const selectors = isLesson ? [
        '.lesson-content h1',
        '.lesson-content h2',
        '.contents h1',
        '.contents h2',
        '.box.contents h1',
        '.box.contents h2',
        '#region-main h2',
        '#region-main h3',
        '.lessonpagetitle',
        '.lesson-page-title',
        '.mod_lesson-title',
      ] : [
        '.book_content h1',
        '.book_content h2',
        '.book_content h3',
        '.book_content h4',
        '.mod_book-chapter-title',
        '#region-main .book_content h3',
        '#region-main h3',
        '#region-main h4',
      ];

      for (const selector of selectors) {
        const text = cleanText(document.querySelector(selector)?.textContent);
        if (!text) continue;
        if (text === title) continue;
        if (/^(previous|next|continue|contents|question|response|table of contents)$/i.test(text)) continue;
        if (!parts.includes(text)) parts.push(text);
        break;
      }
    }

    return parts.join(' / ');
  });
}

async function getCourseName(page) {
  const pagePath = await getPagePath(page);
  const firstPart = pagePath.split('/').map(p => p.trim()).filter(Boolean)[0];
  return sanitizeFilenamePart(firstPart || 'Royal Roads Course');
}

async function collectCourseLinks(page) {
  const links = await page.evaluate(() => {
    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    const output = [];

    for (const a of document.querySelectorAll('a[href]')) {
      output.push(absoluteUrl(a.getAttribute('href')));
    }

    for (const opt of document.querySelectorAll('select.urlselect option[value], #jump-to-activity option[value], option[value]')) {
      const value = opt.getAttribute('value');
      if (value && value.includes('/mod/')) {
        output.push(absoluteUrl(value));
      }
    }

    return output.filter(Boolean);
  });

  const filtered = links.filter(url => {
    if (shouldSkipCrawlUrl(url)) return false;
    if (!activityAllowedPattern(url)) return false;
    return true;
  });

  const byKey = new Map();

  for (const url of filtered) {
    const key = canonicalPageKey(url);
    if (!byKey.has(key)) byKey.set(key, url);
  }

  return [...byKey.values()];
}

function compareActivitySubpageLinks(a, b) {
  const aSort = activitySubpageSortParts(a);
  const bSort = activitySubpageSortParts(b);

  if (aSort.activityId !== bSort.activityId) return aSort.activityId.localeCompare(bSort.activityId);
  if (aSort.kind !== bSort.kind) return aSort.kind.localeCompare(bSort.kind);
  if (aSort.subpageNumber !== bSort.subpageNumber) return aSort.subpageNumber - bSort.subpageNumber;
  return aSort.url.localeCompare(bSort.url);
}

function activitySubpageSortParts(value) {
  try {
    const url = new URL(value);
    const pageid = Number(url.searchParams.get('pageid'));
    const chapterid = Number(url.searchParams.get('chapterid'));
    const hasPageid = Number.isFinite(pageid) && pageid > 0;
    const hasChapterid = Number.isFinite(chapterid) && chapterid > 0;

    return {
      activityId: url.searchParams.get('id') || '',
      kind: hasPageid ? 'pageid' : hasChapterid ? 'chapterid' : '',
      subpageNumber: hasPageid ? pageid : hasChapterid ? chapterid : Number.MAX_SAFE_INTEGER,
      url: url.href,
    };
  } catch {
    return { activityId: '', kind: '', subpageNumber: Number.MAX_SAFE_INTEGER, url: String(value || '') };
  }
}

async function collectLessonSubpageLinks(page, lessonUrl) {
  if (!isLessonUrl(lessonUrl)) return [];
  return collectSameActivitySubpageLinks(page, lessonUrl, isSameLessonUrl, /https?:\/\/[^'" )]+|\/moodle\/mod\/lesson\/view\.php\?[^'" )]+/gi);
}

async function collectBookSubpageLinks(page, bookUrl) {
  if (!isBookUrl(bookUrl)) return [];

  const links = await collectSameActivitySubpageLinks(page, bookUrl, isSameBookUrl, /https?:\/\/[^'" )]+|\/moodle\/mod\/book\/view\.php\?[^'" )]+/gi);

  // Moodle book landing URLs without a chapterid render the first chapter's
  // content. Do not queue that first chapter again, otherwise the same book
  // page is saved once as the book landing page and again as chapter 1.
  if (!hasBookChapterParam(bookUrl) && links.length > 0) {
    return links.slice(1);
  }

  return links;
}

function hasBookChapterParam(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.pathname.includes('/mod/book/view.php') && url.searchParams.has('chapterid');
  } catch {
    return false;
  }
}

async function collectSameActivitySubpageLinks(page, activityUrl, isSameActivityUrl, onclickUrlPattern) {
  const currentPageKey = canonicalPageKey(activityUrl);

  const links = await page.evaluate((onclickUrlPattern) => {
    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    const output = [];

    for (const a of document.querySelectorAll('a[href]')) {
      output.push(absoluteUrl(a.getAttribute('href')));
    }

    for (const form of document.querySelectorAll('form[action]')) {
      const actionUrl = absoluteUrl(form.getAttribute('action'));
      output.push(actionUrl);

      try {
        const url = new URL(actionUrl);
        for (const input of form.querySelectorAll('input[name][value]')) {
          url.searchParams.set(input.getAttribute('name'), input.getAttribute('value'));
        }
        output.push(url.href);
      } catch {
        // Ignore malformed form actions.
      }
    }

    for (const button of document.querySelectorAll('button[formaction], input[formaction]')) {
      output.push(absoluteUrl(button.getAttribute('formaction')));
    }

    for (const opt of document.querySelectorAll('select.urlselect option[value], #jump-to-activity option[value], option[value]')) {
      const value = opt.getAttribute('value');
      if (value) output.push(absoluteUrl(value));
    }

    for (const element of document.querySelectorAll('[data-url], [data-href], [data-link], [onclick]')) {
      for (const attr of ['data-url', 'data-href', 'data-link']) {
        const value = element.getAttribute(attr);
        if (value) output.push(absoluteUrl(value));
      }

      const onclick = element.getAttribute('onclick') || '';
      for (const match of onclick.matchAll(new RegExp(onclickUrlPattern, 'gi'))) {
        output.push(absoluteUrl(match[0]));
      }
    }

    return output.filter(Boolean);
  }, onclickUrlPattern.source);

  const byKey = new Map();

  for (const link of links) {
    if (shouldSkipCrawlUrl(link)) continue;
    if (!isSameActivityUrl(link, activityUrl)) continue;

    const key = canonicalPageKey(link);
    if (key === currentPageKey) continue;
    if (!byKey.has(key)) byKey.set(key, link);
  }

  // Preserve the order Moodle exposes in the page DOM/navigation. Lesson page IDs
  // are not guaranteed to be sequential in reading order, so sorting by pageid can
  // place a single late-created/edited lesson subpage out of order.
  return [...byKey.values()];
}

async function listAllSeenPageLinks(page, courseDir) {
  const allLinks = await page.evaluate(() => {
    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    const output = [];

    for (const a of document.querySelectorAll('a[href]')) {
      output.push({
        href: absoluteUrl(a.getAttribute('href')),
        text: String(a.textContent || '').replace(/\s+/g, ' ').trim(),
        source: 'a[href]',
      });
    }

    for (const opt of document.querySelectorAll('select.urlselect option[value], #jump-to-activity option[value], option[value]')) {
      const value = opt.getAttribute('value');
      if (value && value.includes('/mod/')) {
        output.push({
          href: absoluteUrl(value),
          text: String(opt.textContent || '').replace(/\s+/g, ' ').trim(),
          source: 'jump-to-activity option',
        });
      }
    }

    return output.filter(item => item.href);
  });

  const courseActivityLinks = allLinks.filter(item =>
    item.href.includes('csonline.royalroads.ca/moodle/') &&
    activityAllowedPattern(item.href)
  );

  const rows = courseActivityLinks.map((item, index) => {
    const skipReason = shouldSkipCrawlUrl(item.href) ? 'SKIPPED_BY_FILTER' : '';
    const canonical = canonicalPageKey(item.href);

    return {
      index: index + 1,
      text: item.text,
      href: item.href,
      canonical,
      skipReason,
      source: item.source,
    };
  });

  const uniqueByCanonical = new Map();

  for (const row of rows) {
    if (!uniqueByCanonical.has(row.canonical)) {
      uniqueByCanonical.set(row.canonical, row);
    }
  }

  const uniqueRows = [...uniqueByCanonical.values()];

  const txtLines = uniqueRows.map(row =>
    [
      String(row.index).padStart(4, '0'),
      row.skipReason || 'OK',
      row.source,
      row.text || '(no link text)',
      row.href,
      `canonical: ${row.canonical}`,
    ].join(' | ')
  );

  const csvRows = [
    ['index', 'status', 'source', 'text', 'href', 'canonical'],
    ...uniqueRows.map(row => [
      row.index,
      row.skipReason || 'OK',
      row.source,
      row.text,
      row.href,
      row.canonical,
    ]),
  ];

  const txtPath = path.join(courseDir, '_all-course-page-links-seen-before-processing.txt');
  const csvPath = path.join(courseDir, '_all-course-page-links-seen-before-processing.csv');

  fs.writeFileSync(txtPath, txtLines.join('\n'), 'utf8');
  fs.writeFileSync(csvPath, csvRows.map(row => row.map(csvEscape).join(',')).join('\n'), 'utf8');

  console.log('\nAll course/activity links seen before processing:');

  for (const row of uniqueRows) {
    console.log(
      `  ${String(row.index).padStart(4, '0')} ` +
      `[${row.skipReason || 'OK'}] ` +
      `[${row.source}] ` +
      `${row.text || '(no link text)'} -> ${row.href}`
    );
  }

  console.log(`\nFull initial link audit TXT: ${txtPath}`);
  console.log(`Full initial link audit CSV: ${csvPath}`);

  return uniqueRows;
}

async function collectIframesFromPage(page) {
  return page.evaluate((iframeHost) => {
    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    return [...document.querySelectorAll('iframe[src]')]
      .map(iframe => ({
        url: absoluteUrl(iframe.getAttribute('src')),
        alt: iframe.getAttribute('title') || iframe.getAttribute('aria-label') || iframe.getAttribute('id') || '',
      }))
      .filter(item => {
        if (!item.url) return false;
        try { return new URL(item.url).hostname === iframeHost; } catch { return false; }
      });
  }, CONFIG.allowedHost);
}

async function collectRoyalRoadsDownloadLinksFromPage(page) {
  return page.evaluate((hosts) => {
    function absoluteUrl(href) {
      try { return new URL(href, location.href).href; } catch { return ''; }
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function pathFromUrl(value) {
      try {
        return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || '');
      } catch {
        return '';
      }
    }

    const urls = [];
    const allowedHosts = new Set(hosts);

    function hasAllowedHost(url) {
      try { return allowedHosts.has(new URL(url).hostname); } catch { return false; }
    }

    for (const img of document.querySelectorAll('img[src]')) {
      const raw = img.getAttribute('src');
      const url = absoluteUrl(raw);
      if (!url) continue;

      if (!hasAllowedHost(url)) continue;

      const label =
        img.getAttribute('alt') ||
        img.getAttribute('title') ||
        img.getAttribute('aria-label') ||
        pathFromUrl(url) ||
        '';

      urls.push({
        url,
        label: cleanText(label),
        source: 'img[src]',
      });
    }

    for (const link of document.querySelectorAll('a[href]')) {
      const raw = link.getAttribute('href');
      const url = absoluteUrl(raw);
      if (!url) continue;
      if (!hasAllowedHost(url)) continue;

      const label =
        cleanText(link.textContent) ||
        link.getAttribute('title') ||
        link.getAttribute('aria-label') ||
        pathFromUrl(url) ||
        '';

      urls.push({
        url,
        label: cleanText(label),
        source: 'a[href]',
      });
    }

    const seen = new Set();

    return urls.filter(item => {
      const key = `${item.source}|${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [CONFIG.mediaHost, CONFIG.allowedHost]);
}

async function extractKalturaConfigFromPage(page) {
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        const html = document.documentElement.innerHTML;

        function clean(value) {
          return String(value || '').replace(/\\\//g, '/');
        }

        let packageData = null;

        try {
          if (window.kalturaIframePackageData) {
            packageData = window.kalturaIframePackageData;
          }
        } catch {}

        let entryId =
          packageData?.playerConfig?.entryId ||
          packageData?.entryResult?.meta?.id ||
          html.match(/loadMedia\(\s*\{\s*entryId\s*:\s*"([^"]+)"/)?.[1] ||
          html.match(/entryId["']?\s*:\s*["']([^"']+)["']/)?.[1] ||
          html.match(/entry_id=([^"&]+)/)?.[1] ||
          '';

        try {
          const currentUrl = new URL(location.href);
          entryId = entryId || currentUrl.searchParams.get('entry_id') || currentUrl.searchParams.get('entryId') || '';
        } catch {}

        const partnerId =
          packageData?.entryResult?.meta?.partnerId ||
          packageData?.playerConfig?.partnerId ||
          html.match(/partnerId["']?\s*:\s*["']?(\d+)["']?/)?.[1] ||
          html.match(/partner_id\/(\d+)/)?.[1] ||
          html.match(/\/p\/(\d+)\//)?.[1] ||
          '143';

        const uiConfId =
          packageData?.playerConfig?.uiConfId ||
          html.match(/uiConfId["']?\s*:\s*["']?(\d+)["']?/)?.[1] ||
          html.match(/uiconf_id\/(\d+)/)?.[1] ||
          '';

        const serviceUrl =
          clean(html.match(/serviceUrl["']?\s*:\s*["']([^"']+)/)?.[1] || 'https://api.ca.kaltura.com/api_v3');

        const cdnUrl =
          clean(html.match(/cdnUrl["']?\s*:\s*["']([^"']+)/)?.[1] || 'https://api.cap2.ovp.kaltura.com');

        const ks =
          html.match(/ks["']?\s*:\s*["']([^"']+)/)?.[1] ||
          '';

        const flavorAssets =
          packageData?.entryResult?.contextData?.flavorAssets ||
          [];

        const downloadUrl =
          packageData?.entryResult?.meta?.downloadUrl ||
          packageData?.entryResult?.meta?.dataUrl ||
          '';

        return {
          entryId: String(entryId || ''),
          partnerId: String(partnerId || '143'),
          uiConfId: String(uiConfId || ''),
          serviceUrl,
          cdnUrl,
          ks,
          flavorAssets,
          downloadUrl,
        };
      });

      if (data.entryId && data.partnerId) {
        return data;
      }
    } catch {}
  }

  return null;
}

async function getKalturaFlavorAssets(context, config) {
  if (Array.isArray(config.flavorAssets) && config.flavorAssets.length) {
    return config.flavorAssets;
  }

  const ksPart = config.ks ? `&ks=${encodeURIComponent(config.ks)}` : '';

  const serviceCandidates = [
    config.serviceUrl || 'https://api.ca.kaltura.com/api_v3',
    'https://api.ca.kaltura.com/api_v3',
    'https://api.cap2.ovp.kaltura.com/api_v3',
  ];

  let lastError = '';

  for (const serviceUrl of serviceCandidates) {
    try {
      const url =
        `${serviceUrl.replace(/\/$/, '')}/service/flavorasset/action/getByEntryId` +
        `?format=1` +
        ksPart +
        `&entryId=${encodeURIComponent(config.entryId)}`;

      const response = await context.request.get(url, { timeout: 30000 });

      if (!response.ok()) {
        lastError = `HTTP ${response.status()}`;
        continue;
      }

      const json = await response.json();

      if (Array.isArray(json)) return json;
      if (json && Array.isArray(json.objects)) return json.objects;
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(`Kaltura flavorAsset.getByEntryId failed: ${lastError || 'unknown error'}`);
}

async function getKalturaFlavorUrlByAction(context, config, flavorAssetId, action) {
  const ksPart = config.ks ? `&ks=${encodeURIComponent(config.ks)}` : '';

  const serviceCandidates = [
    config.serviceUrl || 'https://api.ca.kaltura.com/api_v3',
    'https://api.ca.kaltura.com/api_v3',
    'https://api.cap2.ovp.kaltura.com/api_v3',
  ];

  let lastError = '';

  for (const serviceUrl of serviceCandidates) {
    try {
      const url =
        `${serviceUrl.replace(/\/$/, '')}/service/flavorasset/action/${action}` +
        `?format=1` +
        ksPart +
        `&id=${encodeURIComponent(flavorAssetId)}`;

      const response = await context.request.get(url, { timeout: 30000 });

      if (!response.ok()) {
        lastError = `HTTP ${response.status()}`;
        continue;
      }

      const text = await response.text();

      try {
        const json = JSON.parse(text);
        if (typeof json === 'string') return json;
        if (json && typeof json === 'object' && json.url) return json.url;
      } catch {}

      return text.replace(/^"|"$/g, '');
    } catch (error) {
      lastError = error.message;
    }
  }

  throw new Error(`Kaltura flavorAsset.${action} failed: ${lastError || 'unknown error'}`);
}

async function getKalturaFlavorDirectDownloadUrl(context, config, flavorAssetId) {
  return getKalturaFlavorUrlByAction(context, config, flavorAssetId, 'getDownloadUrl');
}

async function getKalturaFlavorPlaybackUrl(context, config, flavorAssetId) {
  return getKalturaFlavorUrlByAction(context, config, flavorAssetId, 'getUrl');
}

function buildKalturaPlayManifestDownloadUrls(config, flavor) {
  const urls = [];

  const partnerId = config.partnerId || '143';
  const entryId = config.entryId;
  const flavorId = flavor?.id;

  if (!entryId) return urls;

  const hosts = [
    'https://api.ca.kaltura.com',
    'https://api.cap2.ovp.kaltura.com',
  ];

  for (const host of hosts) {
    if (flavorId) {
      urls.push(
        `${host}/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/flavorId/${flavorId}/format/url/protocol/https/a.mp4`
      );
      urls.push(
        `${host}/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/flavorId/${flavorId}/format/download/protocol/https/a.mp4`
      );
    }

    urls.push(
      `${host}/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/download/protocol/https/flavorParamIds/0`
    );
  }

  if (config.downloadUrl) urls.unshift(config.downloadUrl);

  return urls;
}

async function downloadAnyUrlToActivityFolder(context, downloadUrl, pageTitle, label, courseDir, pageUrl) {
  const normalized = normalizeUrl(downloadUrl);

  if (isM3u8Url(downloadUrl)) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: 'Skipped HLS playlist .m3u8 response',
    };
  }

  if (seenDownloadUrls.has(normalized)) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: 'Already downloaded this URL',
    };
  }

  seenDownloadUrls.add(normalized);

  try {
    const response = await context.request.get(downloadUrl, {
      timeout: 120000,
      maxRedirects: 10,
    });

    if (!response.ok()) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: `HTTP ${response.status()} while downloading URL`,
      };
    }

    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const contentDisposition = headers['content-disposition'] || '';

    if (isLikelyHtmlResponse(contentType)) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped HTML page response',
      };
    }

    if (isLikelySvgResponse(contentType)) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped SVG file',
      };
    }

    if (isLikelyM3u8Response(contentType)) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped HLS playlist .m3u8 response',
      };
    }

    const body = await response.body();

    let filename = getFilenameFromContentDisposition(contentDisposition);

    if (!filename) {
      try {
        const url = new URL(downloadUrl);
        filename = decodeURIComponent(path.basename(url.pathname) || '');
      } catch {
        filename = '';
      }
    }

    if (isM3u8Filename(filename)) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped HLS playlist .m3u8 response',
      };
    }

    const { dir: activityDir, folder: activityFolder } = activityScopedDir(courseDir, pageTitle, pageUrl);

    const fallbackBaseName = sanitizeFilenamePart(
      [activityFolder, label || 'download'].filter(Boolean).join(' - '),
      'download'
    );

    filename = sanitizeFilenamePart(filename || fallbackBaseName, fallbackBaseName);

    let ext = path.extname(filename);

    if (isPhpExtension(ext)) {
      filename = path.basename(filename, ext);
      ext = '';
    }

    if (!ext) {
      const urlExt = getUrlExtension(downloadUrl);

      if (urlExt && !isPhpExtension(urlExt) && urlExt !== '.svg' && urlExt !== '.m3u8') {
        filename += urlExt;
        ext = urlExt;
      }
    }

    if (!path.extname(filename)) {
      const contentExt = extensionFromContentType(contentType);

      if (contentExt === '.m3u8') {
        return {
          downloadedFile: '',
          downloadedPath: '',
          downloadError: 'Skipped HLS playlist .m3u8 response',
        };
      }

      filename += contentExt || '.mp4';
    }

    if (path.extname(filename).toLowerCase() === '.svg') {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped SVG file',
      };
    }

    if (path.extname(filename).toLowerCase() === '.m3u8') {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Skipped HLS playlist .m3u8 response',
      };
    }

    ext = path.extname(filename);
    const nameWithoutExt = path.basename(filename, ext);
    const finalName = sanitizeFilenamePart(nameWithoutExt || fallbackBaseName, fallbackBaseName) + ext;

    const savePath = ensureUniqueFilePath(path.join(activityDir, finalName));
    fs.writeFileSync(savePath, body);

    return {
      downloadedFile: path.basename(savePath),
      downloadedPath: path.join(activityFolder, path.basename(savePath)),
      downloadError: '',
    };
  } catch (error) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: error.message,
    };
  }
}

async function tryDownloadKalturaViaApi(context, probePage, courseDir, pageTitle, pageUrl, fallbackName) {
  try {
    const config = await extractKalturaConfigFromPage(probePage);

    if (!config) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'Could not extract Kaltura config from player page',
      };
    }

    const flavors = await getKalturaFlavorAssets(context, config);

    const readyFlavors = flavors
      .filter(f => f && f.id)
      .filter(f => {
        const status = String(f.status ?? '').toLowerCase();
        return status === '2' || status === 'ready' || status === '';
      })
      .filter(f => {
        const ext = String(f.fileExt || f.fileExtention || f.extension || '').toLowerCase();
        return !ext || VIDEO_EXTENSIONS.has(`.${ext}`) || ['mp4', 'mov', 'm4v', 'webm'].includes(ext);
      })
      .sort((a, b) => {
        const aOriginal = a.isOriginal ? 1 : 0;
        const bOriginal = b.isOriginal ? 1 : 0;
        const aHeight = Number(a.height || 0);
        const bHeight = Number(b.height || 0);
        const aBitrate = Number(a.bitrate || 0);
        const bBitrate = Number(b.bitrate || 0);
        const aSize = Number(a.sizeInBytes || a.size || 0);
        const bSize = Number(b.sizeInBytes || b.size || 0);

        return bOriginal - aOriginal || bHeight - aHeight || bBitrate - aBitrate || bSize - aSize;
      });

    if (!readyFlavors.length) {
      return {
        downloadedFile: '',
        downloadedPath: '',
        downloadError: 'No ready downloadable Kaltura flavor assets found',
      };
    }

    let lastError = '';

    for (const flavor of readyFlavors) {
      const labelParts = [
        fallbackName || 'kaltura-video',
        flavor.fileExt ? String(flavor.fileExt) : '',
        flavor.height ? `${flavor.height}p` : '',
        flavor.isOriginal ? 'source' : '',
      ].filter(Boolean);

      const urlGetters = [
        async () => getKalturaFlavorDirectDownloadUrl(context, config, flavor.id),
        async () => getKalturaFlavorPlaybackUrl(context, config, flavor.id),
        ...buildKalturaPlayManifestDownloadUrls(config, flavor).map(url => async () => url),
      ];

      for (const getUrl of urlGetters) {
        try {
          const mediaUrl = await getUrl();

          if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            lastError = 'Kaltura flavor URL was empty or invalid';
            continue;
          }

          if (isM3u8Url(mediaUrl)) {
            lastError = 'Kaltura API returned an HLS .m3u8 URL instead of a downloadable video file';
            continue;
          }

          const downloadResult = await downloadAnyUrlToActivityFolder(
            context,
            mediaUrl,
            pageTitle,
            labelParts.join(' - '),
            courseDir,
            pageUrl
          );

          if (downloadResult.downloadedFile) return downloadResult;

          lastError = downloadResult.downloadError || lastError;
        } catch (error) {
          lastError = error.message;
        }
      }
    }

    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: lastError || 'Kaltura API download failed for all flavor assets',
    };
  } catch (error) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: error.message,
    };
  }
}

async function downloadKalturaVideo(context, iframeUrl, pageTitle, alt, courseDir, pageUrl) {
  if (!iframeUrl) {
    return { downloadedFile: '', downloadedPath: '', downloadError: 'Missing iframe URL' };
  }

  const { folder: activityFolder } = activityScopedDir(courseDir, pageTitle, pageUrl);

  const probePage = await context.newPage();
  probePage.setDefaultTimeout(5000);
  probePage.setDefaultNavigationTimeout(45000);

  const baseName = sanitizeFilenamePart(
    [activityFolder, alt || 'video'].filter(Boolean).join(' - '),
    'kaltura-video'
  );

  const possibleDownloadUrls = [];

  probePage.on('request', request => {
    const url = request.url();

    if (
      /download|flavor|source|mp4|mov|webm|serveFlavor|fileExt|entryId|getUrl|playManifest/i.test(url)
    ) {
      possibleDownloadUrls.push(url);
    }
  });

  probePage.on('response', response => {
    const url = response.url();

    if (
      /download|flavor|source|mp4|mov|webm|serveFlavor|fileExt|entryId|getUrl|playManifest/i.test(url)
    ) {
      possibleDownloadUrls.push(url);
    }
  });

  try {
    await probePage.goto(iframeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await probePage.waitForTimeout(1000);

    const apiResult = await tryDownloadKalturaViaApi(
      context,
      probePage,
      courseDir,
      pageTitle,
      pageUrl,
      baseName
    );

    if (apiResult.downloadedFile) {
      return apiResult;
    }

    const uniqueNetworkUrls = [...new Set(possibleDownloadUrls)]
      .filter(url => /^https?:\/\//i.test(url))
      .filter(url => !/analytics|trackEvent|thumbnail|caption|transcript/i.test(url))
      .filter(url => !isM3u8Url(url));

    let networkLastError = '';

    for (const networkUrl of uniqueNetworkUrls) {
      if (!/\.(mp4|mov|m4v|webm)(\?|$)|flavorasset|serveFlavor|getUrl|getDownloadUrl|playManifest/i.test(networkUrl)) {
        continue;
      }

      const networkResult = await downloadAnyUrlToActivityFolder(
        context,
        networkUrl,
        pageTitle,
        baseName,
        courseDir,
        pageUrl
      );

      if (networkResult.downloadedFile) return networkResult;
      networkLastError = networkResult.downloadError || networkLastError;
    }

    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError:
        networkLastError ||
        apiResult.downloadError ||
        'No downloadable Kaltura video URL found',
    };
  } catch (error) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: error.message,
    };
  } finally {
    await probePage.close().catch(() => {});
  }
}


async function mapWithConcurrency(items, concurrency, mapper) {
  const limit = Math.max(1, Math.floor(concurrency || 1));
  const mapped = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      mapped[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return mapped;
}

async function downloadRoyalRoadsUrlByRequest(context, downloadUrl, pageTitle, label, courseDir, pageUrl) {
  if (isM3u8Url(downloadUrl)) {
    return {
      downloadedFile: '',
      downloadedPath: '',
      downloadError: 'Skipped HLS playlist .m3u8 response',
    };
  }

  return downloadAnyUrlToActivityFolder(context, downloadUrl, pageTitle, label, courseDir, pageUrl);
}

async function savePlaywrightDownload(download, targetDir, fallbackBaseName) {
  const suggested = sanitizeFilenamePart(
    download.suggestedFilename() || `${fallbackBaseName}.bin`,
    `${fallbackBaseName}.bin`
  );

  if (isM3u8Filename(suggested)) {
    return {
      downloadedFile: '',
      absolutePath: '',
      downloadError: 'Skipped HLS playlist .m3u8 response',
    };
  }

  let ext = path.extname(suggested) || '.bin';

  if (isPhpExtension(ext)) ext = '.bin';

  if (ext.toLowerCase() === '.m3u8') {
    return {
      downloadedFile: '',
      absolutePath: '',
      downloadError: 'Skipped HLS playlist .m3u8 response',
    };
  }

  const nameWithoutExt = path.basename(suggested, path.extname(suggested));
  const finalName = sanitizeFilenamePart(nameWithoutExt || fallbackBaseName, fallbackBaseName) + ext;
  const savePath = ensureUniqueFilePath(path.join(targetDir, finalName));

  await download.saveAs(savePath);

  return {
    downloadedFile: path.basename(savePath),
    absolutePath: savePath,
    downloadError: '',
  };
}

async function gotoPageOrCaptureDownload(page, url, pageTitleFallback, courseDir) {
  const fallbackBaseName = sanitizeFilenamePart(pageTitleFallback || 'moodle-download', 'moodle-download');

  const downloadPromise = page
    .waitForEvent('download', { timeout: 8000 })
    .catch(() => null);

  let gotoError = null;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    gotoError = error;
  }

  const download = await downloadPromise;

  if (download) {
    const { dir: activityDir, folder: activityFolder } = activityScopedDir(courseDir, pageTitleFallback, url);
    const saved = await savePlaywrightDownload(download, activityDir, fallbackBaseName);

    if (saved.downloadError) {
      return {
        downloaded: false,
        downloadedFile: '',
        downloadedPath: '',
        error: saved.downloadError,
      };
    }

    return {
      downloaded: true,
      downloadedFile: saved.downloadedFile,
      downloadedPath: path.join(activityFolder, saved.downloadedFile),
      error: '',
    };
  }

  if (gotoError) {
    throw gotoError;
  }

  return {
    downloaded: false,
    downloadedFile: '',
    downloadedPath: '',
    error: '',
  };
}

async function crawlCourse(context, page, startUrl, courseIndex, totalCourses) {
  resetCourseState(startUrl);

  console.log('\n============================================================');
  console.log(`Course ${courseIndex}/${totalCourses}`);
  console.log(startUrl);
  console.log('============================================================');

  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await autoLoginIfNeeded(page);

  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await autoLoginIfNeeded(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await expandCoursePageIfPossible(page);

  const courseName = await getCourseName(page);
  const courseId = getCourseIdFromUrl(startUrl);
  const courseFolderName = sanitizeFolderName(courseId ? `${courseName} (id=${courseId})` : courseName);
  const courseDir = ensureDir(path.join(CONFIG.outputRootDir, courseFolderName));

  await listAllSeenPageLinks(page, courseDir);

  const startLinks = await collectCourseLinks(page);
  fs.writeFileSync(path.join(courseDir, '_initial-course-links.txt'), startLinks.join('\n'), 'utf8');

  console.log('\nFiltered crawl queue at start:');
  startLinks.forEach((link, index) => {
    console.log(`  ${String(index + 1).padStart(4, '0')} ${link}`);
  });

  const queue = [startUrl, ...startLinks];

  console.log(`\nCourse: ${courseName}`);
  console.log(`Course ID: ${courseId || 'unknown'}`);
  console.log(`Output folder: ${courseDir}`);
  console.log(`Found ${startLinks.length} visible course/activity links.`);
  console.log(`Max pages this course: ${CONFIG.maxPages}`);
  console.log('Downloads will be saved into numbered folders, one folder per activity/page title.');
  console.log('YouTube-wrapped Kaltura items will be recorded as YouTube links, not downloaded.');
  console.log('Tampermonkey-highlighted media.royalroads.ca images, csonline.royalroads.ca iframes, and hyperlinks to csonline.royalroads.ca or media.royalroads.ca files will be downloaded.');
  console.log('Only the filtered initial course queue and same-lesson subpages discovered from lesson pages will be crawled.');
  console.log('HLS .m3u8 playlists will be skipped, not saved as successful video downloads.');

  let processed = 0;

  while (queue.length && processed < CONFIG.maxPages) {
    const url = queue.shift();
    const pageKey = canonicalPageKey(url);

    if (seenPageKeys.has(pageKey)) continue;
    if (shouldSkipCrawlUrl(url)) continue;

    seenPageKeys.add(pageKey);

    processed += 1;
    console.log(`\n[${processed}] ${url}`);

    try {
      const earlyDownload = await gotoPageOrCaptureDownload(
        page,
        url,
        `direct-download-${processed}`,
        courseDir
      );

      await autoLoginIfNeeded(page);

      if (earlyDownload.downloaded) {
        addResult({
          type: 'direct_download',
          url,
          downloadedFile: earlyDownload.downloadedFile,
          downloadedPath: earlyDownload.downloadedPath,
          downloadError: '',
          pageTitle: '',
          pageUrl: url,
          alt: '',
        });

        console.log(`  Downloaded: ${earlyDownload.downloadedPath}`);
        continue;
      }

      if (earlyDownload.error && shouldRecordDownloadResult({ downloadError: earlyDownload.error })) {
        addResult({
          type: 'direct_download',
          url,
          downloadedFile: '',
          downloadedPath: '',
          downloadError: earlyDownload.error,
          pageTitle: '',
          pageUrl: url,
          alt: '',
        });
      }

      await page.waitForTimeout(CONFIG.crawlDelayMs);

      const currentPageKey = canonicalPageKey(page.url());
      seenPageKeys.add(currentPageKey);

      const pageTitle = await getPagePath(page);
      const { folder: activityFolder } = activityScopedDir(courseDir, pageTitle, page.url());
      const iframes = await collectIframesFromPage(page);
      const downloadLinks = await collectRoyalRoadsDownloadLinksFromPage(page);

      console.log(`  Page/activity: ${activityFolder}`);
      console.log(`  Highlighted csonline.royalroads.ca iframes found: ${iframes.length}`);
      console.log(`  Royal Roads image/link download candidates found: ${downloadLinks.length}`);

      const currentPageUrl = page.url();
      const downloadableLinks = downloadLinks.filter(media => {
        if (!isRoyalRoadsDownloadableUrl(media.url)) return false;
        if (isSvgUrl(media.url)) return false;
        if (isM3u8Url(media.url)) return false;
        if (isMoodlePageUrl(media.url)) return false;

        if (
          media.url.includes('/filter/kaltura/') ||
          media.url.includes('kaf.moodle.royalroads.ca')
        ) {
          return false;
        }

        if (shouldSkipCrawlUrl(media.url) && !isMediaRoyalRoadsUrl(media.url)) {
          return (
            media.url.includes('/pluginfile.php/') ||
            media.url.includes('/webservice/pluginfile.php/') ||
            media.url.includes('/draftfile.php/') ||
            media.url.includes('/mod/resource/view.php') ||
            media.url.includes('/mod/url/view.php')
          );
        }

        return true;
      });

      const downloadResults = await mapWithConcurrency(
        downloadableLinks,
        CONFIG.downloadConcurrency,
        async media => ({
          media,
          downloadResult: await downloadRoyalRoadsUrlByRequest(
            context,
            media.url,
            pageTitle,
            media.label,
            courseDir,
            currentPageUrl
          ),
        })
      );

      for (const { media, downloadResult } of downloadResults) {
        if (shouldRecordDownloadResult(downloadResult)) {
          addResult({
            type: isVideoUrl(media.url) || isLikelyVideoFilename(downloadResult.downloadedFile) ? 'direct_video' : (media.source === 'a[href]' ? 'direct_link' : 'direct_media'),
            url: media.url,
            downloadedFile: downloadResult.downloadedFile,
            downloadedPath: downloadResult.downloadedPath,
            downloadError: downloadResult.downloadError,
            pageTitle,
            pageUrl: currentPageUrl,
            alt: media.label,
          });
        }

        if (downloadResult.downloadedFile) {
          console.log(`  Downloaded: ${downloadResult.downloadedPath}`);
        }
      }

      for (let iframeIndex = 0; iframeIndex < iframes.length; iframeIndex++) {
        const iframe = iframes[iframeIndex];

        if (!isWantedIframeUrl(iframe.url)) {
          console.log(`    iframe ${iframeIndex + 1}/${iframes.length}: skipped non-target iframe: ${iframe.url}`);
          continue;
        }

        console.log(`    iframe ${iframeIndex + 1}/${iframes.length}: ${iframe.url}`);

        let youtubeUrl = '';
        let downloadedFile = '';
        let downloadedPath = '';
        let downloadError = '';
        let recordedUrl = iframe.url;
        let recordType = 'iframe';

        if (isYoutubeIframeUrl(iframe.url)) {
          youtubeUrl = extractYoutubeFromText(iframe.url);
          recordType = 'youtube';
          recordedUrl = iframe.url;

          if (youtubeUrl) {
            console.log(`      YouTube: ${youtubeUrl}`);
          } else {
            console.log('      YouTube iframe found, but video ID could not be extracted.');
          }
        } else if (isKalturaIframeUrl(iframe.url)) {
          console.log('      Checking for wrapped YouTube/external YouTube first...');
          youtubeUrl = await resolveYoutubeForIframe(context, iframe.url);

          if (youtubeUrl) {
            recordType = 'youtube';
            recordedUrl = iframe.url;
            console.log(`      YouTube: ${youtubeUrl}`);
          } else {
            console.log('      No YouTube link found. Trying direct Kaltura API/video download...');

            const downloadResult = await downloadKalturaVideo(
              context,
              iframe.url,
              pageTitle,
              iframe.alt,
              courseDir,
              page.url()
            );

            downloadedFile = downloadResult.downloadedFile;
            downloadedPath = downloadResult.downloadedPath;
            downloadError = downloadResult.downloadError;
            recordType = 'kaltura';
          }
        }

        addResult({
          type: recordType,
          url: recordedUrl,
          youtubeUrl,
          downloadedFile,
          downloadedPath,
          downloadError,
          pageTitle,
          pageUrl: page.url(),
          alt: iframe.alt,
        });

        if (downloadedFile) {
          console.log(`      Downloaded: ${downloadedPath || downloadedFile}`);
        } else if (downloadError && !IGNORABLE_DOWNLOAD_ERRORS.has(downloadError)) {
          console.log(`      Download skipped/failed: ${downloadError}`);
        }
      }

      const activitySubpageLinks = [
        ...(await collectLessonSubpageLinks(page, page.url())),
        ...(await collectBookSubpageLinks(page, page.url())),
      ];
      const newActivitySubpageLinks = [];

      for (const link of activitySubpageLinks) {
        const key = canonicalPageKey(link);

        if (!seenPageKeys.has(key) && !queue.some(existing => canonicalPageKey(existing) === key)) {
          newActivitySubpageLinks.push(link);
        }
      }

      for (const link of newActivitySubpageLinks.slice().reverse()) {
        queue.unshift(link);
      }

      if (activitySubpageLinks.length > 0) {
        const activityType = isBookUrl(page.url()) ? 'book' : 'lesson';
        console.log(
          `  Same-${activityType} subpage links found: ${activitySubpageLinks.length}; ` +
          `queued next: ${newActivitySubpageLinks.length}`
        );
      }

      // Do not enqueue general links discovered while processing activity pages. Only
      // same-lesson and same-book subpages are allowed through so Moodle activity
      // navigation can be exhausted without letting breadcrumbs, navigation widgets,
      // or related-course links pull the crawl into another course.
    } catch (error) {
      console.warn(`  Failed: ${error.message}`);
    }
  }

  if (queue.length > 0 && processed >= CONFIG.maxPages) {
    console.warn(
      `WARNING: Stopped because maxPages=${CONFIG.maxPages} was reached. ` +
      `${queue.length} URLs remained in the queue.`
    );
  }

  fs.writeFileSync(path.join(courseDir, '_processed-page-keys.txt'), [...seenPageKeys].join('\n'), 'utf8');

  const remainingQueuePath = path.join(courseDir, '_remaining-queue-when-finished.txt');
  fs.writeFileSync(remainingQueuePath, queue.join('\n'), 'utf8');

  const csvPath = path.join(courseDir, `${courseFolderName}-media.csv`);
  const jsonPath = path.join(courseDir, `${courseFolderName}-media.json`);

  const csvRows = [
    [
      'type',
      'url',
      'youtubeUrl',
      'downloadedFile',
      'downloadedPath',
      'downloadError',
      'pageTitle',
      'pageUrl',
      'alt',
      'foundAt',
    ],
    ...results.map(item => [
      item.type,
      item.url,
      item.youtubeUrl,
      item.downloadedFile,
      item.downloadedPath,
      item.downloadError,
      item.pageTitle,
      item.pageUrl,
      item.alt,
      item.foundAt,
    ]),
  ];

  fs.writeFileSync(csvPath, csvRows.map(row => row.map(csvEscape).join(',')).join('\n'), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');

  const summary = {
    startUrl,
    courseName,
    courseId,
    courseDir,
    pagesProcessed: processed,
    initialLinksFound: startLinks.length,
    remainingQueueCount: queue.length,
    records: results.length,
    youtubeLinksFound: results.filter(r => r.youtubeUrl).length,
    filesDownloaded: results.filter(r => r.downloadedFile).length,
    videoDownloadErrors: results.filter(r =>
      ['iframe', 'kaltura'].includes(r.type) &&
      !r.youtubeUrl &&
      !r.downloadedFile &&
      r.downloadError
    ).length,
    csvPath,
    jsonPath,
  };

  console.log('\nCourse done.');
  console.log(`Pages processed: ${summary.pagesProcessed}`);
  console.log(`Initial links found: ${summary.initialLinksFound}`);
  console.log(`Remaining queue count: ${summary.remainingQueueCount}`);
  console.log(`Records: ${summary.records}`);
  console.log(`YouTube links found: ${summary.youtubeLinksFound}`);
  console.log(`Files downloaded: ${summary.filesDownloaded}`);
  console.log(`Video download errors: ${summary.videoDownloadErrors}`);
  console.log(`Output folder: ${summary.courseDir}`);
  console.log(`CSV: ${summary.csvPath}`);
  console.log(`JSON: ${summary.jsonPath}`);
  console.log(`All links audit: ${path.join(courseDir, '_all-course-page-links-seen-before-processing.txt')}`);
  console.log(`Filtered initial queue audit: ${path.join(courseDir, '_initial-course-links.txt')}`);
  console.log(`Processed page audit: ${path.join(courseDir, '_processed-page-keys.txt')}`);
  console.log(`Remaining queue audit: ${remainingQueuePath}`);

  return summary;
}

async function main() {
  fs.mkdirSync(CONFIG.outputRootDir, { recursive: true });

  const courseUrls = readCourseUrls(INPUT);

  if (!courseUrls.length) {
    throw new Error(`No course URLs found in input: ${INPUT}`);
  }

  console.log(`Headless: ${HEADLESS}`);
  console.log(`Courses to process: ${courseUrls.length}`);
  console.log(`Output root: ${CONFIG.outputRootDir}`);
  console.log(`Max pages per course: ${CONFIG.maxPages}`);
  console.log(`Download concurrency: ${CONFIG.downloadConcurrency}`);

  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    permissions: [],
    args: [
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(45000);

  const batchSummaries = [];

  try {
    for (let i = 0; i < courseUrls.length; i++) {
      const startUrl = courseUrls[i];

      try {
        const summary = await crawlCourse(context, page, startUrl, i + 1, courseUrls.length);
        batchSummaries.push(summary);
      } catch (error) {
        console.warn(`\nCourse failed: ${startUrl}`);
        console.warn(error.message);

        batchSummaries.push({
          startUrl,
          courseName: '',
          courseId: getCourseIdFromUrl(startUrl),
          courseDir: '',
          pagesProcessed: 0,
          initialLinksFound: 0,
          remainingQueueCount: 0,
          records: 0,
          youtubeLinksFound: 0,
          filesDownloaded: 0,
          videoDownloadErrors: 0,
          csvPath: '',
          jsonPath: '',
          error: error.message,
        });
      }
    }
  } finally {
    await context.close();
  }

  const batchCsvPath = path.join(CONFIG.outputRootDir, 'batch-summary.csv');
  const batchJsonPath = path.join(CONFIG.outputRootDir, 'batch-summary.json');

  const batchCsvRows = [
    [
      'startUrl',
      'courseName',
      'courseId',
      'courseDir',
      'pagesProcessed',
      'initialLinksFound',
      'remainingQueueCount',
      'records',
      'youtubeLinksFound',
      'filesDownloaded',
      'videoDownloadErrors',
      'csvPath',
      'jsonPath',
      'error',
    ],
    ...batchSummaries.map(item => [
      item.startUrl,
      item.courseName,
      item.courseId,
      item.courseDir,
      item.pagesProcessed,
      item.initialLinksFound,
      item.remainingQueueCount,
      item.records,
      item.youtubeLinksFound,
      item.filesDownloaded,
      item.videoDownloadErrors,
      item.csvPath,
      item.jsonPath,
      item.error || '',
    ]),
  ];

  fs.writeFileSync(batchCsvPath, batchCsvRows.map(row => row.map(csvEscape).join(',')).join('\n'), 'utf8');
  fs.writeFileSync(batchJsonPath, JSON.stringify(batchSummaries, null, 2), 'utf8');

  console.log('\n============================================================');
  console.log('Batch done.');
  console.log(`Courses attempted: ${batchSummaries.length}`);
  console.log(`Courses failed: ${batchSummaries.filter(s => s.error).length}`);
  console.log(`Total YouTube links found: ${batchSummaries.reduce((sum, s) => sum + Number(s.youtubeLinksFound || 0), 0)}`);
  console.log(`Total files downloaded: ${batchSummaries.reduce((sum, s) => sum + Number(s.filesDownloaded || 0), 0)}`);
  console.log(`Total video download errors: ${batchSummaries.reduce((sum, s) => sum + Number(s.videoDownloadErrors || 0), 0)}`);
  console.log(`Batch CSV: ${batchCsvPath}`);
  console.log(`Batch JSON: ${batchJsonPath}`);
  console.log('============================================================');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
