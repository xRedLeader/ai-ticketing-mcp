import { registerReviewerPacketContracts } from '../../src/testing/reviewer-packet-contracts.js';
import { adapters } from './helpers.js';

registerReviewerPacketContracts('PostgreSQL', async () => adapters());
