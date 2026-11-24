import { registerExecutionArtifactContracts } from '../../src/testing/execution-artifact-contracts.js';
import { adapters } from './helpers.js';

registerExecutionArtifactContracts('PostgreSQL', async () => adapters());
