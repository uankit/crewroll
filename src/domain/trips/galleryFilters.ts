export type GalleryFilters = Readonly<{
  sourceMembershipId: string | null;
  day: string | null;
  order: "NEWEST" | "OLDEST";
}>;

export const defaultGalleryFilters: GalleryFilters = {
  sourceMembershipId: null,
  day: null,
  order: "NEWEST",
};

export function galleryFilterCount(filters: GalleryFilters): number {
  return (
    Number(filters.sourceMembershipId !== null) +
    Number(filters.day !== null) +
    Number(filters.order !== "NEWEST")
  );
}

/** Calendar-day bounds use the viewer's timezone, including 23/25-hour DST days. */
export function galleryQuery(filters: GalleryFilters): {
  sourceMembershipId?: string;
  capturedFrom?: string;
  capturedBefore?: string;
  order?: "NEWEST" | "OLDEST";
} {
  const query: ReturnType<typeof galleryQuery> =
    filters.order === "NEWEST" ? {} : { order: filters.order };
  if (filters.sourceMembershipId)
    query.sourceMembershipId = filters.sourceMembershipId;
  if (filters.day) {
    const [year, month, day] = filters.day.split("-").map(Number);
    if (!year || !month || !day) throw new Error("Invalid gallery day");
    const from = new Date(year, month - 1, day);
    const before = new Date(year, month - 1, day + 1);
    if (localGalleryDay(from) !== filters.day)
      throw new Error("Invalid gallery day");
    query.capturedFrom = from.toISOString();
    query.capturedBefore = before.toISOString();
  }
  return query;
}

export function localGalleryDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
