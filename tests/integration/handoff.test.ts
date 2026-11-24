import { adapters } from './helpers.js';
import { registerHandoffContractTests } from '../../src/testing/handoff-contracts.js';

registerHandoffContractTests('PostgreSQL', async () => adapters());
