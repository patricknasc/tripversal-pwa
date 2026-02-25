import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('trip_segments').select('*').eq('trip_id', params.id).order('created_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, name, startDate, endDate, origin, destination, color, assignedMemberIds } = body;
  const sb = getSupabaseAdmin();

  const { data: caller } = await sb
    .from('trip_members').select('role').eq('trip_id', params.id).eq('google_sub', callerSub).single();
  if (caller?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await sb.from('trip_segments').insert({
    trip_id: params.id, name,
    start_date: startDate, end_date: endDate,
    origin, destination,
    color: color ?? '#00e5ff',
    assigned_member_ids: assignedMemberIds ?? [],
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
