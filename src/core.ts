// Pure core-memory budget logic, kept free of config and DB imports so it can be tested directly.

export interface CoreLimits {
  maxCount: number;
  maxChars: number;
}

export interface CoreEntry {
  id: string;
  content: string;
}

// Code points, matching Postgres char_length().
export function charLength(text: string): number {
  return [...text].length;
}

export class CoreLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreLimitError";
  }
}

/**
 * Throws CoreLimitError if adding a core memory of `content` to `others` (the current core
 * memories, excluding the one being changed) would exceed `limits`.
 */
export function checkCoreBudget(others: CoreEntry[], content: string, limits: CoreLimits): void {
  const size = charLength(content);
  const count = others.length + 1;
  const chars = others.reduce((sum, m) => sum + charLength(m.content), 0) + size;
  if (count <= limits.maxCount && chars <= limits.maxChars) return;

  const reason =
    size > limits.maxChars
      ? `This memory alone is ${size} characters, over the ${limits.maxChars}-character core limit; shorten it or keep it topical.`
      : `This would make ${count} core memories totaling ${chars} characters ` +
        `(limits: ${limits.maxCount} memories, ${limits.maxChars} characters).`;
  throw new CoreLimitError(
    `Core memory limit reached. ${reason} Nothing was changed. ` +
      "Show the user the current core memories below and ask which to demote (update_memory with core=false) " +
      "or shorten, or save this one as topical (core=false) instead.\n" +
      `Current core memories: ${JSON.stringify(others.map(({ id, content }) => ({ id, content })))}`,
  );
}
