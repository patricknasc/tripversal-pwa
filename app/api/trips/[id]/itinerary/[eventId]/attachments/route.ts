import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { id: string; eventId: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('itinerary_event_attachments')
    .select('id, event_id, trip_id, name, created_at')
    .eq('event_id', params.eventId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: { id: string; eventId: string } }) {
  const body = await req.json();
  const { id, name, fileData } = body;
  const sb = getSupabaseAdmin();

  const row: any = {
    event_id: params.eventId,
    trip_id: params.id,
    name,
    file_data: fileData,
  };
  if (id) row.id = id;

  const { data, error } = await sb
    .from('itinerary_event_attachments')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
