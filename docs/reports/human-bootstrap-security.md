# Human operator bootstrap security (P1-02)

Gate: `ROOMAGENT_P1_HUMAN_BOOTSTRAP_PASS` (local evidence; remote Access not tested).

## Finding

Human sessions could be issued only through trusted internal RPC
(`OrganizationDO.issueHumanSession`). Staging had no way for a real operator to authenticate
and receive a valid session (`HUMAN_BOOTSTRAP_MISSING`).

## Previous behavior

- No HTTP path issued a human session.
- Revocation was RPC-only and was not audited.
- Disabling an operator had no effect on sessions already issued.

## Root cause

R9 deliberately limited issuance to trusted RPC until an identity provider was chosen. No
provider integration followed.

## Implementation

### Choice: Cloudflare Access verified identity + server-side mapping + OrganizationDO

Access is Cloudflare-native, puts MFA and IdP policy in front of the Worker, and issues an
RS256-signed application token on every request. The Worker verifies that token itself. It
never trusts `Cf-Access-Authenticated-User-Email` or any other client-sent header.

### Flow

```text
Operator → Access (IdP + policy) → Worker
POST /orgs/:orgId/human-sessions
  1. ACCESS_TEAM_DOMAIN / ACCESS_AUD configured and well-formed, else 503 BOOTSTRAP_NOT_CONFIGURED
  2. Cf-Access-Jwt-Assertion verified (apps/api/src/access-jwt.ts)
       alg = RS256, kid in https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
       signature, iss = team domain, aud ∋ AUD tag, exp > now,
       nbf/iat ≤ now + 60 s, type = "app" when present, email + sub present
     else 401 ACCESS_IDENTITY_INVALID
  3. human_identities lookup by (issuer, lower(email)), status active,
     Access `sub` pinned on first use and required to match afterwards
     else 403 IDENTITY_NOT_MAPPED / IDENTITY_DISABLED / IDENTITY_MISMATCH
  4. OrganizationDO.issueAccessHumanSession(userId, identityId, ttl = 900 s)
       runtime.bind gate ⇒ only the organization owner; organization must be active
     else 403 PERMISSION_DENIED
  5. 201 { session_id, token, expires_at, token_type: "Bearer" }

DELETE /orgs/:orgId/human-sessions/current   (Authorization: Bearer hum_…) → revoke self
```

### Required security properties

| Requirement                        | Implementation                                                         |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Deny by default                    | Unset or placeholder Access vars → 503; staging ships placeholders     |
| Strong identity verification       | Signature-verified Access JWT; issuer, audience, and time checks       |
| No client-claimed owner ID         | User comes from the operator-provisioned mapping, never the request    |
| Tenant-bound session               | `human_sessions.org_id`; insert trigger requires the org owner         |
| Short-lived session                | 900 s for Access sessions (trusted RPC still caps at 3600 s)           |
| Session revocation                 | Self-revocation route; `revokeHumanSession` RPC unchanged              |
| Disabled identity                  | `verifyHumanSession` requires the linked identity to be `active`       |
| Audit issuance/revocation          | Insert-only `human_session_audit`, written in the same D1 batch        |
| No secrets in URLs/logs            | Token only in the JSON body with `cache-control: no-store`; logs carry |
|                                    | outcome and reason only, never email, token, or assertion              |
| No hardcoded owner token           | None; tokens are random 256-bit values stored as SHA-256               |
| No browser cookie extraction       | Only the Access header is read; `CF_Authorization` cookie is ignored   |
| No permanent all-powerful token    | No bootstrap token exists                                              |
| No unauthenticated bootstrap route | Every issuance requires a verified Access JWT and a mapped identity    |

The Access subject is pinned on first verified use, so a later token with the same email but
a different `sub` (for example a re-provisioned IdP account) is rejected. Signing keys are
cached for 5 minutes. An unknown `kid` triggers at most one refresh per 30 seconds, which
covers Access key rotation (every 6 weeks, previous key valid for 7 days) without letting
requests force refetches.

## Operator provisioning (approval required, not performed)

1. Create an Access self-hosted application for the staging hostname. Policy: named operators
   only, MFA required. Record the team domain and the application AUD tag.
2. Set `vars.ACCESS_TEAM_DOMAIN` and `vars.ACCESS_AUD` in `apps/api/wrangler.staging.jsonc`
   through a reviewed change. They are configuration, not secrets.
3. Map the operator after review:

   ```sql
   -- id: python3 -c 'import secrets; print("hid_" + secrets.token_hex(16))'
   INSERT INTO human_identities (id, issuer, email, subject, user_id, status, created_at, updated_at)
   VALUES ('hid_<32 hex>', 'https://<team>.cloudflareaccess.com', '<lower-case email>', NULL,
           '<usr_… owner of the target organization>', 'active', <now>, <now>);
   ```

   Run it with `wrangler d1 execute ai-company-os-staging --remote --file <reviewed.sql>` only
   after the D1 preflight passes.

4. Disable with `UPDATE human_identities SET status = 'disabled', updated_at = <now> WHERE id = …`.
   Live sessions stop verifying immediately.

## Security impact

Replaces RPC-only issuance with a verifiable operator path, without adding a route that
accepts a claimed identity. The trusted RPC path remains for tests and internal tooling and
is now audited too.

## Regression tests

`apps/api/test/human-bootstrap.test.ts` (4). Tests sign tokens with a generated RSA key and
serve its JWKS through a `fetch` stub for the test team domain only.

| Required case                      | Evidence                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Verified owner → session issued    | 201, TTL ≤ 900 s, session resolves to the owner, audit `issued/access` |
| Forged identity → DENY             | wrong signing key, tampered payload, `alg: none`, garbage → 401        |
| Wrong Access audience → DENY       | 401                                                                    |
| Expired identity token → DENY      | `exp` in the past, `nbf` in the future → 401                           |
| Wrong organization → DENY          | mapped owner of org A against org B → 403; session for A denied in B   |
| Session revoked → DENY             | revoke → principal DENY, second revoke 401, audit `issued, revoked`    |
| Suspended/disabled identity → DENY | disabled mapping → issuance 403 and live session DENY                  |
| Untrusted public request → DENY    | raw `cf-access-authenticated-user-email`/actor headers → 401           |
| Reassigned email                   | same email, different `sub` → 403 `IDENTITY_MISMATCH`                  |

`apps/api/test/human-session.test.ts` (existing 3) still passes with audited RPC issuance.

## Remaining risks

- Access application, policy, and IdP configuration are operator-owned and unverified.
- The Worker must be reachable only through the Access-protected hostname. The staging config
  sets `workers_dev: false` and `preview_urls: false`. Even if a public URL existed, a request
  without a valid Access JWT receives no session.
- Only organization owners can bootstrap. Delegated human roles are out of scope.
- Identity mapping changes are SQL, not a UI. They require review.

## Cloudflare remote verification required

- Real Access JWT shape, `type`, and key rotation against the configured team.
- The Access policy and MFA enforcement on the staging hostname.
- `REMOTE_NOT_TESTED`.
