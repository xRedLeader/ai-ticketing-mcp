import { registerClientCapabilityContracts } from '../../src/testing/client-capability-contracts.js';
import { adapters } from './helpers.js';

registerClientCapabilityContracts('PostgreSQL', async () => adapters());
