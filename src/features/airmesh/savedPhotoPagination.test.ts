import { describe, expect, it, vi } from 'vitest';

import type { PhotoView, SavedTripPage } from '@/application/runtime/AirMeshRuntime';
import type { GalleryCursor } from '@/data';

import {
  appendSavedPhotoPagesUntilVisible,
  loadSavedPhotoSequenceThrough,
  shouldPrefetchPhotoPage,
} from './savedPhotoPagination';

describe('saved photo detail pagination', () => {
  it('loads only through the page containing an older selected photo, then reaches 250 in order', async () => {
    const photos = Array.from({ length: 250 }, (_, index) => photo(index));
    const pages = [
      page(photos.slice(0, 120), cursor(119)),
      page(photos.slice(120, 240), cursor(239)),
      page(photos.slice(240), null),
    ];
    const loadPage = pagedLoader(pages);

    const anchored = await loadSavedPhotoSequenceThrough(loadPage, 'media:0130');

    expect(anchored.found).toBe(true);
    expect(anchored.photos).toHaveLength(240);
    expect(anchored.photos.map((item) => item.media.id)).toEqual(
      photos.slice(0, 240).map((item) => item.media.id),
    );
    expect(loadPage).toHaveBeenCalledTimes(2);

    const complete = await appendSavedPhotoPagesUntilVisible(
      anchored,
      loadPage,
      () => true,
    );

    expect(complete.photos).toHaveLength(250);
    expect(complete.photos.at(-1)?.media.id).toBe('media:0249');
    expect(complete.nextCursor).toBeNull();
    expect(loadPage).toHaveBeenCalledTimes(3);
  });

  it('skips non-matching pages so a sparse filtered pager can keep swiping', async () => {
    const initial = {
      photos: [photo(0, 'member:a')],
      nextCursor: cursor(0),
    };
    const loadPage = pagedLoader([
      page([photo(1, 'member:b')], cursor(1)),
      page([photo(2, 'member:a')], null),
    ]);

    const result = await appendSavedPhotoPagesUntilVisible(
      initial,
      loadPage,
      (candidate) => candidate.media.originMemberId === 'member:a',
    );

    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(result.photos.map((item) => item.media.id)).toEqual([
      'media:0000',
      'media:0001',
      'media:0002',
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('prefetches close to the loaded boundary, but never after the final page', () => {
    expect(shouldPrefetchPhotoPage(110, 120, true)).toBe(false);
    expect(shouldPrefetchPhotoPage(111, 120, true)).toBe(true);
    expect(shouldPrefetchPhotoPage(119, 120, false)).toBe(false);
  });
});

function pagedLoader(pages: SavedTripPage[]) {
  let index = 0;
  return vi.fn(async (_cursor: GalleryCursor | null) => {
    const next = pages[index];
    index += 1;
    if (!next) throw new Error('Unexpected extra page request.');
    return next;
  });
}

function page(photos: PhotoView[], nextCursor: GalleryCursor | null): SavedTripPage {
  return {
    trip: {} as SavedTripPage['trip'],
    members: [],
    photos,
    nextCursor,
  };
}

function cursor(index: number): GalleryCursor {
  return { capturedAtMs: 10_000 - index, mediaId: `media:${String(index).padStart(4, '0')}` };
}

function photo(index: number, memberId = 'member:a'): PhotoView {
  return {
    media: {
      id: `media:${String(index).padStart(4, '0')}`,
      originMemberId: memberId,
      shareStatus: 'PUBLISHED',
      captureLocalDate: '2026-07-25',
    },
  } as PhotoView;
}
