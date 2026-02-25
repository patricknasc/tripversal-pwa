import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isAdmin(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members').select('role').eq('trip_id', tripId).eq('google_sub', googleSub).single();
  return data?.role === 'admin';
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const { callerSub, role } = await req.json();
  if (!(await isAdmin(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { data, error } = await getSupabaseAdmin()
    .from('trip_members').update({ role }).eq('id', params.memberId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const { callerSub } = await req.json();
  if (!(await isAdmin(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await getSupabaseAdmin().from('trip_members').delete().eq('id', params.memberId);
  return new NextResponse(null, { status: 204 });
}
