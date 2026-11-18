import { adapters } from './helpers.js';
import { registerSchedulingContractTests } from '../scheduling-contract.js';

registerSchedulingContractTests('PostgreSQL', async () => adapters());
