// Cloudflare Access application token verification. Only a signature-verified token
// counts as identity; the raw Cf-Access-Authenticated-User-Email header never does.

const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[0-9a-f]{64}$/;
const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 60;
const KEY_CACHE_MS = 5 * 60_000;
const UNKNOWN_KID_REFRESH_MS = 30_000;

export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

export interface AccessIdentity {
  issuer: string;
  email: string;
  subject: string;
}

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const keyCache = new Map<string, KeySet>();

export function accessConfig(env: unknown): AccessConfig | null {
  const vars = env as { ACCESS_TEAM_DOMAIN?: unknown; ACCESS_AUD?: unknown };
  const teamDomain = vars.ACCESS_TEAM_DOMAIN;
  const audience = vars.ACCESS_AUD;
  if (typeof teamDomain !== "string" || typeof audience !== "string") return null;
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience)) return null;
  return { teamDomain, audience };
}

export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AccessIdentity | null> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (!header || !payload || !signature) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 128) {
    return null;
  }

  const key = await signingKey(config.teamDomain, header.kid);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) return null;

  return claimsFrom(payload, config, nowSeconds);
}

function claimsFrom(
  payload: Record<string, unknown>,
  config: AccessConfig,
  now: number,
): AccessIdentity | null {
  if (payload.iss !== config.teamDomain) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" || payload.nbf > now + CLOCK_SKEW_SECONDS)
  ) {
    return null;
  }
  if (
    payload.iat !== undefined &&
    (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS)
  ) {
    return null;
  }
  // Service tokens carry no human email and are not operators.
  if (payload.type !== undefined && payload.type !== "app") return null;
  if (typeof payload.email !== "string" || typeof payload.sub !== "string") return null;
  const email = payload.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  if (payload.sub.length < 1 || payload.sub.length > 128) return null;
  return { issuer: config.teamDomain, email, subject: payload.sub };
}

async function signingKey(teamDomain: string, kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  let cached = keyCache.get(teamDomain);
  if (!cached || now - cached.fetchedAt > KEY_CACHE_MS) {
    cached = (await fetchKeys(teamDomain)) ?? undefined;
  }
  if (!cached) return null;
  const known = cached.keys.get(kid);
  if (known) return known;
  // Access rotates keys; refresh once for an unknown kid, but never on every request.
  if (now - cached.fetchedAt < UNKNOWN_KID_REFRESH_MS) return null;
  return (await fetchKeys(teamDomain))?.keys.get(kid) ?? null;
}

async function fetchKeys(teamDomain: string): Promise<KeySet | null> {
  let body: unknown;
  try {
    const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  }
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) return null;
  const keys = new Map<string, CryptoKey>();
  for (const entry of entries.slice(0, 16)) {
    const jwk = entry as JsonWebKey & { kid?: unknown };
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA" || typeof jwk.n !== "string") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      continue;
    }
  }
  const set = { keys, fetchedAt: Date.now() };
  keyCache.set(teamDomain, set);
  return set;
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(part: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
