import { registerContinuationDispatchContractTests } from '../../src/testing/continuation-dispatch-contracts.js';
import { adapters } from './helpers.js';
registerContinuationDispatchContractTests('PostgreSQL', async () => adapters());
