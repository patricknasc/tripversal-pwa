import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET /api/trips?userId=SUB
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });
  const sb = getSupabaseAdmin();

  const { data, error } = await sb
    .from('trip_members')
    .select(`
      trip_id,
      trips (
        id, owner_id, name, destination, start_date, end_date, budget, created_at,
        trip_members ( id, email, name, avatar_url, google_sub, role, status, invited_at, accepted_at ),
        trip_segments ( id, name, start_date, end_date, origin, destination, color, assigned_member_ids, created_at )
      )
    `)
    .eq('google_sub', userId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const trips = (data ?? []).map((row: any) => row.trips).filter(Boolean);
  return NextResponse.json(trips);
}

// POST /api/trips  — body: { ownerId, name, destination?, startDate, endDate, budget, ownerName?, ownerAvatarUrl?, email? }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerId, name, destination, startDate, endDate, budget } = body;
  if (!ownerId || !name || !startDate || !endDate)
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  const sb = getSupabaseAdmin();

  const { data: trip, error: tripErr } = await sb
    .from('trips')
    .insert({ owner_id: ownerId, name, destination, start_date: startDate, end_date: endDate, budget })
    .select()
    .single();

  if (tripErr) return NextResponse.json({ error: tripErr.message }, { status: 500 });

  const ownerEmail = body.email ?? `${ownerId}@tripversal.app`;
  await sb.from('trip_members').insert({
    trip_id: trip.id,
    email: ownerEmail,
    name: body.ownerName,
    avatar_url: body.ownerAvatarUrl,
    google_sub: ownerId,
    role: 'admin',
    status: 'accepted',
    accepted_at: new Date().toISOString(),
  });

  const { data: full } = await sb
    .from('trips')
    .select(`
      id, owner_id, name, destination, start_date, end_date, budget, created_at,
      trip_members ( id, email, name, avatar_url, google_sub, role, status, invited_at, accepted_at ),
      trip_segments ( id, name, start_date, end_date, origin, destination, color, assigned_member_ids )
    `)
    .eq('id', trip.id)
    .single();

  return NextResponse.json(full, { status: 201 });
}
