# RRU Playwright Course Media Crawler

## What this repository does

This repository contains a Playwright-based Node.js crawler for Royal Roads University Moodle courses. Its purpose is to visit RRU course pages, inspect the visible activities and selected activity subpages, and produce a structured inventory of course media and downloadable assets.

The crawler is designed to:

- authenticate to `csonline.royalroads.ca` using `RRU_USERNAME` and `RRU_PASSWORD` environment variables;
- crawl Moodle course/activity pages from either a single course URL or a CSV/list of course URLs;
- identify YouTube videos, including YouTube videos embedded through Kaltura wrappers;
- download eligible Royal Roads-hosted files and media from `csonline.royalroads.ca` and `media.royalroads.ca`;
- attempt direct Kaltura video downloads only when a Kaltura iframe does not resolve to a YouTube link;
- skip HLS `.m3u8` playlists and other non-useful responses such as HTML pages and SVG files;
- write per-course CSV/JSON media inventories plus audit files; and
- write batch-level summary CSV/JSON files after all requested courses are attempted.

## How it works

The main script is `rru-kaltura-youtube-crawler-batch.js`. It accepts either a single course URL or a file containing course URLs. When a file is provided, the script extracts unique Moodle course URLs matching `https://csonline.royalroads.ca/moodle/course/view.php?...` and processes them one course at a time.

Typical batch run:

```bash
RRU_USERNAME="your-username" \
RRU_PASSWORD="your-password" \
node rru-kaltura-youtube-crawler-batch.js RRU_course_list.csv --output "./output"
```

Useful options:

```bash
--headed                    Run the browser visibly for debugging.
--output "./output"          Set the output root directory.
--max-pages 2000            Set the maximum number of pages per course.
--download-concurrency 4    Set concurrent download requests per page.
```

For each course, the crawler:

1. opens the course page in a persistent Chromium profile at `rru-browser-profile`;
2. logs in automatically when username/password environment variables are supplied and a login page is detected;
3. expands the course page when possible so visible activity links can be collected;
4. builds a filtered crawl queue from Moodle activity URLs such as pages, lessons, books, resources, URLs, folders, assignments, forums, quizzes, glossaries, choices, SCORM pages, and the course page itself;
5. processes each queued page up to the configured per-course limit;
6. downloads eligible Royal Roads-hosted image/file/link assets into numbered activity folders;
7. inspects targeted iframes for YouTube, Kaltura, and Royal Roads-hosted media;
8. resolves Kaltura-wrapped YouTube links before attempting Kaltura API/direct video downloads;
9. follows same-lesson and same-book subpages so multi-page Moodle activities are exhausted without letting global navigation pull the crawl into unrelated courses; and
10. writes course-level media records, audit files, and a course summary.

Outputs are written under the configured output directory. Each course gets its own folder named from the course title and course ID. Course folders include media CSV/JSON files, downloaded assets organized by activity, and audit files such as the initial crawl queue, processed page keys, remaining queue, and all course links seen before processing. The batch run also writes `batch-summary.csv` and `batch-summary.json` at the output root.

## Intended handoff use

The intent of this repository is batch processing across all courses listed in `RRU_course_list.csv`. That file is the handoff input list of RRU Moodle course URLs. Running the main script with `RRU_course_list.csv` should attempt every listed course in sequence, collect/download the media it can access, keep going when an individual course fails, and summarize the overall run in the batch summary outputs.
