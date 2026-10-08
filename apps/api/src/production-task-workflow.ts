import {
  isId,
  isReviewResult,
  MAX_WORKFLOW_ITERATIONS,
  type ReviewResult,
} from "@ai-company/domain";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepEvent,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

export const HUMAN_APPROVAL_EVENT = "human-approval";

export interface ProductionTaskParams {
  orgId: string;
  taskId: string;
  artifactId: string;
  version: number;
  roomId: string;
  workerEmployeeId: string;
  qaEmployeeId: string;
  securityEmployeeId: string | null;
  qaResults: string[];
  correlationId: string;
}

export interface ProductionTaskOutput {
  outcome: "COMPLETE";
  iteration: number;
}

type WorkflowRunStatus =
  "running" | "revision" | "waiting_for_approval" | "complete" | "denied" | "paused";

type WorkflowStage =
  "worker_submit" | "qa_review" | "revision" | "security" | "human_approval" | "complete";

interface ProductionPlan {
  orgId: string;
  taskId: string;
  artifactId: string;
  version: number;
  roomId: string;
  workerEmployeeId: string;
  qaEmployeeId: string;
  securityEmployeeId: string | null;
  qaResults: ReviewResult[];
  correlationId: string;
}

interface SubmitResult {
  ok: true;
  creatorId: string;
}

interface ReviewOutcome {
  decision: "ALLOW" | "DENY";
  reason: string;
  result: string;
}

interface Applied {
  outcome: "complete" | "denied";
  reason: string;
}

interface HumanApproval {
  actorType: "human" | "employee";
  actorId: string;
  decision: "ALLOW" | "DENY";
}

function code(value: string): string {
  return /^[A-Z_]{1,40}$/.test(value) ? value : "INVALID_INPUT";
}

function stepKey(prefix: string, runId: string, index: number): string {
  return `${prefix}-${runId}-${index}`;
}

function planFrom(instanceId: string, params: ProductionTaskParams): ProductionPlan | null {
  if (!isId(instanceId, "wfr")) {
    return null;
  }
  if (
    !isId(params.orgId, "org") ||
    !isId(params.taskId, "task") ||
    !isId(params.artifactId, "art") ||
    !isId(params.roomId, "room") ||
    !isId(params.workerEmployeeId, "emp") ||
    !isId(params.qaEmployeeId, "emp") ||
    !isId(params.correlationId, "corr")
  ) {
    return null;
  }
  if (!Number.isInteger(params.version) || params.version < 1 || params.version > 1_000_000) {
    return null;
  }
  const securityEmployeeId = params.securityEmployeeId;
  if (securityEmployeeId !== null && !isId(securityEmployeeId, "emp")) {
    return null;
  }
  if (
    !Array.isArray(params.qaResults) ||
    params.qaResults.length < 1 ||
    params.qaResults.length > MAX_WORKFLOW_ITERATIONS
  ) {
    return null;
  }
  const qaResults: ReviewResult[] = [];
  for (const result of params.qaResults) {
    if (typeof result !== "string" || !isReviewResult(result)) {
      return null;
    }
    qaResults.push(result);
  }
  return {
    orgId: params.orgId,
    taskId: params.taskId,
    artifactId: params.artifactId,
    version: params.version,
    roomId: params.roomId,
    workerEmployeeId: params.workerEmployeeId,
    qaEmployeeId: params.qaEmployeeId,
    securityEmployeeId,
    qaResults,
    correlationId: params.correlationId,
  };
}

function humanApproval(payload: unknown): HumanApproval | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const actorType = record.actorType;
  const actorId = record.actorId;
  const decision = record.decision;
  if ((actorType !== "human" && actorType !== "employee") || typeof actorId !== "string") {
    return null;
  }
  if (actorType === "human" && !isId(actorId, "usr")) {
    return null;
  }
  if (actorType === "employee" && !isId(actorId, "emp")) {
    return null;
  }
  if (decision !== "ALLOW" && decision !== "DENY") {
    return null;
  }
  return { actorType, actorId, decision };
}

