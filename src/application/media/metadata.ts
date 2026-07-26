const MIME_TYPES: Readonly<Record<string, string>> = {
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface ImageFileMetadata {
  extension: string;
  mimeType: string;
}

export function imageFileMetadata(filename: string | null, uri: string): ImageFileMetadata {
  const extension = extractExtension(filename ?? uri) ?? 'jpg';
  return {
    extension,
    mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
  };
}

export function captureDateMetadata(capturedAtMs: number): {
  localDate: string;
  timeZoneOffsetMinutes: number;
} {
  if (!Number.isFinite(capturedAtMs) || capturedAtMs < 0) {
    throw new RangeError('capturedAtMs must be a non-negative timestamp.');
  }
  const date = new Date(capturedAtMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return {
    localDate: `${year}-${month}-${day}`,
    timeZoneOffsetMinutes: -date.getTimezoneOffset(),
  };
}

function extractExtension(value: string): string | null {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const match = /\.([a-zA-Z0-9]{2,8})$/.exec(withoutQuery);
  return match ? match[1].toLowerCase() : null;
}
