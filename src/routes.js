const Apify = require('apify');

const { utils: { log, requestAsBrowser } } = Apify;

const { cleanProject, getToken, notifyAboutMaxResults, stringifyQuery, describeResponse } = require('./utils');
const { BASE_URL, MAX_PAGES, PROJECTS_PER_PAGE, MAX_INCOMPLETE_PAGES_STREAK } = require('./consts');

exports.handleStart = async ({ request, session }, query, requestQueue, proxyConfig, maxResults) => {
    // on this phase - getting TOKEN AND COOKIES
    const { cookies } = await getToken(request.url, session, proxyConfig);

    const page = 1;
    const totalProjects = 0;
    const savedProjects = 0;
    const maximumResults = Math.min(maxResults, MAX_PAGES * PROJECTS_PER_PAGE);
    const savedProjectIds = [];
    const incompletePagesStreak = 0;

    const params = stringifyQuery({
        ...query,
        page
    });
    const listUrl = `${BASE_URL}${params}`;

    // ADDING TO THE QUEUE FIRST PAGINATION PAGE WITH JSON
    // uniqueKey is set explicitly because this URL is identical to the START request's URL
    // (page 1 with no distinguishing params) - without it the queue would dedupe it away.
    await requestQueue.addRequest({
        url: listUrl,
        uniqueKey: `PAGINATION-LIST-page-${page}`,
        userData: {
            cookies,
            page,
            label: 'PAGINATION-LIST',
            totalProjects,
            savedProjects,
            maximumResults,
            savedProjectIds,
            incompletePagesStreak,
        },
    });
};

exports.handlePagination = async ({ request, session }, requestQueue, proxyConfiguration) => {
    let { page, totalProjects, savedProjects, incompletePagesStreak } = request.userData;
    const { cookies, maximumResults, savedProjectIds } = request.userData;

    // MAKING REQUEST => JSON OBJECT IN RESPONSE
    const response = await requestAsBrowser({
        url: request.url,
        proxyUrl: proxyConfiguration.newUrl(session.id),
        headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: cookies,
        },
        responseType: 'json',
    });
    const { body, statusCode } = response;
    if (statusCode !== 200) log.warning(`Page ${page}: Response status ${statusCode}.`);

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
        const { isCloudflare, bodySnippet } = describeResponse(response);
        log.error(`Page ${page}: Unexpected response (status ${statusCode}${isCloudflare ? ', looks like a Cloudflare challenge/block' : ''}). Body snippet: ${bodySnippet}`);
        throw new Error(`The page didn't load as expected (status ${statusCode}${isCloudflare ? ', Cloudflare block suspected' : ''}). Will retry...`);
    }

    // SAVING NEEDED NUMBER OF ITEMS
    let newProjectsCount = 0;
    if (projectsToSave.length > 0) {
        const newProjects = projectsToSave.filter((c) => !savedProjectIds.includes(c.id));
        newProjects.forEach((project) => {
            savedProjectIds.push(project.id);
        });

        await Apify.pushData(newProjects);
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
        page++;
        // UPDATING IN THE CURRENT LINK PAGE NUMBER AND ADDING IT TO THE QUEUE
        const nextPage = request.url.replace(request.url.match(/page=([0-9.]+)/)[0], `page=${page}`);
        // ADDING TO THE QUEUE
        await requestQueue.addRequest({
            url: nextPage,
            uniqueKey: `PAGINATION-LIST-page-${page}`,
            userData: {
                label: 'PAGINATION-LIST',
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
