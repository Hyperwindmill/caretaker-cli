import type { ScheduledTaskConfig } from '../../../types.js';

export interface SchedulerStrategy {
  type: ScheduledTaskConfig['type'];
  tick(task: ScheduledTaskConfig, now: Date): Promise<void>;
}
