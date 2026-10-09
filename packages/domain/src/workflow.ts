export const MAX_WORKFLOW_ITERATIONS = 8;

export const DEFAULT_TASK_BUDGETS = {
  maxActiveTasksPerAgent: 10,
  maxAgentMessagesPerTask: 100,
  maxTaskRetries: 3,
  orgDailyActionBudget: 1000,
  agentActionBudget: 200,
} as const;

export type TaskBudgetName = keyof typeof DEFAULT_TASK_BUDGETS;
export type TaskBudgets = Record<TaskBudgetName, number>;

export function taskBudgetExceeded(current: number, limit: number): boolean {
  return Number.isFinite(current) && Number.isFinite(limit) && current >= limit;
}
