const DATE_FORMAT = 'ddd, DD MMM YYYY HH:mm:ss ZZ';
const EMPTY_SELECT = 'All';
const LOCATION_SEARCH_ACTOR_ID = 'jaroslavhejlek~kickstarter-location-to-ids';
const BASE_URL = 'https://www.kickstarter.com/discover/advanced.json?';
const DEFAULT_SORT_ORDER = 'newest';
const PROJECTS_PER_PAGE = 12;
const MAX_PAGES = 200;
// Kickstarter's front-end always requests aggregate counts for these fields
const AGG_FIELDS = 'state,category_id';
// Stop pagination once this many consecutive pages fail to return a full page of new projects
// (guards against Kickstarter's has_more flag staying true forever near the end of the result set)
const MAX_INCOMPLETE_PAGES_STREAK = 3;
// Jittered delay applied before each page request, to avoid tripping rate-based blocks
const MIN_REQUEST_DELAY_MS = 0;
const MAX_REQUEST_DELAY_MS = 0;

module.exports = {
    EMPTY_SELECT,
    BASE_URL,
    LOCATION_SEARCH_ACTOR_ID,
    DEFAULT_SORT_ORDER,
    PROJECTS_PER_PAGE,
    MAX_PAGES,
    DATE_FORMAT,
    AGG_FIELDS,
    MAX_INCOMPLETE_PAGES_STREAK,
    MIN_REQUEST_DELAY_MS,
    MAX_REQUEST_DELAY_MS,
};
