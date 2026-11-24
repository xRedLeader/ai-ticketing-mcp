import { createRuntime } from '../../src/runtime.js';
import { ExecutionCompanion } from '../../src/execution-companion.js';
import { loadExecutionRecipes } from '../../src/execution-recipes.js';
import { HostCapacity } from '../../src/host-capacity.js';
const [phase, actor, project, capacityFile, artifacts] = process.argv.slice(2);
const app = createRuntime({ ...process.env, EMBEDDING_PROVIDER: 'none' });
await app.storage.migrate();
if (phase === 'dispatch') {
  const start = app.startExecutionRun.bind(app);
  app.startExecutionRun = async (...args) => {
    await start(...args);
    process.exit(93);
  };
} else if (phase === 'acknowledgment') app.observeExecutionRun = async () => process.exit(93);
else app.recoverExecutionRun = async () => process.exit(93);
const capacity = new HostCapacity(capacityFile!);
await new ExecutionCompanion({
  application: app,
  capacity,
  recipes: loadExecutionRecipes(process.env.EXECUTION_RECIPES_FILE!),
  actor_id: actor!,
  project_id: project!,
  host_id: 'test',
  artifacts_directory: artifacts!,
}).runOnce();
process.exit(94);
