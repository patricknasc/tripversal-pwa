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

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; segId: string; attId: string } },
) {
  const { callerSub } = await req.json();
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { error } = await getSupabaseAdmin()
    .from('segment_attachments')
    .delete()
    .eq('id', params.attId)
    .eq('segment_id', params.segId)
    .eq('trip_id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
