import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isMember(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members')
    .select('id')
    .eq('trip_id', tripId)
    .eq('google_sub', googleSub)
    .single();
  return !!data;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; segId: string } },
) {
  const callerSub = req.nextUrl.searchParams.get('callerSub');
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await getSupabaseAdmin()
    .from('segment_attachments')
    .select('id, segment_id, trip_id, name, file_data, created_at')
    .eq('segment_id', params.segId)
    .eq('trip_id', params.id)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; segId: string } },
) {
  const body = await req.json();
  const { callerSub, ...fields } = body;
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const row = {
    id: fields.id ?? undefined,
    segment_id: params.segId,
    trip_id: params.id,
    name: fields.name,
    file_data: fields.fileData,
  };
  const { data, error } = await getSupabaseAdmin()
    .from('segment_attachments')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
