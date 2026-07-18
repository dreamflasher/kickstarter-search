const { Actor } = require('apify');
const { BasicCrawler, log } = require('crawlee');

const { parseInput, proxyConfiguration, stringifyQuery } = require('./src/utils');
const { BASE_URL, PROJECTS_PER_PAGE } = require('./src/consts');
const { handleStart, handlePagination } = require('./src/routes');

Actor.main(async () => {
    const requestQueue = await Actor.openRequestQueue();
    const input = await Actor.getInput();
    // GETTING PARAMS FROM THE INPUT
    const queryParameters = await parseInput(input);
    let { maxResults } = input;
    const { proxyConfig } = input;

    const proxy = await proxyConfiguration({ proxyConfig });
    if (!maxResults) maxResults = 200 * PROJECTS_PER_PAGE;
    const params = stringifyQuery(queryParameters);
    const firstUrl = `${BASE_URL}${params}`;
    // ADDING TO THE QUEUE FIRST PAGE TO GET TOKEN
    await requestQueue.addRequest({
        url: firstUrl,
        uniqueKey: 'START',
        userData: {
            page: 1,
            label: 'START',
            searchResults: [],
            itemsToSave: [],
            savedItems: 0,
            maxResults,
        },
    });
    // CRAWLER
    const crawler = new BasicCrawler({
        requestQueue,
        ...(proxy ? { proxyConfiguration: proxy } : {}),
        maxConcurrency: 1,
        useSessionPool: true,
        maxRequestRetries: 1000,
        requestHandler: async (context) => {
            const { request: { url, userData: { label } } } = context;
            log.info('Page opened.', { label, url });
            // eslint-disable-next-line default-case
            switch (label) {
                case 'START':
                    return handleStart(context, queryParameters, requestQueue, maxResults);
                case 'PAGINATION-LIST':
                    return handlePagination(context, requestQueue);
            }
        },
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
