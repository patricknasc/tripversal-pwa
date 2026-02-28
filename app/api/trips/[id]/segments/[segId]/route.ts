import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isAdmin(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members').select('role').eq('trip_id', tripId).eq('google_sub', googleSub).single();
  return data?.role === 'admin';
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; segId: string } }) {
  const body = await req.json();
  const { callerSub, action, ...fields } = body;

  const sb = getSupabaseAdmin();
  const { data: caller } = await sb
    .from('trip_members').select('id, role').eq('trip_id', params.id).eq('google_sub', callerSub).single();
  const { data: segment } = await sb
    .from('trip_segments').select('*').eq('id', params.segId).single();

  if (!caller || !segment) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Handle membership actions
  if (action === 'accept_invite') {
    if (!segment.invited_member_ids.includes(caller.id)) return NextResponse.json({ error: 'No invite found' }, { status: 400 });
    const newInvited = segment.invited_member_ids.filter((id: string) => id !== caller.id);
    const currentAssigned = segment.assigned_member_ids || [];
    const newAssigned = currentAssigned.includes(caller.id) ? currentAssigned : [...currentAssigned, caller.id];
    const { data, error } = await sb.from('trip_segments').update({ invited_member_ids: newInvited, assigned_member_ids: newAssigned }).eq('id', params.segId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  if (action === 'decline_invite') {
    if (!segment.invited_member_ids.includes(caller.id)) return NextResponse.json({ error: 'No invite found' }, { status: 400 });
    const newInvited = segment.invited_member_ids.filter((id: string) => id !== caller.id);
    const { data, error } = await sb.from('trip_segments').update({ invited_member_ids: newInvited }).eq('id', params.segId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  if (action === 'leave_segment') {
    if (!segment.assigned_member_ids.includes(caller.id)) return NextResponse.json({ error: 'Not a member' }, { status: 400 });
    const newAssigned = segment.assigned_member_ids.filter((id: string) => id !== caller.id);
    const { data, error } = await sb.from('trip_segments').update({ assigned_member_ids: newAssigned }).eq('id', params.segId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  if (action === 'add_invites') {
    // Both Admins and assigned members can invite new people
    const isEditor = caller.role === 'admin' || segment.assigned_member_ids.includes(caller.id);
    if (!isEditor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const newInvites = fields.invitedMemberIds || [];
    // Only invite those not already assigned or invited
    const toAdd = newInvites.filter((id: string) => !segment.assigned_member_ids.includes(id) && !segment.invited_member_ids.includes(id));
    const newInvited = [...segment.invited_member_ids, ...toAdd];
    const { data, error } = await sb.from('trip_segments').update({ invited_member_ids: newInvited }).eq('id', params.segId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Handle general updates
  const isEditor = caller.role === 'admin' || segment.assigned_member_ids.includes(caller.id);
  if (!isEditor) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updates: any = {};
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.startDate !== undefined) updates.start_date = fields.startDate;
  if (fields.endDate !== undefined) updates.end_date = fields.endDate;
  if (fields.origin !== undefined) updates.origin = fields.origin;
  if (fields.destination !== undefined) updates.destination = fields.destination;
  if (fields.color !== undefined) updates.color = fields.color;
  if (fields.visibility !== undefined) updates.visibility = fields.visibility;
  // Note: we don't allow arbitrary assigned_member_ids updates here anymore to enforce the workflow,
  // unless admin wants to force it.
  if (fields.assignedMemberIds !== undefined && caller.role === 'admin') updates.assigned_member_ids = fields.assignedMemberIds;

  const { data, error } = await sb
    .from('trip_segments').update(updates).eq('id', params.segId).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; segId: string } }) {
  let callerSub;
  try {
    const body = await req.json();
    callerSub = body.callerSub;
  } catch (e) {
    const url = new URL(req.url);
    callerSub = url.searchParams.get('callerSub');
  }

  if (!callerSub) return NextResponse.json({ error: 'Missing callerSub' }, { status: 400 });

  const sb = getSupabaseAdmin();
  const { data: caller } = await sb.from('trip_members').select('id, role').eq('trip_id', params.id).eq('google_sub', callerSub).single();
  const { data: segment } = await sb.from('trip_segments').select('assigned_member_ids').eq('id', params.segId).single();

  if (!caller || !segment) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const isAdmin = caller.role === 'admin';
  const isOnlyCreator = segment.assigned_member_ids.length === 1 && segment.assigned_member_ids[0] === caller.id;

  if (!isAdmin && !isOnlyCreator) {
    return NextResponse.json({ error: 'Cannot delete segment with multiple members or that you do not own' }, { status: 403 });
  }

  await sb.from('trip_segments').delete().eq('id', params.segId);
  return new NextResponse(null, { status: 204 });
}
