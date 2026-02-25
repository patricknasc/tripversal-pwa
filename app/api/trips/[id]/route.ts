import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isAdmin(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('google_sub', googleSub)
    .single();
  return data?.role === 'admin';
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('trips')
    .select(`
      id, owner_id, name, destination, start_date, end_date, budget, created_at,
      trip_members ( id, email, name, avatar_url, google_sub, role, status, invited_at, accepted_at ),
      trip_segments ( id, name, start_date, end_date, origin, destination, color, assigned_member_ids )
    `)
    .eq('id', params.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, name, destination, startDate, endDate, budget } = body;
  if (!(await isAdmin(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updates: any = {};
  if (name !== undefined) updates.name = name;
  if (destination !== undefined) updates.destination = destination;
  if (startDate !== undefined) updates.start_date = startDate;
  if (endDate !== undefined) updates.end_date = endDate;
  if (budget !== undefined) updates.budget = budget;

  const { data, error } = await getSupabaseAdmin()
    .from('trips').update(updates).eq('id', params.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { callerSub } = await req.json();
  const { data: trip } = await getSupabaseAdmin()
    .from('trips').select('owner_id').eq('id', params.id).single();
  if (!trip || trip.owner_id !== callerSub)
    return NextResponse.json({ error: 'Forbidden — only owner can delete' }, { status: 403 });
  await getSupabaseAdmin().from('trips').delete().eq('id', params.id);
  return new NextResponse(null, { status: 204 });
}
