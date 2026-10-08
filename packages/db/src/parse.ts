import { DomainError } from "@ai-company/domain";

interface CommandSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

export function parseCommand<T>(schema: CommandSchema<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError("INVALID_INPUT", "Input is not valid.");
  }
  return result.data;
}
