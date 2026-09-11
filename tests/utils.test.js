'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { apifyStub } = require('./support/module-stubs');
const {
    cleanProject, parseInput, stringifyQuery, proxyConfiguration,
} = require('../src/utils');

describe('cleanProject', () => {
    test('flattens nested fields and drops raw nested objects', () => {
        const project = {
            id: 1,
            name: 'A cool project',
            blurb: 'A short description',
            photo: { full: 'https://example.com/photo.jpg' },
            creator: {
                id: 42,
                name: 'Jane Doe',
                avatar: { medium: 'https://example.com/avatar.jpg' },
                urls: { web: { user: 'https://example.com/user/jane' } },
            },
            location: { id: 7, displayable_name: 'New York, NY' },
            category: { id: 34, name: 'Tabletop Games', slug: 'games/tabletop games' },
            urls: { web: { project: 'https://example.com/project', rewards: 'https://example.com/rewards' } },
            profile: { feature_image_attributes: { image_urls: { default: 'https://example.com/feature.jpg' } } },
            is_liked: false,
            is_disliked: null,
        };

        const cleaned = cleanProject(project);

        assert.equal(cleaned.id, 1);
        assert.equal(cleaned.title, 'A cool project');
        assert.equal(cleaned.description, 'A short description');
        assert.equal(cleaned.photo, 'https://example.com/photo.jpg');
        assert.equal(cleaned.creatorId, 42);
        assert.equal(cleaned.creatorName, 'Jane Doe');
        assert.equal(cleaned.creatorAvatar, 'https://example.com/avatar.jpg');
        assert.equal(cleaned.creatorUrl, 'https://example.com/user/jane');
        assert.equal(cleaned.locationId, 7);
        assert.equal(cleaned.locationName, 'New York, NY');
        assert.equal(cleaned.categoryId, 34);
        assert.equal(cleaned.categoryName, 'Tabletop Games');
        assert.equal(cleaned.categorySlug, 'games/tabletop games');
        assert.equal(cleaned.url, 'https://example.com/project');
        assert.equal(cleaned.rewardsUrl, 'https://example.com/rewards');
        assert.equal(cleaned.featureImage, 'https://example.com/feature.jpg');

        // raw nested objects and user-interaction flags must not leak into the output
        for (const key of ['creator', 'location', 'category', 'urls', 'profile', 'is_liked', 'is_disliked']) {
            assert.equal(Object.prototype.hasOwnProperty.call(cleaned, key), false, `expected "${key}" to be removed`);
        }
    });

    test('falls back to null when nested fields are missing', () => {
        const cleaned = cleanProject({ id: 2, name: 'Bare project', blurb: 'x' });

        for (const key of ['photo', 'creatorId', 'creatorName', 'creatorAvatar', 'creatorUrl', 'locationId', 'locationName', 'categoryId', 'categoryName', 'categorySlug', 'url', 'rewardsUrl', 'featureImage']) {
            assert.equal(cleaned[key], null, `expected "${key}" to be null`);
        }
    });
});

describe('stringifyQuery', () => {
    test('serializes scalar values as key=value', () => {
        assert.equal(stringifyQuery({ term: 'dice', sort: 'newest' }), 'term=dice&sort=newest');
    });

    test('serializes array values as repeated key[]=value pairs', () => {
        assert.equal(stringifyQuery({ state: ['live', 'upcoming'] }), 'state[]=live&state[]=upcoming');
    });

    test('URL-encodes keys and values', () => {
        assert.equal(stringifyQuery({ term: 'board & game' }), 'term=board%20%26%20game');
    });
});

describe('parseInput', () => {
    test('returns undefined when there is no input', async () => {
        assert.equal(await parseInput(undefined), undefined);
    });

    test('applies sensible defaults when no filters are set', async () => {
        const result = await parseInput({});
        assert.equal(result.sort, 'newest');
        assert.equal(result.page, 1);
        // "All" statuses must be listed explicitly, not omitted
        assert.deepEqual(result.state, ['upcoming', 'live', 'late_pledge', 'canceled', 'failed', 'successful']);
    });

    test('maps a category slug to its numeric id', async () => {
        const result = await parseInput({ category: ['games/tabletop games'] });
        assert.deepEqual(result.category_id, [34]);
    });

    test('rejects an invalid category slug', async () => {
        assert.equal(await parseInput({ category: ['not-a-real-category'] }), undefined);
    });

    test('maps status labels to Kickstarter state values', async () => {
        const result = await parseInput({ status: ['Live', 'Successful'] });
        assert.deepEqual(result.state, ['live', 'successful']);
    });

    test('rejects an invalid status', async () => {
        assert.equal(await parseInput({ status: ['not-a-status'] }), undefined);
    });

    test('rejects an invalid sort', async () => {
        assert.equal(await parseInput({ sort: 'not-a-sort' }), undefined);
    });

    test('rejects an invalid goal', async () => {
        assert.equal(await parseInput({ goal: 'not-a-goal' }), undefined);
    });

    test('passes through pledged/raised min/max and search term', async () => {
        const result = await parseInput({
            query: 'dice tower',
            pledgedMin: 100,
            pledgedMax: 1000,
            raisedMin: 50,
            raisedMax: 500,
        });
        assert.equal(result.term, 'dice tower');
        assert.equal(result.pledged_min, 100);
        assert.equal(result.pledged_max, 1000);
        assert.equal(result.raised_min, 50);
        assert.equal(result.raised_max, 500);
    });

    test('maps location input to woe_id', async () => {
        const result = await parseInput({ location: 12345 });
        assert.equal(result.woe_id, 12345);
    });

    test('ignores the "All" sentinel value for select filters', async () => {
        const result = await parseInput({ category: 'All', status: 'All' });
        assert.equal(result.category_id, undefined);
        assert.deepEqual(result.state, ['upcoming', 'live', 'late_pledge', 'canceled', 'failed', 'successful']);
    });
});

describe('proxyConfiguration', () => {
    beforeEach(() => {
        // reset to harmless defaults before every test
        apifyStub.Actor.isAtHome = () => false;
        apifyStub.Actor.createProxyConfiguration = async () => undefined;
    });

    test('throws when running on the platform without a usable proxy', async () => {
        apifyStub.Actor.isAtHome = () => true;
        apifyStub.Actor.createProxyConfiguration = async () => undefined;

        await assert.rejects(() => proxyConfiguration({ proxyConfig: {} }), /must use Apify proxy/);
    });

    test('throws when a blacklisted proxy group is used on the platform', async () => {
        apifyStub.Actor.isAtHome = () => true;
        apifyStub.Actor.createProxyConfiguration = async () => ({
            usesApifyProxy: true,
            groups: ['GOOGLESERP'],
            newUrl: () => 'http://proxy.example.com',
        });

        await assert.rejects(() => proxyConfiguration({ proxyConfig: {} }), /cannot be used in this actor/);
    });

    test('returns the configuration when everything checks out', async () => {
        apifyStub.Actor.isAtHome = () => true;
        const configuration = {
            usesApifyProxy: true,
            groups: ['RESIDENTIAL'],
            newUrl: () => 'http://proxy.example.com',
        };
        apifyStub.Actor.createProxyConfiguration = async () => configuration;

        assert.equal(await proxyConfiguration({ proxyConfig: {} }), configuration);
    });

    test('does not require a proxy when running locally', async () => {
        apifyStub.Actor.isAtHome = () => false;
        apifyStub.Actor.createProxyConfiguration = async () => undefined;

        assert.equal(await proxyConfiguration({ proxyConfig: {}, force: false }), undefined);
    });
});
