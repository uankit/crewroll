export interface DisplayNameSources {
  readonly firstName: string | null;
  readonly fullName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
}

const fallbackDisplayName = "CrewRoll member";

function normalizeCandidate(input: string): string {
  return input.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export function normalizeDisplayName(sources: DisplayNameSources): string {
  const firstAndLast = [sources.firstName, sources.lastName]
    .filter((part): part is string => part !== null)
    .join(" ");
  const candidates = [
    sources.fullName,
    firstAndLast,
    sources.username,
    fallbackDisplayName,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const normalized = normalizeCandidate(candidate);
    if (normalized.length > 0)
      return Array.from(normalized).slice(0, 80).join("");
  }
  return fallbackDisplayName;
}
