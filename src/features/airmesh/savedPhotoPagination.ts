import type { PhotoView, SavedTripPage } from '@/application/runtime/AirMeshRuntime';
import type { GalleryCursor } from '@/data';

export interface SavedPhotoSequence {
  photos: PhotoView[];
  nextCursor: GalleryCursor | null;
}

type SavedPageLoader = (cursor: GalleryCursor | null) => Promise<SavedTripPage>;

/**
 * Loads keyset pages only until the requested photo is present. A deep link to
 * an older photo therefore remains correct without turning every saved-roll
 * open into an unbounded bulk read.
 */
export async function loadSavedPhotoSequenceThrough(
  loadPage: SavedPageLoader,
  targetMediaId: string,
  initial: SavedPhotoSequence = { photos: [], nextCursor: null },
): Promise<SavedPhotoSequence & { found: boolean }> {
  if (!targetMediaId.trim()) throw new RangeError('targetMediaId is required.');

  let sequence = initial;
  if (sequence.photos.some((photo) => photo.media.id === targetMediaId)) {
    return { ...sequence, found: true };
  }
  if (sequence.photos.length > 0 && !sequence.nextCursor) {
    return { ...sequence, found: false };
  }
  const visitedCursors = new Set<string>();
  if (sequence.photos.length > 0 && sequence.nextCursor) {
    rememberAdvancingCursor(sequence.nextCursor, visitedCursors);
  }

  while (true) {
    const page = await loadPage(sequence.nextCursor);
    sequence = mergeSavedPhotoPage(sequence.photos, page);
    if (sequence.photos.some((photo) => photo.media.id === targetMediaId)) {
      return { ...sequence, found: true };
    }
    if (!sequence.nextCursor) return { ...sequence, found: false };
    rememberAdvancingCursor(sequence.nextCursor, visitedCursors);
  }
}

/**
 * Appends as many raw gallery pages as necessary to reveal at least one photo
 * under the current detail filters. This prevents a sparse contributor/date
 * filter from getting stuck at a page containing only non-matching photos.
 */
export async function appendSavedPhotoPagesUntilVisible(
  current: SavedPhotoSequence,
  loadPage: SavedPageLoader,
  isVisible: (photo: PhotoView) => boolean,
): Promise<SavedPhotoSequence> {
  if (!current.nextCursor) return current;

  let sequence = current;
  const knownIds = new Set(current.photos.map((photo) => photo.media.id));
  const visitedCursors = new Set<string>();

  while (sequence.nextCursor) {
    rememberAdvancingCursor(sequence.nextCursor, visitedCursors);
    const page = await loadPage(sequence.nextCursor);
    const newVisiblePhoto = page.photos.some(
      (photo) => !knownIds.has(photo.media.id) && isVisible(photo),
    );
    sequence = mergeSavedPhotoPage(sequence.photos, page);
    for (const photo of sequence.photos) knownIds.add(photo.media.id);
    if (newVisiblePhoto) return sequence;
  }

  return sequence;
}

export function shouldPrefetchPhotoPage(
  currentIndex: number,
  loadedCount: number,
  hasMore: boolean,
  threshold = 8,
): boolean {
  if (!hasMore || loadedCount <= 0 || currentIndex < 0) return false;
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new RangeError('threshold must be a non-negative integer.');
  }
  return currentIndex >= Math.max(0, loadedCount - threshold - 1);
}

function mergeSavedPhotoPage(
  current: readonly PhotoView[],
  page: Pick<SavedTripPage, 'photos' | 'nextCursor'>,
): SavedPhotoSequence {
  const knownIds = new Set(current.map((photo) => photo.media.id));
  const additions = page.photos.filter((photo) => {
    if (knownIds.has(photo.media.id)) return false;
    knownIds.add(photo.media.id);
    return true;
  });
  return {
    photos: [...current, ...additions],
    nextCursor: page.nextCursor,
  };
}

function rememberAdvancingCursor(
  cursor: GalleryCursor,
  visitedCursors: Set<string>,
): void {
  const key = `${cursor.capturedAtMs}\0${cursor.mediaId}`;
  if (visitedCursors.has(key)) {
    throw new Error('Saved gallery pagination returned a cursor that did not advance.');
  }
  visitedCursors.add(key);
}
