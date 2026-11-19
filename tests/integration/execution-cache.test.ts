import { registerExecutionCacheContractTests } from '../../src/testing/execution-cache-contracts.js';
import { adapters } from './helpers.js';
registerExecutionCacheContractTests('PostgreSQL', async () => adapters());
