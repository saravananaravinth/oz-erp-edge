// oz-erp-edge/src/apps/worker/worker.entrypoint.ts
import { createWorkerApp } from './worker.app.js';
import { createWorkerDependencies } from './worker.dependencies.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { fetchDealerLocatorBridge } from '../../gateway/proxy/dealer-locator.bridge.js';
import type { BridgeEnv } from '../../gateway/proxy/dealer-locator.bridge.js';

const app = createWorkerApp(createWorkerDependencies());
export class DealerLocatorBridge extends WorkerEntrypoint<BridgeEnv> {
  override fetch(request: Request): Promise<Response> {
    return fetchDealerLocatorBridge(request, this.env, createWorkerDependencies());
  }
}

export default app;
