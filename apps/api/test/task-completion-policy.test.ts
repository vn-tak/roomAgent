import type { ArtifactFinalize, ArtifactReview } from "@ai-company/artifact";
import type { Organization } from "@ai-company/domain";
import { createId } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { artifactStub, createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

interface Prepared {
  org: Organization;
  workerId: string;
  qaId: string;
  securityId: string;
  roomId: string;
  approverId: string;
}

async function prepare(name: string): Promise<Prepared> {
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const qa = await hire(studio.store, studio.org.id, `${name} QA`);
  const security = await hire(studio.store, studio.org.id, `${name} security`);
  const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
  const qaRole = await studio.store.getRoleByCode(studio.org.id, "qa");
  const securityRole = await studio.store.getRoleByCode(studio.org.id, "security");
  if (!employeeRole || !qaRole || !securityRole) throw new Error("Missing system role");
  const artifactRole = await studio.store.createRole(studio.org.id, {
    code: "policy_artifact_submitter",
    name: "Policy artifact submitter",
  });
  const completionRole = await studio.store.createRole(studio.org.id, {
    code: "policy_task_approver",
    name: "Policy task approver",
  });
  for (const action of ["artifact.create", "artifact.modify", "artifact.read"]) {
    await studio.store.assignPermission(studio.org.id, artifactRole.id, action);
  }
  await studio.store.assignPermission(studio.org.id, completionRole.id, "artifact.approve");
  await studio.store.assignPermission(studio.org.id, completionRole.id, "task.assign");
  const org = organizationStub(studio.org.id);
  const owner = ownerOf(studio.org);
  for (const [employee, role] of [
    [worker, employeeRole],
    [worker, artifactRole],
    [qa, qaRole],
    [qa, completionRole],
    [security, securityRole],
  ] as const) {
    const assigned = await org.assignRole({ ...owner, employeeId: employee.id, roleId: role.id });
    expect(assigned.decision).toBe("ALLOW");
  }
  const room = await studio.store.createRoom(studio.org.id, {
    name: "Review room",
    departmentId: null,
  });
  for (const employee of [worker, qa, security]) {
    await studio.store.addRoomMember(studio.org.id, room.id, employee.id);
  }
  return {
    org: studio.org,
    workerId: worker.id,
    qaId: qa.id,
    securityId: security.id,
    roomId: room.id,
    approverId: qa.id,
  };
}

async function createTask(
  prepared: Prepared,
  key: string,
  completionPolicy: "NONE" | "ARTIFACT_APPROVED" | "QA_SECURITY" | "HUMAN_FINAL",
): Promise<string> {
  const created = await taskStub(prepared.org.id).execute({
    ...ownerOf(prepared.org),
    idempotencyKey: `${key}_create`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: key,
    objective: "Require stored governance evidence before task completion.",
    roomId: prepared.roomId,
    dependsOn: [],
    completionPolicy,
  });
  expect(created.decision).toBe("ALLOW");
  const taskId = created.taskId;
  if (!taskId) throw new Error("Task create did not return an id");
  const employee = {
    orgId: prepared.org.id,
    actorType: "employee" as const,
    actorId: prepared.workerId,
  };
  for (const [command, assigneeId, actor] of [
    ["assign", prepared.workerId, ownerOf(prepared.org)],
    ["deliver", null, ownerOf(prepared.org)],
    ["ack", null, employee],
    ["start", null, employee],
  ] as const) {
    const result = await taskStub(prepared.org.id).execute({
      ...actor,
      idempotencyKey: `${key}_${command}`,
      command,
      taskId,
      assigneeId,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(result.decision).toBe("ALLOW");
  }
  return taskId;
}

async function submitTask(prepared: Prepared, taskId: string, key: string): Promise<void> {
  const submitted = await taskStub(prepared.org.id).execute({
    orgId: prepared.org.id,
    actorType: "employee",
    actorId: prepared.workerId,
    idempotencyKey: `${key}_submit`,
    command: "submit",
    taskId,
    assigneeId: null,
    title: null,
    objective: null,
    roomId: null,
    dependsOn: [],
  });
  expect(submitted).toMatchObject({ decision: "ALLOW", state: "REVIEW" });
}

async function createArtifact(
  prepared: Prepared,
  taskId: string,
  key: string,
  artifactId: string | null = null,
) {
  return artifactStub(prepared.org.id).put({
    orgId: prepared.org.id,
    actorType: "employee",
    actorId: prepared.workerId,
    idempotencyKey: `${key}_upload`,
    roomId: prepared.roomId,
    artifactId,
    taskId,
    mediaType: "text/plain",
    filename: null,
    checksum: null,
    bodyBase64: btoa(`${key} contents`),
  });
}

async function finishTask(prepared: Prepared, taskId: string, key: string) {
  const actor = {
    orgId: prepared.org.id,
    actorType: "employee" as const,
    actorId: prepared.approverId,
  };
  return {
    approval: await taskStub(prepared.org.id).execute({
      ...actor,
      idempotencyKey: `${key}_approve`,
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    }),
    completion: await taskStub(prepared.org.id).execute({
      ...actor,
      idempotencyKey: `${key}_complete`,
      command: "complete",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    }),
  };
}

async function approveArtifact(
  prepared: Prepared,
  artifactId: string,
  version: number,
  key: string,
) {
  return artifactStub(prepared.org.id).finalize({
    ...ownerOf(prepared.org),
    idempotencyKey: `${key}_final`,
    artifactId,
    version,
  } satisfies ArtifactFinalize);
}

describe("TaskDO completion policies", () => {
  it("keeps NONE compatible and requires final canonical approval for ARTIFACT_APPROVED", async () => {
    const prepared = await prepare("Artifact completion policy");
    const taskId = await createTask(prepared, "artifact_policy", "ARTIFACT_APPROVED");
    const artifact = await createArtifact(prepared, taskId, "artifact_policy");
    expect(artifact).toMatchObject({ decision: "ALLOW" });
    const artifactId = artifact.artifactId;
    if (!artifactId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, taskId, "artifact_policy");

    const deniedBeforeApproval = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "artifact_policy_no_evidence",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(deniedBeforeApproval).toMatchObject({
      decision: "DENY",
      reason: "COMPLETION_POLICY_EVIDENCE_REQUIRED",
      state: "REVIEW",
    });

    const review = await artifactStub(prepared.org.id).review({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.qaId,
      idempotencyKey: "artifact_policy_qa_review",
      artifactId,
      version: 1,
      result: "PASS",
    } satisfies ArtifactReview);
    expect(review.decision).toBe("ALLOW");
    const deniedWithoutFinal = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "artifact_policy_no_final",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(deniedWithoutFinal.reason).toBe("COMPLETION_POLICY_EVIDENCE_REQUIRED");

    expect((await approveArtifact(prepared, artifactId, 1, "artifact_policy")).decision).toBe(
      "ALLOW",
    );
    const completed = await finishTask(prepared, taskId, "artifact_policy");
    expect(completed.approval).toMatchObject({ decision: "ALLOW", state: "APPROVED" });
    expect(completed.completion).toMatchObject({ decision: "ALLOW", state: "COMPLETED" });

    const genericTask = await createTask(prepared, "generic_policy", "NONE");
    await submitTask(prepared, genericTask, "generic_policy");
    const generic = await finishTask(prepared, genericTask, "generic_policy");
    expect(generic.approval).toMatchObject({ decision: "ALLOW", state: "APPROVED" });
    expect(generic.completion).toMatchObject({ decision: "ALLOW", state: "COMPLETED" });
  });

  it("blocks task approval and completion when the canonical artifact has an active security block", async () => {
    const prepared = await prepare("Artifact completion security block");
    const approvalTaskId = await createTask(prepared, "blocked_approval", "ARTIFACT_APPROVED");
    const approvalArtifact = await createArtifact(prepared, approvalTaskId, "blocked_approval");
    const approvalArtifactId = approvalArtifact.artifactId;
    if (!approvalArtifactId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, approvalTaskId, "blocked_approval");
    expect(
      (await approveArtifact(prepared, approvalArtifactId, 1, "blocked_approval")).decision,
    ).toBe("ALLOW");
    expect(
      (
        await organizationStub(prepared.org.id).createSecurityBlock({
          ...ownerOf(prepared.org),
          resourceType: "artifact",
          resourceId: approvalArtifactId,
          severity: "high",
          reason: "Hold artifact approval",
        })
      ).decision,
    ).toBe("ALLOW");

    const taskStubForOrg = taskStub(prepared.org.id);
    const outboxBeforeApproval = await taskStubForOrg.outboxStatusForTest();
    const blockedApproval = await taskStubForOrg.execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "blocked_approval_command",
      command: "approve",
      taskId: approvalTaskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(blockedApproval).toMatchObject({
      decision: "DENY",
      reason: "SECURITY_BLOCK",
      state: "REVIEW",
    });
    expect(await taskStubForOrg.outboxStatusForTest()).toEqual(outboxBeforeApproval);
    expect(
      await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(prepared.org.id, approvalTaskId)
        .first<{ state: string }>(),
    ).toEqual({ state: "REVIEW" });

    const completionTaskId = await createTask(prepared, "blocked_completion", "ARTIFACT_APPROVED");
    const completionArtifact = await createArtifact(
      prepared,
      completionTaskId,
      "blocked_completion",
    );
    const completionArtifactId = completionArtifact.artifactId;
    if (!completionArtifactId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, completionTaskId, "blocked_completion");
    expect(
      (await approveArtifact(prepared, completionArtifactId, 1, "blocked_completion")).decision,
    ).toBe("ALLOW");
    expect(
      (
        await taskStubForOrg.execute({
          orgId: prepared.org.id,
          actorType: "employee",
          actorId: prepared.approverId,
          idempotencyKey: "blocked_completion_approve",
          command: "approve",
          taskId: completionTaskId,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        })
      ).state,
    ).toBe("APPROVED");
    expect(
      (
        await organizationStub(prepared.org.id).createSecurityBlock({
          ...ownerOf(prepared.org),
          resourceType: "artifact",
          resourceId: completionArtifactId,
          severity: "high",
          reason: "Hold task completion",
        })
      ).decision,
    ).toBe("ALLOW");

    const outboxBeforeCompletion = await taskStubForOrg.outboxStatusForTest();
    const blockedCompletion = await taskStubForOrg.execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "blocked_completion_command",
      command: "complete",
      taskId: completionTaskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(blockedCompletion).toMatchObject({
      decision: "DENY",
      reason: "SECURITY_BLOCK",
      state: "APPROVED",
    });
    expect(await taskStubForOrg.outboxStatusForTest()).toEqual(outboxBeforeCompletion);
    expect(
      await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(prepared.org.id, completionTaskId)
        .first<{ state: string }>(),
    ).toEqual({ state: "APPROVED" });
  });

  it("requires same-task, canonical-version QA and security evidence", async () => {
    const prepared = await prepare("QA security completion policy");
    const taskId = await createTask(prepared, "qa_security_policy", "QA_SECURITY");
    const artifact = await createArtifact(prepared, taskId, "qa_security_policy");
    const artifactId = artifact.artifactId;
    if (!artifactId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, taskId, "qa_security_policy");

    expect(
      (
        await artifactStub(prepared.org.id).review({
          orgId: prepared.org.id,
          actorType: "employee",
          actorId: prepared.qaId,
          idempotencyKey: "qa_security_pass_v1",
          artifactId,
          version: 1,
          result: "PASS",
        })
      ).decision,
    ).toBe("ALLOW");
    const noSecurity = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "qa_security_without_security",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(noSecurity.reason).toBe("COMPLETION_POLICY_EVIDENCE_REQUIRED");
    expect(
      (
        await artifactStub(prepared.org.id).securityApprove({
          orgId: prepared.org.id,
          actorType: "employee",
          actorId: prepared.securityId,
          idempotencyKey: "qa_security_approve_v1",
          artifactId,
          version: 1,
        })
      ).decision,
    ).toBe("ALLOW");
    const completed = await finishTask(prepared, taskId, "qa_security_policy");
    expect(completed.approval.state).toBe("APPROVED");
    expect(completed.completion.state).toBe("COMPLETED");
  });

  it("accepts HUMAN_FINAL evidence for the workflow's completed revision", async () => {
    const prepared = await prepare("Human final revised artifact");
    const taskId = await createTask(prepared, "human_final_revision", "HUMAN_FINAL");
    const versionOne = await createArtifact(prepared, taskId, "human_final_revision_v1");
    const artifactId = versionOne.artifactId;
    if (!artifactId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, taskId, "human_final_revision");

    const versionTwo = await createArtifact(
      prepared,
      taskId,
      "human_final_revision_v2",
      artifactId,
    );
    expect(versionTwo.version).toBe(2);
    expect((await approveArtifact(prepared, artifactId, 2, "human_final_revision")).decision).toBe(
      "ALLOW",
    );

    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, org_id, instance_id, task_id, artifact_id, artifact_version,
        completed_artifact_version, status, stage, iteration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, 'complete', 'complete', 1, ?, ?)`,
    )
      .bind(createId("wfr"), prepared.org.id, createId("wfr"), taskId, artifactId, now, now)
      .run();

    const staleCompletion = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "human_final_stale_revision",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(staleCompletion).toMatchObject({
      decision: "DENY",
      reason: "COMPLETION_POLICY_EVIDENCE_REQUIRED",
      state: "REVIEW",
    });

    const runId = createId("wfr");
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, org_id, instance_id, task_id, artifact_id, artifact_version,
        completed_artifact_version, status, stage, iteration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 2, 'complete', 'complete', 1, ?, ?)`,
    )
      .bind(runId, prepared.org.id, runId, taskId, artifactId, now, now)
      .run();

    const completed = await finishTask(prepared, taskId, "human_final_revision");
    expect(completed.approval).toMatchObject({ decision: "ALLOW", state: "APPROVED" });
    expect(completed.completion).toMatchObject({ decision: "ALLOW", state: "COMPLETED" });
  });

  it("rejects stale, unrelated, and cross-org artifact evidence and accepts a complete human workflow", async () => {
    const prepared = await prepare("Wrong artifact policy");
    const taskId = await createTask(prepared, "human_final_policy", "HUMAN_FINAL");
    const linked = await createArtifact(prepared, taskId, "human_final_linked");
    const linkedId = linked.artifactId;
    if (!linkedId) throw new Error("Artifact create did not return an id");
    await submitTask(prepared, taskId, "human_final_policy");
    const otherTask = await createTask(prepared, "other_artifact_task", "NONE");
    const unrelated = await createArtifact(prepared, otherTask, "unrelated_artifact");
    const unrelatedId = unrelated.artifactId;
    if (!unrelatedId) throw new Error("Artifact create did not return an id");
    expect((await approveArtifact(prepared, unrelatedId, 1, "unrelated_artifact")).decision).toBe(
      "ALLOW",
    );

    const anotherOrg = await prepare("Foreign workflow evidence");
    const foreignTask = await createTask(anotherOrg, "foreign_artifact_task", "NONE");
    const foreign = await createArtifact(anotherOrg, foreignTask, "foreign_artifact");
    const foreignId = foreign.artifactId;
    if (!foreignId) throw new Error("Foreign artifact create did not return an id");
    expect((await approveArtifact(anotherOrg, foreignId, 1, "foreign_artifact")).decision).toBe(
      "ALLOW",
    );

    const staleApproval = await approveArtifact(prepared, linkedId, 1, "stale_linked");
    expect(staleApproval.decision).toBe("ALLOW");
    const versionTwo = await createArtifact(prepared, taskId, "human_final_linked_v2", linkedId);
    expect(versionTwo.version).toBe(2);
    const noHumanWorkflow = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "human_final_no_workflow",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(noHumanWorkflow.reason).toBe("COMPLETION_POLICY_EVIDENCE_REQUIRED");

    const runId = createId("wfr");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workflow_runs (
        id, org_id, instance_id, task_id, artifact_id, artifact_version,
        status, stage, iteration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 2, 'complete', 'complete', 0, ?, ?)`,
    )
      .bind(runId, prepared.org.id, runId, taskId, linkedId, now, now)
      .run();
    const missingCurrentHumanApproval = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.approverId,
      idempotencyKey: "human_final_missing_v2_approval",
      command: "approve",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(missingCurrentHumanApproval).toMatchObject({
      decision: "DENY",
      reason: "COMPLETION_POLICY_EVIDENCE_REQUIRED",
      state: "REVIEW",
    });

    expect(
      (await approveArtifact(prepared, linkedId, 2, "human_final_current_version")).decision,
    ).toBe("ALLOW");
    const accepted = await finishTask(prepared, taskId, "human_final_policy");
    expect(accepted.approval.state).toBe("APPROVED");
    expect(accepted.completion.state).toBe("COMPLETED");

    const foreignEvidence = await env.DB.prepare(
      `SELECT 1 FROM workflow_runs WHERE org_id = ? AND task_id = ? LIMIT 1`,
    )
      .bind(prepared.org.id, foreignTask)
      .first<{ 1: number }>();
    expect(foreignEvidence).toBeNull();
  });
});
