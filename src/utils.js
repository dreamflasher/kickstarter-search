const Apify = require('apify');
const moment = require('moment');
const cheerio = require('cheerio');

const { EMPTY_SELECT, LOCATION_SEARCH_ACTOR_ID, DEFAULT_SORT_ORDER, DATE_FORMAT, AGG_FIELDS } = require('./consts');
const { statuses, states, categories, goals, sorts } = require('./filters');

const { utils: { log, requestAsBrowser } } = Apify;

// 1. FUNCTION TO REMOVE NO NEED KEYS FROM THE ITEM OBJECT
function cleanProject(project) {
    const cleanedProject = {
        ...project,
        photo: project.photo?.full ?? null,
        creatorId: project.creator?.id ?? null,
        creatorName: project.creator?.name ?? null,
        creatorAvatar: project.creator?.avatar?.medium ?? null,
        creatorUrl: project.creator?.urls?.web?.user ?? null,
        locationId: project.location?.id ?? null,
        locationName: project.location?.displayable_name ?? null,
        categoryId: project.category?.id ?? null,
        categoryName: project.category?.name ?? null,
        categorySlug: project.category?.slug ?? null,
        url: project.urls?.web?.project ?? null,
        rewardsUrl: project.urls?.web?.rewards ?? null,
        featureImage: project.profile?.feature_image_attributes?.image_urls?.default ?? null,
        title: project.name,
        description: project.blurb,
        link: project.urls?.web?.project ?? null,
        pubDate: moment.unix(project.launched_at).format(DATE_FORMAT),
        created_at_formatted: moment.unix(project.created_at).format(DATE_FORMAT),
        launched_at_formatted: moment.unix(project.launched_at).format(DATE_FORMAT),
    };

    delete cleanedProject.creator;
    delete cleanedProject.location;
    delete cleanedProject.category;
    delete cleanedProject.urls;
    delete cleanedProject.profile;

    return cleanedProject;
}

// 2. DEALING WITH LOCATION FROM THE INPUT - CALLING ANOTHER ACTOR
async function processLocation(location) {
    log.info(`Quering kickstarter for location ID of "${location}"...`);
    // CALLING SEPARATE ACTOR TO GET ID OF THE LOCATION
    const run = await Apify.call(LOCATION_SEARCH_ACTOR_ID, { query: location });
    if (run.status !== 'SUCCEEDED') {
        log.warning(`Actor ${LOCATION_SEARCH_ACTOR_ID} did not finish correctly. Please check your "location" field in the input, and try again.`);
        return;
    }
    // GETTING LOCATIONS
    const { locations } = run.output.body;
    if (!locations.length) {
        log.warning(`Location "${location}" was not found. Please check your "location" field in the input, and try again.`);
        return;
    }
    // GETTING ONLY THE FIRST ONE
    log.info(`Location found, woe_id is - ${locations[0].id}`);
    return locations[0].id;
}

// 3. CHECKING THE INPUT
async function parseInput(input) {
    if (!input) {
        log.warning('Key-value store does not contain INPUT. Actor will be stopped.');
        return;
    }
    const queryParams = {
    };

    // FILTER OUT EMPTY FILTER VALUES
    const filledInFilters = {};
    Object.keys(input).forEach((key) => {
        const filterValue = (typeof (input[key]) === 'string') ? input[key].trim() : input[key];
        if (!filterValue || filterValue === EMPTY_SELECT) return;
        if (Array.isArray(filterValue) && filterValue.length === 0) return;
        filledInFilters[key] = filterValue;
    });

    // process search term
    if (filledInFilters.query) queryParams.term = filledInFilters.query;

    // process category
    if (filledInFilters.category) {
        const fromInputLowerCase = filledInFilters.category.toLowerCase();
        const foundCategories = categories.filter((category) => {
            return fromInputLowerCase.category === category.id || fromInputLowerCase === category.slug.toLowerCase();
        });

        if (!foundCategories.length) {
            log.warning(`Input parameter "category" contains invalid value: "${filledInFilters.category}".\n
            Please check the input. Actor will be stopped`);
            return;
        }
        queryParams.category_id = [foundCategories[0].id];
    }

    // process status
    if (filledInFilters.status) {
        const selectedStates = filledInFilters.status.map((status) => statuses[status]);
        if (selectedStates.includes(undefined)) {
            log.warning(`Input parameter "status" contains invalid value: "${filledInFilters.status}".\n
            Please check the input. Actor will be stopped.`);
            return;
        }
        queryParams.state = selectedStates;
    } else {
        // Kickstarter now requires every state to be listed explicitly to mean "All"
        queryParams.state = states;
    }

    // process pledged min/max
    if (filledInFilters.pledgedMin) queryParams.pledged_min = filledInFilters.pledgedMin;
    if (filledInFilters.pledgedMax) queryParams.pledged_max = filledInFilters.pledgedMax;

    // process goal
    if (filledInFilters.goal) {
        const goal = goals.indexOf(filledInFilters.goal.toLowerCase());
        if (goal === -1) {
            log.warning(`Input parameter goal contains invalid value: "${filledInFilters.goal}". Please check the input. Actor will be stopped.`);
            return;
        }
        queryParams.goal = goal;
    }

    // process raised min/max
    if (filledInFilters.raisedMin) queryParams.raised_min = filledInFilters.raisedMin;
    if (filledInFilters.raisedMax) queryParams.raised_max = filledInFilters.raisedMax;

    // process sort
    if (filledInFilters.sort) {
        const sort = sorts.indexOf(filledInFilters.sort.toLowerCase());
        if (sort === -1) {
            log.warning(`Input parameter "sort" contains invalid value: "${filledInFilters.sort}". Please check the input. Actor will be stopped`);
            return;
        }
        queryParams.sort = filledInFilters.sort.toLowerCase();
    } else {
        queryParams.sort = DEFAULT_SORT_ORDER;
    }

    if (filledInFilters.location) queryParams.woe_id = filledInFilters.location;

    queryParams.agg_fields = AGG_FIELDS;
    queryParams.page = 1;

    return queryParams;
}

