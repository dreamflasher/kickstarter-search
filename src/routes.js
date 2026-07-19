const { Actor } = require('apify');
const { log, sleep } = require('crawlee');

const { cleanProject, notifyAboutMaxResults } = require('./utils');
const {
    MAX_PAGES, MAX_INCOMPLETE_PAGES_STREAK, MIN_REQUEST_DELAY_MS, MAX_REQUEST_DELAY_MS, PROJECTS_PER_PAGE,
} = require('./consts');

exports.handlePagination = async ({ request, page: browserPage }, requestQueue) => {
    let { page, totalProjects, savedProjects, incompletePagesStreak } = request.userData;
    const { maximumResults, savedProjectIds } = request.userData;

    log.info('Page opened.', { page, url: request.url });

    // JITTERED DELAY BEFORE EACH REQUEST, TO AVOID TRIPPING RATE-BASED BLOCKS
    await sleep(MIN_REQUEST_DELAY_MS + Math.random() * (MAX_REQUEST_DELAY_MS - MIN_REQUEST_DELAY_MS));

    // NAVIGATING DIRECTLY TO THE JSON ENDPOINT - A REAL BROWSER HANDLES COOKIES/JS CHALLENGES ITSELF
    const response = await browserPage.goto(request.url);
    const statusCode = response?.status();
    if (statusCode !== 200) log.warning(`Page ${page}: Response status ${statusCode}.`);

    let body;
    try {
        body = await response.json();
    } catch (e) {
        const bodySnippet = await response.text().then((t) => t.slice(0, 500)).catch(() => '');
        log.error(`Page ${page}: Unexpected response (status ${statusCode}). Body snippet: ${bodySnippet}`);
        throw new Error(`The page didn't load as expected (status ${statusCode}). Will retry...`);
    }

    // ON THE FIRST PAGE WE ARE CHECKING IF WE REACHED THE LIMIT
    if (page === 1 && typeof body?.total_hits === 'number') {
        log.info(`Page ${page}: Found ${body.total_hits} projects in total.`);
        // If kickstarter contains more then 2400 results for current query, notify user
        // that he will not have all results and that he needs to refine his query.
        if (body.total_hits > maximumResults) notifyAboutMaxResults(body.total_hits, maximumResults);
        totalProjects = Math.min(body.total_hits, maximumResults);
    }
    // ARRAY OF THE PROJECTS FROM THE PAGE
    log.info(`Number of  saved projects: ${savedProjects}`);
    let projectsToSave;
    try {
        projectsToSave = body.projects.slice(0, maximumResults - savedProjects)
            .map(cleanProject);
    } catch (e) {
        log.error(`Page ${page}: Unexpected response shape (status ${statusCode}).`);
        throw new Error(`The page didn't load as expected (status ${statusCode}). Will retry...`);
    }

    // SAVING NEEDED NUMBER OF ITEMS
    let newProjectsCount = 0;
    if (projectsToSave.length > 0) {
        const newProjects = projectsToSave.filter((c) => !savedProjectIds.includes(c.id));
        newProjects.forEach((project) => {
            savedProjectIds.push(project.id);
        });

        await Actor.pushData(newProjects);
        log.info(`Page ${page}: Saved ${newProjects.length} projects.`);
        if (newProjects.length !== projectsToSave.length) {
            log.info(`Found ${projectsToSave.length - newProjects.length} duplicates in the request.`);
        }

        savedProjects += newProjects.length;
        newProjectsCount = newProjects.length;
    }

    // Kickstarter can keep reporting has_more=true even though it has no more new projects left to give
    // (e.g. once near the end of the result set). Track consecutive short pages and give up after a few.
    incompletePagesStreak = newProjectsCount >= PROJECTS_PER_PAGE ? 0 : incompletePagesStreak + 1;
    if (incompletePagesStreak >= MAX_INCOMPLETE_PAGES_STREAK) {
        log.info(`Page ${page}: Stopping pagination, ${incompletePagesStreak} consecutive pages without a full page of new projects.`);
        return;
    }

    // FLAG FROM JSON
    const hasMoreResults = body.has_more;
    if (hasMoreResults && savedProjects < totalProjects) {
        // Kickstarter hard-caps this endpoint at MAX_PAGES pages (returns 404 beyond it), regardless
        // of savedProjects vs totalProjects - duplicate/undercounted pages can leave savedProjects
        // short of totalProjects even after the last real page, so this must be checked separately.
        if (page >= MAX_PAGES) {
            log.info(`Page ${page}: Reached Kickstarter's limit of ${MAX_PAGES} pages, stopping.`);
            return;
        }
        page++;
        // UPDATING IN THE CURRENT LINK PAGE NUMBER AND ADDING IT TO THE QUEUE
        const nextPage = request.url.replace(request.url.match(/page=([0-9.]+)/)[0], `page=${page}`);
        // ADDING TO THE QUEUE
        await requestQueue.addRequest({
            url: nextPage,
            uniqueKey: `PAGINATION-LIST-page-${page}`,
            userData: {
                page,
                savedProjects,
                maximumResults,
                totalProjects,
                savedProjectIds,
                incompletePagesStreak,
            },
        });
    }
};
