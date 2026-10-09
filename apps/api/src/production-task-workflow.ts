import { isId, isReviewResult, MAX_WORKFLOW_ITERATIONS } from "@ai-company/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

export const QA_EVIDENCE_EVENT = "qa-evidence";
export const ARTIFACT_VERSION_EVENT = "artifact-version";
export const SECURITY_EVIDENCE_EVENT = "security-evidence";
export const HUMAN_APPROVAL_EVENT = "human-approval";

const MAX_EVIDENCE_WAKEUPS = 8;

export type ProductionTaskEvidenceWakeup =
  | typeof QA_EVIDENCE_EVENT
  | typeof ARTIFACT_VERSION_EVENT
  | typeof SECURITY_EVIDENCE_EVENT
  | typeof HUMAN_APPROVAL_EVENT;

export async function notifyProductionTaskEvidence(
  env: Env,
  orgId: string,
  artifactId: string,
  type: ProductionTaskEvidenceWakeup,
): Promise<void> {
  const runs = await env.DB.prepare(
    `SELECT instance_id FROM workflow_runs
     WHERE org_id = ? AND artifact_id = ?
       AND status IN ('running', 'revision', 'waiting_for_approval')`,
  )
    .bind(orgId, artifactId)
    .all<{ instance_id: string }>();
  await Promise.all(
    runs.results.map(async ({ instance_id }) =>
      (await env.PRODUCTION_TASK.get(instance_id)).sendEvent({
        type,
        payload: { orgId, artifactId },
      }),
    ),
  );
}

export interface ProductionTaskParams {
  orgId: string;
  taskId: string;
  artifactId: string;
  version: number;
  roomId: string;
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

type CompletionPolicy = "NONE" | "ARTIFACT_APPROVED" | "QA_SECURITY" | "HUMAN_FINAL";

interface ProductionPlan {
  orgId: string;
  taskId: string;
  artifactId: string;
  version: number;
  roomId: string;
  correlationId: string;
}

interface ReviewEvidence {
  result: string;
}

interface ApprovalEvidence {
  decision: "PASS" | "DENY";
}

function planFrom(instanceId: string, params: ProductionTaskParams): ProductionPlan | null {
  if (
    !isId(instanceId, "wfr") ||
    !isId(params.orgId, "org") ||
    !isId(params.taskId, "task") ||
    !isId(params.artifactId, "art") ||
    !isId(params.roomId, "room") ||
    !isId(params.correlationId, "corr")
  ) {
    return null;
  }
  if (!Number.isInteger(params.version) || params.version < 1 || params.version > 1_000_000) {
    return null;
  }
  return {
    orgId: params.orgId,
    taskId: params.taskId,
    artifactId: params.artifactId,
    version: params.version,
    roomId: params.roomId,
    correlationId: params.correlationId,
  };
}

function stepKey(kind: string, iteration: number, wakeup: number): string {
  return `${kind}-${iteration}-${wakeup}`;
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
    const policy = await step.do("register-run", async () => {
      const registered = await this.registerRun(runId, plan);
      if (!registered) {
        throw new NonRetryableError("TENANT_BOUNDARY");
      }
      return registered;
    });

    let version = plan.version;
    let iteration = 0;
    if (policy === "QA_SECURITY") {
      while (true) {
        await step.do(`await-qa-${iteration}`, async () =>
          this.advance(runId, plan.orgId, "running", "qa_review", iteration),
        );
        const review = await this.waitForReview(step, runId, plan, version, iteration);
        if (review.result === "PASS") {
          break;
        }
        if (review.result !== "REVISION_REQUIRED") {
          await step.do(`qa-failed-${iteration}`, async () => {
            await this.advance(runId, plan.orgId, "denied", "qa_review", iteration);
            throw new NonRetryableError("QA_FAILED");
          });
          throw new NonRetryableError("QA_FAILED");
        }

        iteration += 1;
        if (iteration >= MAX_WORKFLOW_ITERATIONS) {
          await step.do(`revision-cap-${iteration}`, async () => {
            await this.advance(runId, plan.orgId, "paused", "revision", iteration);
            throw new NonRetryableError("LOOP_GUARD");
          });
          throw new NonRetryableError("LOOP_GUARD");
        }
        await step.do(`request-revision-${iteration}`, async () =>
          this.advance(runId, plan.orgId, "revision", "revision", iteration),
        );
        version = await this.waitForNextVersion(step, runId, plan, version, iteration);
      }

      await step.do("await-security", async () =>
        this.advance(runId, plan.orgId, "running", "security", iteration),
      );
      const security = await this.waitForApproval(
        step,
        runId,
        plan,
        version,
        "security",
        iteration,
        SECURITY_EVIDENCE_EVENT,
      );
      if (security.decision !== "PASS") {
        await step.do("security-denied", async () => {
          await this.advance(runId, plan.orgId, "denied", "security", iteration);
          throw new NonRetryableError("SECURITY_DENIED");
        });
        throw new NonRetryableError("SECURITY_DENIED");
      }
    }

    if (policy !== "NONE") {
      await step.do("await-human-approval", async () =>
        this.advance(runId, plan.orgId, "waiting_for_approval", "human_approval", iteration),
      );
      const human = await this.waitForApproval(
        step,
        runId,
        plan,
        version,
        "final",
        iteration,
        HUMAN_APPROVAL_EVENT,
      );
      if (human.decision !== "PASS") {
        await step.do("human-denied", async () => {
          await this.advance(runId, plan.orgId, "denied", "human_approval", iteration);
          throw new NonRetryableError("APPROVAL_DENIED");
        });
        throw new NonRetryableError("APPROVAL_DENIED");
      }
    }

    await step.do("complete", async () => {
      const updated = await this.env.DB.prepare(
        `UPDATE workflow_runs
         SET status = 'complete', stage = 'complete', iteration = ?,
             completed_artifact_version = ?, updated_at = ?
         WHERE org_id = ? AND id = ?`,
      )
        .bind(iteration, version, new Date().toISOString(), plan.orgId, runId)
        .run();
      if (updated.meta.changes !== 1) throw new NonRetryableError("TENANT_BOUNDARY");
    });
    return { outcome: "COMPLETE", iteration };
  }

