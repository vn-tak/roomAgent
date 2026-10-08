import { DomainError } from "./errors";

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function assertName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 120) {
    throw new DomainError("INVALID_INPUT", "Name must be 1 to 120 characters.");
  }
  if (hasControlCharacter(name)) {
    throw new DomainError("INVALID_INPUT", "Name contains control characters.");
  }
  return name;
}

const CREDENTIAL_MARKERS = [/password/i, /cookie/i, /secret/i, /\bbearer\b/i, /authorization/i];

export function assertExternalRef(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const ref = value.trim();
  if (ref.length < 1 || ref.length > 120) {
    throw new DomainError("INVALID_INPUT", "External ref must be 1 to 120 characters.");
  }
  if (CREDENTIAL_MARKERS.some((pattern) => pattern.test(ref))) {
    throw new DomainError("INVALID_INPUT", "External ref must not contain credential material.");
  }
  if (/^(cfoat_|cfort_|gho_|ghp_)/.test(ref)) {
    throw new DomainError("INVALID_INPUT", "External ref must not contain credential material.");
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ref)) {
    throw new DomainError("INVALID_INPUT", "External ref must not contain credential material.");
  }
  return ref;
}

export function assertRoleCode(value: string): string {
  const code = value.trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(code)) {
    throw new DomainError("INVALID_INPUT", "Role code must be lowercase and 2 to 64 characters.");
  }
  return code;
}
