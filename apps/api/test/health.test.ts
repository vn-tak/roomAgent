import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("api gateway", () => {
  it("reports health without exposing tenant data", async () => {
    const response = await exports.default.fetch("https://company.local/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "ai-company-os-api" });
  });

  it("returns a structured not-found error", async () => {
    const response = await exports.default.fetch("https://company.local/missing", {
      headers: { "x-request-id": "req_health_test" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("req_health_test");
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Route was not found.",
        request_id: "req_health_test",
      },
    });
  });
});
