'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { apifyStub, crawleeStub } = require('./support/module-stubs');
const { handlePagination } = require('../src/routes');
const { PROJECTS_PER_PAGE, MAX_PAGES, MAX_INCOMPLETE_PAGES_STREAK } = require('../src/consts');

function makeProjects(startId, count) {
    return Array.from({ length: count }, (_, i) => ({
        id: startId + i,
        name: `Project ${startId + i}`,
        blurb: 'blurb',
    }));
}

function makeResponse({ statusCode = 200, body }) {
    return {
        status: () => statusCode,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

function makeContext({ url, userData, response }) {
    return {
        request: { url, userData },
        page: { goto: () => Promise.resolve(response) },
    };
}

function baseUserData(overrides = {}) {
    return {
        page: 1,
        totalProjects: 0,
        savedProjects: 0,
        maximumResults: 1000,
        savedProjectIds: [],
        incompletePagesStreak: 0,
        ...overrides,
    };
}

describe('handlePagination', () => {
    let pushedBatches;
    let queuedRequests;

    beforeEach(() => {
        pushedBatches = [];
        queuedRequests = [];
        apifyStub.Actor.pushData = async (items) => { pushedBatches.push(items); };
        crawleeStub.log.info = () => {};
        crawleeStub.log.warning = () => {};
        crawleeStub.log.error = () => {};
    });

    function makeRequestQueue() {
        return { addRequest: async (req) => { queuedRequests.push(req); } };
    }

    test('saves a full page of projects and enqueues the next page', async () => {
        const projects = makeProjects(1, PROJECTS_PER_PAGE);
        const response = makeResponse({
            body: { total_hits: PROJECTS_PER_PAGE * 3, has_more: true, projects },
        });
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData(),
            response,
        });
        const requestQueue = makeRequestQueue();

        await handlePagination(context, requestQueue);

        assert.equal(pushedBatches.length, 1);
        assert.equal(pushedBatches[0].length, PROJECTS_PER_PAGE);
        assert.deepEqual(pushedBatches[0].map((p) => p.id), projects.map((p) => p.id));

        assert.equal(queuedRequests.length, 1);
        assert.equal(queuedRequests[0].url, 'https://www.kickstarter.com/discover/advanced.json?page=2');
        assert.equal(queuedRequests[0].userData.page, 2);
        assert.equal(queuedRequests[0].userData.savedProjects, PROJECTS_PER_PAGE);
        assert.equal(queuedRequests[0].userData.totalProjects, PROJECTS_PER_PAGE * 3);
        assert.equal(queuedRequests[0].userData.incompletePagesStreak, 0);
    });

    test('does not re-save projects already collected on a previous page', async () => {
        const alreadySaved = makeProjects(1, PROJECTS_PER_PAGE);
        const newProject = { id: 999, name: 'New project', blurb: 'blurb' };
        const response = makeResponse({
            body: { has_more: true, projects: [...alreadySaved, newProject] },
        });
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=2',
            userData: baseUserData({
                page: 2,
                savedProjects: PROJECTS_PER_PAGE,
                totalProjects: PROJECTS_PER_PAGE * 5,
                savedProjectIds: alreadySaved.map((p) => p.id),
            }),
            response,
        });
        const requestQueue = makeRequestQueue();

        await handlePagination(context, requestQueue);

        assert.equal(pushedBatches[0].length, 1);
        assert.equal(pushedBatches[0][0].id, 999);
        assert.equal(queuedRequests[0].userData.savedProjects, PROJECTS_PER_PAGE + 1);
        assert.equal(queuedRequests[0].userData.savedProjectIds.length, PROJECTS_PER_PAGE + 1);
    });

    test("stops paginating once Kickstarter's hard page limit is reached", async () => {
        const response = makeResponse({
            body: { total_hits: 100000, has_more: true, projects: makeProjects(1, PROJECTS_PER_PAGE) },
        });
        const context = makeContext({
            url: `https://www.kickstarter.com/discover/advanced.json?page=${MAX_PAGES}`,
            userData: baseUserData({ page: MAX_PAGES, savedProjects: 500, totalProjects: 100000 }),
            response,
        });
        const requestQueue = makeRequestQueue();

        let loggedLimitMessage = false;
        crawleeStub.log.info = (msg) => {
            if (typeof msg === 'string' && msg.includes("Reached Kickstarter's limit")) loggedLimitMessage = true;
        };

        await handlePagination(context, requestQueue);

        assert.equal(queuedRequests.length, 0);
        assert.equal(loggedLimitMessage, true);
    });

    test('stops after enough consecutive incomplete pages near the end of the result set', async () => {
        // totalProjects = PROJECTS_PER_PAGE -> lastPage = 1, so page 1 counts as "near the last page"
        const response = makeResponse({
            body: { has_more: true, projects: [{ id: 5000, name: 'Lone project', blurb: 'x' }] },
        });
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData({
                totalProjects: PROJECTS_PER_PAGE,
                incompletePagesStreak: MAX_INCOMPLETE_PAGES_STREAK - 1,
            }),
            response,
        });
        const requestQueue = makeRequestQueue();

        let loggedStopMessage = false;
        crawleeStub.log.info = (msg) => {
            if (typeof msg === 'string' && msg.includes('Stopping pagination')) loggedStopMessage = true;
        };

        await handlePagination(context, requestQueue);

        assert.equal(queuedRequests.length, 0);
        assert.equal(loggedStopMessage, true);
    });

    test('stops once the requested number of results has been saved', async () => {
        const response = makeResponse({
            body: { total_hits: 100000, has_more: true, projects: makeProjects(1, PROJECTS_PER_PAGE) },
        });
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData({ maximumResults: PROJECTS_PER_PAGE }),
            response,
        });
        const requestQueue = makeRequestQueue();

        await handlePagination(context, requestQueue);

        assert.equal(queuedRequests.length, 0);
    });

    // Regression guard for the "Could not resolve seed" outage: the actor used to require a
    // separate first request to scrape a CSRF `data-seed` token out of the discover page's HTML
    // (via a `getToken`/`handleStart` step) before it could fetch any results. That approach broke
    // when Kickstarter changed its markup. handlePagination must be able to go straight from a
    // single JSON response to saved output, with no dependency on any token/seed/cookie value.
    test('does not depend on any token/seed/cookie value to process a page', async () => {
        const response = makeResponse({
            body: { total_hits: 1, has_more: false, projects: [{ id: 1, name: 'Solo', blurb: 'x' }] },
        });
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData({ maximumResults: 10 }), // no seed/token/cookies field present
            response,
        });
        const requestQueue = makeRequestQueue();

        await handlePagination(context, requestQueue);

        assert.equal(pushedBatches.length, 1);
        assert.equal(pushedBatches[0].length, 1);
    });

    test('throws a retryable error when the response is not valid JSON', async () => {
        const response = {
            status: () => 200,
            json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
            text: () => Promise.resolve('<html>just a moment...</html>'),
        };
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData(),
            response,
        });
        const requestQueue = makeRequestQueue();

        await assert.rejects(() => handlePagination(context, requestQueue), /Will retry/);
    });

    test('throws a retryable error when the response JSON has an unexpected shape', async () => {
        const response = makeResponse({ body: { total_hits: 5 } }); // missing "projects"
        const context = makeContext({
            url: 'https://www.kickstarter.com/discover/advanced.json?page=1',
            userData: baseUserData(),
            response,
        });
        const requestQueue = makeRequestQueue();

        await assert.rejects(() => handlePagination(context, requestQueue), /Will retry/);
    });
});