export class ProductionTaskWorkflow extends WorkflowEntrypoint<Env, ProductionTaskParams> {
  async run(
    event: WorkflowEvent<ProductionTaskParams>,
    step: WorkflowStep,
  ): Promise<ProductionTaskOutput> {
    const plan = planFrom(event.instanceId, event.payload);
    if (!plan) {
      throw new NonRetryableError("INVALID_INPUT");
    }
    const runId = event.instanceId;
    await step.do("worker-submit", async () => {
      const submitted = await this.submit(runId, plan);
      if (!submitted) {
        throw new NonRetryableError("TENANT_BOUNDARY");
      }
      return { creatorId: submitted.creatorId };
    });

    let iteration = 0;
    let passed = false;
    for (let index = 0; index < plan.qaResults.length; index += 1) {
      const result = plan.qaResults[index];
      if (!result) {
        throw new NonRetryableError("INVALID_INPUT");
      }
      const reviewed = await step.do(`qa-review-${index}`, async () => {
        const outcome = await this.recordReview(plan, runId, index, result);
        if (outcome.decision !== "ALLOW") {
          await this.advance(runId, plan.orgId, "denied", "qa_review", index);
          throw new NonRetryableError(outcome.reason);
        }
        return outcome;
      });
      if (reviewed.result === "PASS") {
        iteration = index;
        passed = true;
        break;
      }
      const next = index + 1;
      if (next >= plan.qaResults.length || next >= MAX_WORKFLOW_ITERATIONS) {
        await step.do(`revision-cap-${index}`, async () => {
          await this.advance(runId, plan.orgId, "paused", "revision", next);
          throw new NonRetryableError("LOOP_GUARD");
        });
        throw new NonRetryableError("LOOP_GUARD");
      }
      await step.do(`revision-${next}`, async () =>
        this.advance(runId, plan.orgId, "revision", "revision", next),
      );
    }
    if (!passed) {
      throw new NonRetryableError("LOOP_GUARD");
    }

    const securityEmployeeId = plan.securityEmployeeId;
    if (securityEmployeeId) {
      await step.do("security-review", async () => {
        const outcome = await this.recordSecurity(plan, runId, securityEmployeeId);
        if (outcome.decision !== "ALLOW") {
          await this.advance(runId, plan.orgId, "denied", "security", iteration);
          throw new NonRetryableError(outcome.reason);
        }
        return outcome;
      });
    }

    await step.do("await-human", async () =>
      this.advance(runId, plan.orgId, "waiting_for_approval", "human_approval", iteration),
    );
    const incoming = await this.waitForHuman(step, runId, plan.orgId, iteration);
    const applied = await step.do("apply-human-approval", async () => {
      const outcome = await this.applyHuman(plan, runId, incoming.payload, iteration);
      if (outcome.outcome !== "complete") {
        throw new NonRetryableError(outcome.reason);
      }
      return { outcome: "complete" as const, iteration };
    });
    return { outcome: "COMPLETE", iteration: applied.iteration };
  }

  private async submit(runId: string, plan: ProductionPlan): Promise<SubmitResult | null> {
    const row = await this.env.DB.prepare(
      `SELECT artifacts.creator_type AS creator_type, artifacts.creator_id AS creator_id
       FROM artifacts
       INNER JOIN artifact_versions
         ON artifact_versions.org_id = artifacts.org_id
        AND artifact_versions.artifact_id = artifacts.id
        AND artifact_versions.version = ?
       WHERE artifacts.org_id = ?
         AND artifacts.id = ?
         AND artifacts.task_id = ?
         AND artifacts.room_id = ?`,
    )
      .bind(plan.version, plan.orgId, plan.artifactId, plan.taskId, plan.roomId)
      .first<{ creator_type: string; creator_id: string }>();
    if (!row || row.creator_type !== "employee" || row.creator_id !== plan.workerEmployeeId) {
      return null;
    }
    const now = new Date().toISOString();
    const inserted = await this.env.DB.prepare(
      `INSERT INTO workflow_runs (
         id, org_id, instance_id, task_id, artifact_id, artifact_version,
         status, stage, iteration, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', 'worker_submit', 0, ?, ?)`,
    )
      .bind(runId, plan.orgId, runId, plan.taskId, plan.artifactId, plan.version, now, now)
      .run();
    if (inserted.meta.changes !== 1) {
      throw new NonRetryableError("INVALID_INPUT");
    }
    return { ok: true, creatorId: row.creator_id };
  }

