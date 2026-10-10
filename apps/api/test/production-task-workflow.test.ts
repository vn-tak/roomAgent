import type { ArtifactFinalize } from "@ai-company/artifact";
import { createId } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_VERSION_EVENT,
  HUMAN_APPROVAL_EVENT,
  QA_EVIDENCE_EVENT,
  SECURITY_EVIDENCE_EVENT,
  notifyProductionTaskEvidence,
} from "../src/production-task-workflow";
import { artifactStub, claimWorkflowStart } from "./helpers";
import {
  count,
  governanceCommand,
  paramsOf,
  prepare,
  runStatus,
  sendWakeup,
  untilRun,
} from "./workflow-fixtures";

describe("production task workflow external evidence", () => {
  it("ignores forged wakeups and advances only from authorized stored evidence", async () => {
    const prepared = await prepare("Evidence flow");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const params = await paramsOf(prepared);
      await claimWorkflowStart(runId, params);
      await env.PRODUCTION_TASK.create({ id: runId, params });
      await untilRun(prepared.org.id, runId, "running");

      await sendWakeup(runId, SECURITY_EVIDENCE_EVENT, { decision: "PASS" });
      await sendWakeup(runId, ARTIFACT_VERSION_EVENT, { version: 2 });
      await sendWakeup(runId, QA_EVIDENCE_EVENT, {
        artifactId: prepared.artifactId,
        version: 1,
        actorId: prepared.qaId,
        result: "PASS",
      });
      await sendWakeup(runId, QA_EVIDENCE_EVENT, {
        artifactId: prepared.artifactId,
        version: 1,
        actorId: prepared.qaId,
        result: "PASS",
      });
      expect(await runStatus(prepared.org.id, runId)).toBe("running");
      const waitingForQa = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string }>();
      expect(waitingForQa?.stage).toBe("qa_review");
      expect(
        await count(
          prepared.org.id,
          `SELECT COUNT(*) AS n FROM reviews WHERE org_id = ? AND artifact_id = '${prepared.artifactId}'`,
        ),
      ).toBe(0);

      const unauthorized = await governanceCommand(
        prepared,
        prepared.workerReviewToken,
        prepared.workerId,
        "reviews",
        "worker_try_review",
        { result: "PASS", version: 1 },
      );
      expect(unauthorized.status).toBe(403);
      await sendWakeup(runId, QA_EVIDENCE_EVENT, { result: "PASS" });
      expect(await runStatus(prepared.org.id, runId)).toBe("running");

      const qa = await governanceCommand(
        prepared,
        prepared.qaToken,
        prepared.qaId,
        "reviews",
        "qa_review_v1",
        { result: "PASS", version: 1 },
      );
      expect(qa.status).toBe(201);
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      await untilRun(prepared.org.id, runId, "running");
      await vi.waitFor(
        async () => {
          const row = await env.DB.prepare(
            `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
          )
            .bind(prepared.org.id, runId)
            .first<{ stage: string }>();
          expect(row?.stage).toBe("security");
        },
        { timeout: 8_000, interval: 20 },
      );

      const wrongSecurity = await governanceCommand(
        prepared,
        prepared.qaToken,
        prepared.qaId,
        "security-approvals",
        "qa_try_security",
        { version: 1 },
      );
      expect(wrongSecurity.status).toBe(403);
      await sendWakeup(runId, SECURITY_EVIDENCE_EVENT, { decision: "ALLOW" });
      const stillWaitingForSecurity = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string }>();
      expect(stillWaitingForSecurity?.stage).toBe("security");

      const security = await governanceCommand(
        prepared,
        prepared.securityToken,
        prepared.securityId,
        "security-approvals",
        "security_approve_v1",
        { version: 1 },
      );
      expect(security.status).toBe(201);
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        SECURITY_EVIDENCE_EVENT,
      );
      await untilRun(prepared.org.id, runId, "waiting_for_approval");

      await sendWakeup(runId, HUMAN_APPROVAL_EVENT, {
        actorType: "human",
        actorId: prepared.org.createdByUserId,
        decision: "ALLOW",
      });
      expect(await runStatus(prepared.org.id, runId)).toBe("waiting_for_approval");

      const creator = await artifactStub(prepared.org.id).finalize({
        orgId: prepared.org.id,
        actorType: "employee",
        actorId: prepared.workerId,
        idempotencyKey: "creator_final_try",
        artifactId: prepared.artifactId,
        version: 1,
      } satisfies ArtifactFinalize);
      expect(creator).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });

      const human = await artifactStub(prepared.org.id).finalize({
        orgId: prepared.org.id,
        actorType: "human",
        actorId: prepared.org.createdByUserId,
        idempotencyKey: "human_final_approve",
        artifactId: prepared.artifactId,
        version: 1,
      } satisfies ArtifactFinalize);
      expect(human.decision).toBe("ALLOW");
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        HUMAN_APPROVAL_EVENT,
      );

      await watched.waitForStatus("complete");
      expect(await watched.getOutput()).toEqual({ outcome: "COMPLETE", iteration: 0 });
      expect(await runStatus(prepared.org.id, runId)).toBe("complete");
    } finally {
      await watched.dispose();
    }
  });

  it("uses only the exact artifact version when resolving QA evidence", async () => {
    const prepared = await prepare("Wrong version");
    const versionTwo = await artifactStub(prepared.org.id).put({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.workerId,
      idempotencyKey: "upload_second_version",
      roomId: prepared.roomId,
      artifactId: prepared.artifactId,
      taskId: prepared.taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("version two"),
    });
    expect(versionTwo).toMatchObject({ decision: "ALLOW", version: 2 });
    const qa = await governanceCommand(
      prepared,
      prepared.qaToken,
      prepared.qaId,
      "reviews",
      "qa_review_v2",
      { result: "PASS", version: 2 },
    );
    expect(qa.status).toBe(201);

    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const params = await paramsOf(prepared);
      await claimWorkflowStart(runId, params);
      await env.PRODUCTION_TASK.create({ id: runId, params });
      await untilRun(prepared.org.id, runId, "running");
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      const row = await env.DB.prepare(
        `SELECT stage, status FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string; status: string }>();
      expect(row).toEqual({ stage: "qa_review", status: "running" });
      expect((await (await env.PRODUCTION_TASK.get(runId)).status()).status).not.toBe("complete");
    } finally {
      await watched.dispose();
    }
  });

  it("rejects a workflow correlation ID that differs from its persisted task root", async () => {
    const prepared = await prepare("Wrong correlation");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const params = await paramsOf(prepared);
      await claimWorkflowStart(runId, params);
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: { ...params, correlationId: createId("corr") },
      });
      await watched.waitForStatus("errored");
      expect(await runStatus(prepared.org.id, runId)).toBeNull();
    } finally {
      await watched.dispose();
    }
  });

  it("never registers an instance created without a durable start claim", async () => {
    const prepared = await prepare("Unclaimed instance");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({ id: runId, params: await paramsOf(prepared) });
      await watched.waitForStatus("errored");
      expect(await runStatus(prepared.org.id, runId)).toBeNull();
    } finally {
      await watched.dispose();
    }
  });
});
