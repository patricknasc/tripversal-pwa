import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const sb = getSupabaseAdmin();
  const { data: tokenRow, error } = await sb
    .from('invite_tokens')
    .select('*, trip_members(*), trips(id, name, destination, start_date, end_date)')
    .eq('token', params.token)
    .single();

  if (error || !tokenRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (tokenRow.used_at || new Date(tokenRow.expires_at) < new Date())
    return NextResponse.json({ error: 'Expired or already used' }, { status: 410 });

  return NextResponse.json({
    tripName: tokenRow.trips?.name,
    tripDestination: tokenRow.trips?.destination,
    startDate: tokenRow.trips?.start_date,
    endDate: tokenRow.trips?.end_date,
    tripId: tokenRow.trip_id,
    memberEmail: tokenRow.email,
    memberId: tokenRow.member_id,
  });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const { googleSub, name, avatarUrl } = await req.json();
  const sb = getSupabaseAdmin();

  const { data: tokenRow, error } = await sb
    .from('invite_tokens').select('*').eq('token', params.token).single();

  if (error || !tokenRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (tokenRow.used_at || new Date(tokenRow.expires_at) < new Date())
    return NextResponse.json({ error: 'Expired or already used' }, { status: 410 });

  await sb.from('invite_tokens').update({ used_at: new Date().toISOString() }).eq('id', tokenRow.id);
  await sb.from('trip_members').update({
    google_sub: googleSub, name, avatar_url: avatarUrl,
    status: 'accepted', accepted_at: new Date().toISOString(),
  }).eq('id', tokenRow.member_id);

  const { data: trip } = await sb
    .from('trips')
    .select(`
      id, owner_id, name, destination, start_date, end_date, budget, created_at,
      trip_members ( id, email, name, avatar_url, google_sub, role, status, invited_at, accepted_at ),
      trip_segments ( id, name, start_date, end_date, origin, destination, color, assigned_member_ids )
    `)
    .eq('id', tokenRow.trip_id)
    .single();

  return NextResponse.json(trip);
}