  private async recordReview(
    plan: ProductionPlan,
    runId: string,
    index: number,
    result: ReviewResult,
  ): Promise<ReviewOutcome> {
    const reviewed = await this.env.ARTIFACT.getByName(`artifacts:${plan.orgId}`).review({
      orgId: plan.orgId,
      actorType: "employee",
      actorId: plan.qaEmployeeId,
      idempotencyKey: stepKey("qa", runId, index),
      artifactId: plan.artifactId,
      version: plan.version,
      result,
    });
    return {
      decision: reviewed.decision,
      reason: code(reviewed.reason),
      result: reviewed.result ?? "",
    };
  }

  private async recordSecurity(
    plan: ProductionPlan,
    runId: string,
    securityEmployeeId: string,
  ): Promise<ReviewOutcome> {
    const approved = await this.env.ARTIFACT.getByName(`artifacts:${plan.orgId}`).securityApprove({
      orgId: plan.orgId,
      actorType: "employee",
      actorId: securityEmployeeId,
      idempotencyKey: stepKey("sec", runId, 0),
      artifactId: plan.artifactId,
      version: plan.version,
    });
    return {
      decision: approved.decision,
      reason: code(approved.reason),
      result: approved.result ?? "",
    };
  }

  private async applyHuman(
    plan: ProductionPlan,
    runId: string,
    payload: unknown,
    iteration: number,
  ): Promise<Applied> {
    const approval = humanApproval(payload);
    if (!approval) {
      await this.advance(runId, plan.orgId, "denied", "human_approval", iteration);
      return { outcome: "denied", reason: "INVALID_INPUT" };
    }
    const authorized = await this.env.ORGANIZATION.getByName(`org:${plan.orgId}`).authorize({
      orgId: plan.orgId,
      actorType: approval.actorType,
      actorId: approval.actorId,
      action: "workflow.approve",
      resourceType: "artifact",
      resourceId: plan.artifactId,
    });
    if (authorized.decision !== "ALLOW") {
      await this.advance(runId, plan.orgId, "denied", "human_approval", iteration);
      return { outcome: "denied", reason: code(authorized.reason) };
    }
    if (approval.decision === "DENY") {
      await this.advance(runId, plan.orgId, "denied", "human_approval", iteration);
      return { outcome: "denied", reason: "DENIED" };
    }
    const finalized = await this.env.ARTIFACT.getByName(`artifacts:${plan.orgId}`).finalize({
      orgId: plan.orgId,
      actorType: approval.actorType,
      actorId: approval.actorId,
      idempotencyKey: stepKey("fin", runId, 0),
      artifactId: plan.artifactId,
      version: plan.version,
    });
    if (finalized.decision !== "ALLOW") {
      await this.advance(runId, plan.orgId, "denied", "human_approval", iteration);
      return { outcome: "denied", reason: code(finalized.reason) };
    }
    await this.advance(runId, plan.orgId, "complete", "complete", iteration);
    return { outcome: "complete", reason: "ALLOWED" };
  }

  private async waitForHuman(
    step: WorkflowStep,
    runId: string,
    orgId: string,
    iteration: number,
  ): Promise<WorkflowStepEvent<unknown>> {
    try {
      return await step.waitForEvent("human-approval", {
        type: HUMAN_APPROVAL_EVENT,
        timeout: "24 hours",
      });
    } catch (error) {
      if (error instanceof NonRetryableError) {
        throw error;
      }
      await step.do("approval-timeout", async () => {
        await this.advance(runId, orgId, "paused", "human_approval", iteration);
        throw new NonRetryableError("TIMEOUT");
      });
      throw new NonRetryableError("TIMEOUT");
    }
  }

  private async advance(
    runId: string,
    orgId: string,
    status: WorkflowRunStatus,
    stage: WorkflowStage,
    iteration: number,
  ): Promise<{ status: WorkflowRunStatus; iteration: number }> {
    const now = new Date().toISOString();
    const updated = await this.env.DB.prepare(
      `UPDATE workflow_runs
       SET status = ?, stage = ?, iteration = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`,
    )
      .bind(status, stage, iteration, now, orgId, runId)
      .run();
    if (updated.meta.changes !== 1) {
      throw new NonRetryableError("TENANT_BOUNDARY");
    }
    return { status, iteration };
  }
}
