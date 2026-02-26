export interface AssignedSegment {
  id: string;
  trip_id: string;
  trip_name: string;
  name: string;
  start_date: string; // "YYYY-MM-DD"
  end_date: string;   // "YYYY-MM-DD"
}

export interface ConflictPair {
  a: AssignedSegment;
  b: AssignedSegment;
}

/**
 * Detects cross-trip scheduling conflicts for a single user.
 *
 * Two segments conflict when:
 *   1. They belong to DIFFERENT trips
 *   2. Their date intervals overlap: a.start <= b.end AND b.start <= a.end
 *
 * Segments from the SAME trip never conflict with each other (a hotel and a
 * flight on the same day are expected siblings within a trip).
 *
 * Complexity: O(n log n) sort + O(n²) worst-case inner scan, but the early
 * `break` makes it O(n log n) in the average case. For expected volumes
 * (< 50 segments per user) this is negligible.
 */
export function detectSegmentConflicts(segments: AssignedSegment[]): ConflictPair[] {
  const sorted = [...segments]
    .filter(s => s.start_date && s.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const conflicts: ConflictPair[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // sorted[j].start > sorted[i].end → all subsequent j also won't overlap with i
      if (sorted[j].start_date > sorted[i].end_date) break;
      // cross-trip only — same-trip overlaps are intentional
      if (sorted[i].trip_id !== sorted[j].trip_id) {
        conflicts.push({ a: sorted[i], b: sorted[j] });
      }
    }
  }

  return conflicts;
}
