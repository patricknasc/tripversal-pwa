import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isAdmin(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members').select('role').eq('trip_id', tripId).eq('google_sub', googleSub).single();
  return data?.role === 'admin';
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; segId: string } }) {
  const body = await req.json();
  const { callerSub, ...fields } = body;
  if (!(await isAdmin(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updates: any = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.startDate !== undefined) updates.start_date = fields.startDate;
  if (fields.endDate !== undefined) updates.end_date = fields.endDate;
  if (fields.origin !== undefined) updates.origin = fields.origin;
  if (fields.destination !== undefined) updates.destination = fields.destination;
  if (fields.color !== undefined) updates.color = fields.color;
  if (fields.assignedMemberIds !== undefined) updates.assigned_member_ids = fields.assignedMemberIds;

  const { data, error } = await getSupabaseAdmin()
    .from('trip_segments').update(updates).eq('id', params.segId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; segId: string } }) {
  const { callerSub } = await req.json();
  if (!(await isAdmin(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await getSupabaseAdmin().from('trip_segments').delete().eq('id', params.segId);
  return new NextResponse(null, { status: 204 });
}
