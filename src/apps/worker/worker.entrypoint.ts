// oz-erp-edge/src/apps/worker/worker.entrypoint.ts
import { createWorkerApp } from './worker.app.js';
import { createWorkerDependencies } from './worker.dependencies.js';

const app = createWorkerApp(createWorkerDependencies());

export default app;
