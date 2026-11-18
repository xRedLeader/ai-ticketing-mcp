import { registerExecutionContractTests } from '../../src/testing/execution-contracts.js';
import { adapters } from './helpers.js';
registerExecutionContractTests('PostgreSQL', async () => {
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
