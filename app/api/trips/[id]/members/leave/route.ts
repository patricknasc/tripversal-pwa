import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { callerSub } = await req.json();
  const sb = getSupabaseAdmin();

  // Fetch all accepted members
  const { data: members, error } = await sb
    .from('trip_members')
    .select('id, google_sub, role, status')
    .eq('trip_id', params.id)
    .eq('status', 'accepted');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!members || members.length === 0) return NextResponse.json({ error: 'No members found.' }, { status: 404 });

  const caller = members.find(m => m.google_sub === callerSub);
  if (!caller) return NextResponse.json({ error: 'You are not a member of this trip.' }, { status: 403 });

  // Must keep at least 1 member
  if (members.length === 1) {
    return NextResponse.json({ error: 'You are the only member. Delete the trip instead of leaving.' }, { status: 400 });
  }

  // If caller is the only admin, promote someone else first
  const admins = members.filter(m => m.role === 'admin');
  if (admins.length === 1 && caller.role === 'admin') {
    const nextMember = members.find(m => m.google_sub !== callerSub);
    if (nextMember) {
      await sb.from('trip_members').update({ role: 'admin' }).eq('id', nextMember.id);
    }
  }

  // Remove the caller
  await sb.from('trip_members').delete().eq('id', caller.id);

  return new NextResponse(null, { status: 204 });
}