  private async registerRun(runId: string, plan: ProductionPlan): Promise<CompletionPolicy | null> {
    const row = await this.env.DB.prepare(
      `SELECT artifacts.creator_type AS creator_type,
              artifacts.creator_id AS creator_id,
              tasks.assignee_id AS assignee_id,
              tasks.completion_policy AS completion_policy,
              tasks.correlation_id AS correlation_id
       FROM artifacts
       INNER JOIN tasks
         ON tasks.org_id = artifacts.org_id
        AND tasks.id = artifacts.task_id
       INNER JOIN artifact_versions
         ON artifact_versions.org_id = artifacts.org_id
        AND artifact_versions.artifact_id = artifacts.id
        AND artifact_versions.version = ?
       WHERE artifacts.org_id = ?
         AND artifacts.id = ?
         AND artifacts.task_id = ?
         AND artifacts.room_id = ?
         AND tasks.room_id = ?
         AND tasks.state = 'REVIEW'`,
    )
      .bind(plan.version, plan.orgId, plan.artifactId, plan.taskId, plan.roomId, plan.roomId)
      .first<{
        creator_type: string;
        creator_id: string;
        assignee_id: string | null;
        completion_policy: string;
        correlation_id: string;
      }>();
    if (
      !row ||
      row.creator_type !== "employee" ||
      row.creator_id !== row.assignee_id ||
      row.correlation_id !== plan.correlationId
    ) {
      return null;
    }
    if (
      row.completion_policy !== "ARTIFACT_APPROVED" &&
      row.completion_policy !== "QA_SECURITY" &&
      row.completion_policy !== "HUMAN_FINAL"
    ) {
      return null;
    }

    const now = new Date().toISOString();
    const inserted = await this.env.DB.prepare(
      `INSERT INTO workflow_runs (
         id, org_id, instance_id, task_id, artifact_id, artifact_version,
         status, stage, iteration, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', 'qa_review', 0, ?, ?)`,
    )
      .bind(runId, plan.orgId, runId, plan.taskId, plan.artifactId, plan.version, now, now)
      .run();
    return inserted.meta.changes === 1 ? row.completion_policy : null;
  }