// 3b. SERIALIZE QUERY PARAMS THE WAY KICKSTARTER'S discover/advanced.json EXPECTS
// (array values become repeated `key[]=value` pairs instead of querystring's `key=value&key=value`)
function stringifyQuery(params) {
    const parts = [];
    Object.keys(params).forEach((key) => {
        const value = params[key];
        if (Array.isArray(value)) {
            value.forEach((item) => parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(item)}`));
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
    });
    return parts.join('&');
}

// 4. FIRST REQUEST => GETTING TOKEN AND COOKIES. THERE ARE A LOT OF BLOCKS WITHOUT IT.
async function getToken(url, session, proxyConfiguration) {
    const proxyUrl = proxyConfiguration.newUrl(session.id);
    // Query the url and load csrf token from it
    const html = await requestAsBrowser({
        url,
        proxyUrl,
    });

    const { statusCode, isCloudflare, bodySnippet } = describeResponse(html);
    if (statusCode !== 200 || isCloudflare) {
        log.warning(`getToken: Unexpected response for ${url} (status ${statusCode}${isCloudflare ? ', looks like a Cloudflare challenge/block' : ''}). Body snippet: ${bodySnippet}`);
    } else {
        log.info(`getToken: Loaded ${url} (status ${statusCode}).`);
    }

    const $ = cheerio.load(html.body);
    const cookies = (html.headers['set-cookie'] || []).map((s) => s.split(';', 2)[0]).join('; ');

    return {
        cookies,
    };
}

// 4b. DIAGNOSTIC HELPER: SUMMARIZE A RESPONSE FOR LOGGING (STATUS CODE, BODY SNIPPET, CLOUDFLARE GUESS)
function describeResponse({ statusCode, headers, body } = {}) {
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const isCloudflare = headers?.server === 'cloudflare'
        || Boolean(headers?.['cf-mitigated'])
        || Boolean(headers?.['cf-ray'])
        || /just a moment|attention required|checking your browser/i.test(bodyText);

    return {
        statusCode,
        isCloudflare,
        bodySnippet: bodyText.slice(0, 500),
    };
}

// 5. FUNCTION TO INFORM ABOUT THE ITEM LIMIT
/**
 * Kickstarter has limit of 200 pages (2400 projects) for a search
 * this functions outputs explanation of this to console.
 * @param {Number} foundProjects How many projects were found
 * @param {Number} limit How many projects does kickstarter allow
 * @return {Void}
 */
function notifyAboutMaxResults(foundProjects, limit) {
    log.info('|');
    log.info(`| Found ${foundProjects} projects in total.`);
    log.info(`| Will be output: ${limit} projects.`);
    log.info('| ');
    log.info('|');
}

const proxyConfiguration = async ({
    proxyConfig,
    required = true,
    force = Apify.isAtHome(),
    blacklist = ['GOOGLESERP'],
    hint = [],
}) => {
    const configuration = await Apify.createProxyConfiguration(proxyConfig);

    // this works for custom proxyUrls
    if (Apify.isAtHome() && required) {
        if (!configuration || (!configuration.usesApifyProxy && (!configuration.proxyUrls || !configuration.proxyUrls.length)) || !configuration.newUrl()) {
            throw new Error('\n=======\nYou must use Apify proxy or custom proxy URLs\n\n=======');
        }
    }

    // check when running on the platform by default
    if (force) {
        // only when actually using Apify proxy it needs to be checked for the groups
        if (configuration && configuration.usesApifyProxy) {
            if (blacklist.some((blacklisted) => (configuration.groups || []).includes(blacklisted))) {
                throw new Error(`\n=======\nThese proxy groups cannot be used in this actor. Choose other group or contact support@apify.com to give you proxy trial:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
            }

            // specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
            if (hint.length && !hint.some((group) => (configuration.groups || []).includes(group))) {
                Apify.utils.log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
            }
        }
    }

    return configuration;
};

module.exports = {
    cleanProject,
    parseInput,
    getToken,
    notifyAboutMaxResults,
    proxyConfiguration,
    stringifyQuery,
    describeResponse,
};
