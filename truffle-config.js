/**
 * DelegateDAO — Truffle configuration
 *
 * Networks:
 *   development : a Ganache instance you start yourself (`npm run ganache`) on 127.0.0.1:8545.
 *   sepolia     : public testnet. Requires MNEMONIC + SEPOLIA_RPC_URL in .env (never committed).
 *
 * `npm test` runs `truffle test --config truffle-config.test.js`, a config with no networks, so
 * Truffle starts its own throwaway Ganache and never touches :8545.
 * Do NOT run bare `truffle test` while `npm run ganache` is up: because `development` exists above,
 * Truffle 5.11.5 selects it and the suite would run against (and change) that node.
 */

require('dotenv').config();

module.exports = {
  networks: {
    development: {
      host: '127.0.0.1',
      port: 8545,
      network_id: '*',
    },

    sepolia: {
      // Lazily required: the dev network still works if this package is absent.
      provider: () => {
        const HDWalletProvider = require('@truffle/hdwallet-provider');
        const { MNEMONIC, SEPOLIA_RPC_URL } = process.env;
        if (!MNEMONIC || !SEPOLIA_RPC_URL) {
          throw new Error(
            'Missing MNEMONIC or SEPOLIA_RPC_URL. Copy .env.example to .env and fill it in.'
          );
        }
        return new HDWalletProvider({
          mnemonic: MNEMONIC,
          providerOrUrl: SEPOLIA_RPC_URL,
          addressIndex: 0,
          numberOfAddresses: 3,
        });
      },
      network_id: 11155111,
      gas: 5500000,
      confirmations: 2,
      timeoutBlocks: 200,
      skipDryRun: true,
    },
  },

  mocha: {
    timeout: 100000,
  },

  compilers: {
    solc: {
      // OpenZeppelin Contracts 5.x requires ^0.8.20.
      version: '0.8.24',
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        // "paris" avoids the PUSH0 opcode (Shanghai+), which older local
        // EVM/Ganache builds may not recognise. Safe for classroom demos.
        evmVersion: 'paris',
      },
    },
  },
};
