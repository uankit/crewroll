/** A display name, not a legal-name or identity-verification requirement. */
export function profileName(value: string | null | undefined): string | null {
  if (!value || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalized || Array.from(normalized).length > 80) return null;
  return normalized;
}
