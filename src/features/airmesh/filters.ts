import type { PhotoView } from '@/application/runtime/AirMeshRuntime';

export interface PhotoFilters {
  memberId: string | null;
  localDate: string | null;
}

export function filterPhotos(photos: readonly PhotoView[], filters: PhotoFilters): PhotoView[] {
  return photos.filter(
    (photo) =>
      photo.media.shareStatus === 'PUBLISHED' &&
      (filters.memberId === null || photo.media.originMemberId === filters.memberId) &&
      (filters.localDate === null || photo.media.captureLocalDate === filters.localDate),
  );
}

export function currentLocalDate(now = new Date()): string {
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
