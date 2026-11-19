import { registerSharedMemoryContractTests } from '../../src/testing/shared-memory-contracts.js';
import { adapters } from './helpers.js';

registerSharedMemoryContractTests('PostgreSQL', async () => adapters());
