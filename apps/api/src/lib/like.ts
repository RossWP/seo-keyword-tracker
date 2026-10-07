/** A user's search text as a literal ILIKE pattern: % and _ match themselves, not wildcards. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
