const { Actor } = require('apify');
const { PlaywrightCrawler, log } = require('crawlee');
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(stealthPlugin());

const { parseInput, proxyConfiguration, stringifyQuery } = require('./src/utils');
const { BASE_URL, PROJECTS_PER_PAGE, MAX_PAGES } = require('./src/consts');
const { handlePagination } = require('./src/routes');

Actor.main(async () => {
    const requestQueue = await Actor.openRequestQueue();
    const input = await Actor.getInput();
    // GETTING PARAMS FROM THE INPUT
    const queryParameters = await parseInput(input);
    let { maxResults } = input;
    const { proxyConfig } = input;

    const proxy = await proxyConfiguration({ proxyConfig });
    if (!maxResults) maxResults = 200 * PROJECTS_PER_PAGE;
    const maximumResults = Math.min(maxResults, MAX_PAGES * PROJECTS_PER_PAGE);
    const params = stringifyQuery(queryParameters);
    const firstUrl = `${BASE_URL}${params}`;
    // ADDING TO THE QUEUE FIRST PAGE
    await requestQueue.addRequest({
        url: firstUrl,
        uniqueKey: 'PAGINATION-LIST-page-1',
        userData: {
            page: 1,
            totalProjects: 0,
            savedProjects: 0,
            maximumResults,
            savedProjectIds: [],
            incompletePagesStreak: 0,
        },
    });
    // CRAWLER
    const crawler = new PlaywrightCrawler({
        requestQueue,
        launchContext: {
            launcher: chromium,
            launchOptions: {
                // Docker's default /dev/shm is too small for Chromium and causes crashes.
                // --disable-gpu isn't needed for GPU rendering in headless mode, so it's dropped here.
                args: ['--disable-dev-shm-usage', '--disable-gpu'],
            },
        },
        ...(proxy ? { proxyConfiguration: proxy } : {}),
        maxConcurrency: 1,
        useSessionPool: true,
        persistCookiesPerSession: true,
        // Crawlee's built-in detection for known bot-protection pages (incl. Cloudflare) - retires
        // the session and retries instead of us having to hand-roll block detection ourselves.
        retryOnBlocked: true,
        maxRequestRetries: 1000,
        requestHandler: (context) => handlePagination(context, requestQueue),
        failedRequestHandler: async ({
            request,
            error,
        }) => {
            log.error(`Request ${request.url} failed repeatedly, running out of retries (Error: ${error.message})`);
        },
    });
    log.info('Starting crawler');
    await crawler.run();
    log.info('Crawler finished');
});
