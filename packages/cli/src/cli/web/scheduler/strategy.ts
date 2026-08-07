import type { ServiceConfig } from '../../../types.js';

export interface SchedulerStrategy {
  type: ServiceConfig['type'];
  tick(task: ServiceConfig, now: Date): Promise<void>;
}
