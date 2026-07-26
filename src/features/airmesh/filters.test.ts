import { describe, expect, it } from 'vitest';

import type { PhotoView } from '@/application/runtime/AirMeshRuntime';

import { filterPhotos } from './filters';

function photo(id: string, memberId: string, date: string, status: 'PUBLISHED' | 'PRIVATE' = 'PUBLISHED') {
  return {
    media: {
      id,
      originMemberId: memberId,
      captureLocalDate: date,
      shareStatus: status,
    },
  } as PhotoView;
}

describe('filterPhotos', () => {
  const photos = [
    photo('one', 'atri', '2026-07-21'),
    photo('two', 'ankit', '2026-07-21'),
    photo('three', 'atri', '2026-07-20'),
    photo('private', 'atri', '2026-07-21', 'PRIVATE'),
  ];

  it('combines deterministic contributor and date filters', () => {
    expect(filterPhotos(photos, { memberId: 'atri', localDate: '2026-07-21' }).map((p) => p.media.id)).toEqual(['one']);
  });

  it('never exposes private candidates in the shared roll', () => {
    expect(filterPhotos(photos, { memberId: null, localDate: null })).toHaveLength(3);
  });
});
