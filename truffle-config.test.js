/**
 * DelegateDAO — Truffle configuration for `npm test` only.
 *
 * Same compiler and mocha settings as truffle-config.js (reused, not copied), but NO networks.
 *
 * Why: when truffle-config.js defines a `development` network, `truffle test` without --network
 * picks it (Truffle 5.11.5, build/6394.bundled.js:160-163) and runs the suite against whatever
 * listens on 127.0.0.1:8545 — i.e. your `npm run ganache`. With no networks at all, Truffle starts
 * its own throwaway Ganache on a random port, so the tests never touch :8545.
 */

const base = require('./truffle-config.js');

module.exports = { ...base, networks: {} };