  private async reviewEvidence(
    plan: ProductionPlan,
    version: number,
  ): Promise<ReviewEvidence | null> {
    const rows = await this.env.DB.prepare(
      `SELECT reviews.result AS result
       FROM reviews
       INNER JOIN artifacts
         ON artifacts.org_id = reviews.org_id
        AND artifacts.id = reviews.artifact_id
       INNER JOIN artifact_versions
         ON artifact_versions.org_id = reviews.org_id
        AND artifact_versions.artifact_id = reviews.artifact_id
        AND artifact_versions.version = reviews.artifact_version
       WHERE reviews.org_id = ?
         AND reviews.artifact_id = ?
         AND reviews.artifact_version = ?
         AND reviews.reviewer_type = 'employee'
         AND artifacts.task_id = ?
         AND artifacts.room_id = ?
       ORDER BY reviews.created_at, reviews.id
       LIMIT 2`,
    )
      .bind(plan.orgId, plan.artifactId, version, plan.taskId, plan.roomId)
      .all<{ result: string }>();
    if (rows.results.length === 0) {
      return null;
    }
    if (rows.results.length !== 1 || !isReviewResult(rows.results[0]?.result ?? "")) {
      throw new NonRetryableError("AMBIGUOUS_EVIDENCE");
    }
    return { result: rows.results[0]?.result ?? "" };
  }

  private async approvalEvidence(
    plan: ProductionPlan,
    version: number,
    kind: "security" | "final",
  ): Promise<ApprovalEvidence | null> {
    const rows = await this.env.DB.prepare(
      `SELECT approvals.actor_type AS actor_type,
              approvals.decision AS decision,
              approvals.reason AS reason
       FROM approvals
       INNER JOIN artifacts
         ON artifacts.org_id = approvals.org_id
        AND artifacts.id = approvals.artifact_id
       INNER JOIN artifact_versions
         ON artifact_versions.org_id = approvals.org_id
        AND artifact_versions.artifact_id = approvals.artifact_id
        AND artifact_versions.version = approvals.artifact_version
       WHERE approvals.org_id = ?
         AND approvals.artifact_id = ?
         AND approvals.artifact_version = ?
         AND approvals.kind = ?
         AND approvals.actor_type = ?
         AND artifacts.task_id = ?
         AND artifacts.room_id = ?
       ORDER BY approvals.created_at, approvals.id
       LIMIT 2`,
    )
      .bind(
        plan.orgId,
        plan.artifactId,
        version,
        kind,
        kind === "security" ? "employee" : "human",
        plan.taskId,
        plan.roomId,
      )
      .all<{ actor_type: string; decision: string; reason: string }>();
    if (rows.results.length === 0) {
      return null;
    }
    if (rows.results.length !== 1) {
      throw new NonRetryableError("AMBIGUOUS_EVIDENCE");
    }
    const evidence = rows.results[0];
    if (!evidence || evidence.reason !== "ALLOWED") {
      return { decision: "DENY" };
    }
    return { decision: evidence.decision === "PASS" ? "PASS" : "DENY" };
  }

