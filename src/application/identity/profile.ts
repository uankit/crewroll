const MAX_DISPLAY_NAME_LENGTH = 40;

export class InvalidDisplayNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDisplayNameError';
  }
}

export function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < 2) {
    throw new InvalidDisplayNameError('Enter at least 2 characters.');
  }
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new InvalidDisplayNameError(`Use ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }
  if (/\p{C}/u.test(normalized)) {
    throw new InvalidDisplayNameError('The name contains an unsupported control character.');
  }
  return normalized;
}
