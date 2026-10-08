interface Utf8Encoder {
  encode(input?: string): Uint8Array;
}

interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function encodeUtf8(value: string): Uint8Array {
  const Encoder = (globalThis as { TextEncoder?: new () => Utf8Encoder }).TextEncoder;
  if (!Encoder) {
    throw new Error("TextEncoder is required.");
  }
  return new Encoder().encode(value);
}

function cryptoSource(): RandomSource {
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (!source) {
    throw new Error("Web Crypto is required.");
  }
  return source;
}

export function randomSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  cryptoSource().getRandomValues(buffer);
  return hex(buffer);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await cryptoSource().subtle.digest("SHA-256", encodeUtf8(value));
  return hex(new Uint8Array(digest));
}

export function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}
