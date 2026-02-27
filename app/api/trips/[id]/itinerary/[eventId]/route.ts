import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function PUT(req: NextRequest, { params }: { params: { id: string; eventId: string } }) {
  const body = await req.json();
  const { callerSub, actorName, title, type, startDt, endDt, location, notes, confirmation, extras } = body;
  const sb = getSupabaseAdmin();

  const updates: any = { updated_by: callerSub, updated_at: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (type !== undefined) updates.type = type;
  if (startDt !== undefined) updates.start_dt = startDt;
  if (endDt !== undefined) updates.end_dt = endDt;
  if (location !== undefined) updates.location = location;
  if (notes !== undefined) updates.notes = notes;
  if (confirmation !== undefined) updates.confirmation = confirmation;
  if (extras !== undefined) updates.extras = extras;

  const { data, error } = await sb
    .from('itinerary_events')
    .update(updates)
    .eq('id', params.eventId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await sb.from('trip_activity').insert({
    trip_id: params.id,
    actor_sub: callerSub,
    actor_name: actorName ?? null,
    action: 'event_updated',
    subject: data.title,
  }).then(null, () => {});

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; eventId: string } }) {
  const { callerSub, actorName } = await req.json();
  const sb = getSupabaseAdmin();

  const { data: evt } = await sb
    .from('itinerary_events')
    .select('title')
    .eq('id', params.eventId)
    .single();

  await sb
    .from('itinerary_events')
    .update({ deleted_at: new Date().toISOString(), updated_by: callerSub })
    .eq('id', params.eventId);

  if (evt) {
    await sb.from('trip_activity').insert({
      trip_id: params.id,
      actor_sub: callerSub,
      actor_name: actorName ?? null,
      action: 'event_deleted',
      subject: evt.title,
    }).then(null, () => {});
  }

  return new NextResponse(null, { status: 204 });
}
