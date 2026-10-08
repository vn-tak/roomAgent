export const ID_PREFIXES = [
  "org",
  "usr",
  "emp",
  "rb",
  "dept",
  "role",
  "room",
  "rmem",
  "blk",
  "ovr",
  "evt",
  "corr",
  "join",
  "ses",
  "inb",
  "task",
  "art",
  "rev",
  "apr",
  "wfr",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export function createId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(16);
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (!source) {
    throw new Error("Web Crypto is required to create ids.");
  }
  source.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${prefix}_${hex}`;
}

export function isId(value: string, prefix: IdPrefix): boolean {
  return (
    (ID_PREFIXES as readonly string[]).includes(prefix) &&
    new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value)
  );
}