  private async nextVersion(plan: ProductionPlan, afterVersion: number): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT artifact_versions.version AS version
       FROM artifact_versions
       INNER JOIN artifacts
         ON artifacts.org_id = artifact_versions.org_id
        AND artifacts.id = artifact_versions.artifact_id
       INNER JOIN tasks
         ON tasks.org_id = artifacts.org_id
        AND tasks.id = artifacts.task_id
       WHERE artifact_versions.org_id = ?
         AND artifact_versions.artifact_id = ?
         AND artifact_versions.version = ?
         AND artifacts.task_id = ?
         AND artifacts.room_id = ?
         AND tasks.room_id = ?
         AND tasks.state = 'REVIEW'`,
    )
      .bind(plan.orgId, plan.artifactId, afterVersion + 1, plan.taskId, plan.roomId, plan.roomId)
      .first<{ version: number }>();
    return row?.version ?? null;
  }

  private async waitForReview(
    step: WorkflowStep,
    runId: string,
    plan: ProductionPlan,
    version: number,
    iteration: number,
  ): Promise<ReviewEvidence> {
    for (let wakeup = 0; wakeup < MAX_EVIDENCE_WAKEUPS; wakeup += 1) {
      const evidence = await step.do(`read-qa-${iteration}-${wakeup}`, () =>
        this.reviewEvidence(plan, version),
      );
      if (evidence) {
        return evidence;
      }
      await this.waitForWakeup(
        step,
        stepKey("qa-wakeup", iteration, wakeup),
        QA_EVIDENCE_EVENT,
        runId,
        plan.orgId,
        "qa_review",
        iteration,
      );
    }
    return this.pause(runId, plan.orgId, "qa_review", iteration, "EVIDENCE_TIMEOUT");
  }

  private async waitForNextVersion(
    step: WorkflowStep,
    runId: string,
    plan: ProductionPlan,
    currentVersion: number,
    iteration: number,
  ): Promise<number> {
    for (let wakeup = 0; wakeup < MAX_EVIDENCE_WAKEUPS; wakeup += 1) {
      const version = await step.do(`read-version-${iteration}-${wakeup}`, () =>
        this.nextVersion(plan, currentVersion),
      );
      if (version !== null) {
        return version;
      }
      await this.waitForWakeup(
        step,
        stepKey("version-wakeup", iteration, wakeup),
        ARTIFACT_VERSION_EVENT,
        runId,
        plan.orgId,
        "revision",
        iteration,
      );
    }
    return this.pause(runId, plan.orgId, "revision", iteration, "EVIDENCE_TIMEOUT");
  }

  private async waitForApproval(
    step: WorkflowStep,
    runId: string,
    plan: ProductionPlan,
    version: number,
    kind: "security" | "final",
    iteration: number,
    eventType: string,
  ): Promise<ApprovalEvidence> {
    for (let wakeup = 0; wakeup < MAX_EVIDENCE_WAKEUPS; wakeup += 1) {
      const evidence = await step.do(`read-${kind}-${iteration}-${wakeup}`, () =>
        this.approvalEvidence(plan, version, kind),
      );
      if (evidence) {
        return evidence;
      }
      await this.waitForWakeup(
        step,
        stepKey(`${kind}-wakeup`, iteration, wakeup),
        eventType,
        runId,
        plan.orgId,
        kind === "security" ? "security" : "human_approval",
        iteration,
      );
    }
    return this.pause(
      runId,
      plan.orgId,
      kind === "security" ? "security" : "human_approval",
      iteration,
      "EVIDENCE_TIMEOUT",
    );
  }

  private async waitForWakeup(
    step: WorkflowStep,
    stepName: string,
    eventType: string,
    runId: string,
    orgId: string,
    stage: WorkflowStage,
    iteration: number,
  ): Promise<void> {
    try {
      await step.waitForEvent(stepName, { type: eventType, timeout: "24 hours" });
    } catch {
      await step.do(`${stepName}-timeout`, async () => {
        await this.advance(runId, orgId, "paused", stage, iteration);
        throw new NonRetryableError("TIMEOUT");
      });
      throw new NonRetryableError("TIMEOUT");
    }
  }

  private async pause(
    runId: string,
    orgId: string,
    stage: WorkflowStage,
    iteration: number,
    reason: string,
  ): Promise<never> {
    await this.advance(runId, orgId, "paused", stage, iteration);
    throw new NonRetryableError(reason);
  }

  private async advance(
    runId: string,
    orgId: string,
    status: WorkflowRunStatus,
    stage: WorkflowStage,
    iteration: number,
  ): Promise<void> {
    const updated = await this.env.DB.prepare(
      `UPDATE workflow_runs
       SET status = ?, stage = ?, iteration = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`,
    )
      .bind(status, stage, iteration, new Date().toISOString(), orgId, runId)
      .run();
    if (updated.meta.changes !== 1) {
      throw new NonRetryableError("TENANT_BOUNDARY");
    }
  }
}
