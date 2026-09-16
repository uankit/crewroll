import {
  defaultGalleryFilters,
  galleryFilterCount,
  galleryQuery,
} from "./galleryFilters";

test("default is everyone's photos with no date restrictions", () => {
  expect(galleryQuery(defaultGalleryFilters)).toEqual({});
  expect(galleryFilterCount(defaultGalleryFilters)).toBe(0);
});
test("a local day is bounded by the next local midnight", () => {
  const query = galleryQuery({
    sourceMembershipId: "10000000-0000-4000-8000-000000000001",
    day: "2026-09-16",
    order: "OLDEST",
  });
  expect(query.capturedFrom).toBe(new Date(2026, 8, 16).toISOString());
  expect(query.capturedBefore).toBe(new Date(2026, 8, 17).toISOString());
  expect(query.order).toBe("OLDEST");
});
test("invalid calendar days are never silently rolled into another month", () => {
  expect(() =>
    galleryQuery({ ...defaultGalleryFilters, day: "2026-02-30" }),
  ).toThrow("Invalid gallery day");
});
