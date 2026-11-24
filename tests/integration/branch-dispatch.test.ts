import { registerBranchDispatchContractTests } from '../../src/testing/branch-dispatch-contracts.js';
import { adapters } from './helpers.js';

registerBranchDispatchContractTests('PostgreSQL', async () => adapters());
