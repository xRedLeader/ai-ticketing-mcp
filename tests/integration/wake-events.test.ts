import { registerWakeContractTests } from '../../src/testing/wake-contracts.js';
import { adapters } from './helpers.js';
registerWakeContractTests('PostgreSQL', async () => {
  let current = adapters();
  return {
    ...current,
    async reopen() {
      await current.dispose();
      current = adapters();
      return current;
    },
    async dispose() {
      await current.dispose();
    },
  };
});
