import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

function toRecord(row: any) {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    title: row.title,
    startDt: row.start_dt,
    endDt: row.end_dt ?? undefined,
    location: row.location ?? undefined,
    notes: row.notes ?? undefined,
    confirmation: row.confirmation ?? undefined,
    extras: row.extras ?? undefined,
    weather: row.weather ?? undefined,
    createdBy: row.created_by,
    updatedBy: row.updated_by ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('itinerary_events')
    .select('*')
    .eq('trip_id', params.id)
    .is('deleted_at', null)
    .order('start_dt', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json((data ?? []).map(toRecord));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, actorName, id, type, title, startDt, endDt, location, notes, confirmation, extras } = body;
  const sb = getSupabaseAdmin();

  const row: any = {
    trip_id: params.id,
    type,
    title,
    start_dt: startDt,
    end_dt: endDt ?? null,
    location: location ?? null,
    notes: notes ?? null,
    confirmation: confirmation ?? null,
    extras: extras ?? null,
    created_by: callerSub,
    updated_at: new Date().toISOString(),
  };
  if (id) row.id = id;

  const { data, error } = await sb
    .from('itinerary_events')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await sb.from('trip_activity').insert({
    trip_id: params.id,
    actor_sub: callerSub,
    actor_name: actorName ?? null,
    action: 'event_created',
    subject: title,
  }).then(null, () => {});

  return NextResponse.json(toRecord(data), { status: 201 });
}
