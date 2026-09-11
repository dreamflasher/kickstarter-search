'use strict';

// Lightweight stand-ins for the `apify` and `crawlee` packages, used so the unit tests can run
// with zero external dependencies (no test framework or mocking library needs to be installed).
// Uses Node's built-in test runner (`node:test`) and patches the CommonJS loader so that
// `require('apify')` / `require('crawlee')` resolve to these stub objects instead of hitting
// the filesystem. Tests mutate the methods on `apifyStub.Actor` / `crawleeStub.log` directly
// (e.g. via `t.mock.fn(...)`) to control behaviour and assert on calls.
//
// This file must be required before the module under test (e.g. `../../src/utils`) so the
// patch is in place before that module's own top-level `require('apify')` runs. Node's test
// runner executes each test file in its own process, so the patch only needs to be applied
// once per test file.

const Module = require('module');

const apifyStub = {
    Actor: {
        isAtHome: () => false,
        createProxyConfiguration: async () => undefined,
        call: async () => { throw new Error('Actor.call is not stubbed for this test'); },
        pushData: async () => {},
    },
};

const crawleeStub = {
    log: {
        info: () => {},
        warning: () => {},
        error: () => {},
        debug: () => {},
    },
    sleep: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'apify') return apifyStub;
    if (request === 'crawlee') return crawleeStub;
    return originalLoad.call(this, request, parent, isMain);
};

module.exports = { apifyStub, crawleeStub };
