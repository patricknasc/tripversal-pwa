import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { detectSegmentConflicts, AssignedSegment } from '@/lib/algorithms/segment_conflicts';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const sb = getSupabaseAdmin();

  // 1. All trip memberships for this user (accepted only)
  const { data: memberships, error: memErr } = await sb
    .from('trip_members')
    .select('id, trip_id, trips(id, name)')
    .eq('google_sub', params.sub)
    .eq('status', 'accepted');

  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 });
  if (!memberships || memberships.length === 0) return NextResponse.json({ conflicts: [], segments: [] });

  // 2. For each membership, fetch segments where this member is assigned
  const buckets = await Promise.all(
    memberships.map(async m => {
      const { data } = await sb
        .from('trip_segments')
        .select('id, trip_id, name, start_date, end_date')
        .eq('trip_id', m.trip_id)
        .contains('assigned_member_ids', [m.id])
        .not('start_date', 'is', null)
        .not('end_date', 'is', null);

      return (data ?? []).map(seg => ({
        id: seg.id,
        trip_id: seg.trip_id,
        trip_name: (m.trips as any)?.name ?? '',
        name: seg.name,
        start_date: seg.start_date,
        end_date: seg.end_date,
      }) satisfies AssignedSegment);
    })
  );

  const allSegments = buckets.flat();
  const conflicts = detectSegmentConflicts(allSegments);

  return NextResponse.json({ conflicts, segments: allSegments });
}
