import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { resend, buildInviteEmail } from '@/lib/resend';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { inviterSub, inviterName, email } = await req.json();
  if (!inviterSub || !email) return NextResponse.json({ error: 'inviterSub and email required' }, { status: 400 });
  const sb = getSupabaseAdmin();

  const { data: caller } = await sb
    .from('trip_members').select('role').eq('trip_id', params.id).eq('google_sub', inviterSub).single();
  if (caller?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data: trip } = await sb.from('trips').select('name').eq('id', params.id).single();
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  const { data: member, error: memberErr } = await sb
    .from('trip_members')
    .upsert({ trip_id: params.id, email, role: 'member', status: 'pending' }, { onConflict: 'trip_id,email' })
    .select()
    .single();
  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 });

  const { data: tokenRow, error: tokenErr } = await sb
    .from('invite_tokens')
    .insert({ trip_id: params.id, member_id: member.id, email })
    .select()
    .single();
  if (tokenErr) return NextResponse.json({ error: tokenErr.message }, { status: 500 });

  const { error: emailErr } = await resend().emails.send({
    from: process.env.RESEND_FROM ?? 'Tripversal <onboarding@resend.dev>',
    to: email,
    subject: `${inviterName} invited you to join ${trip.name} on Tripversal`,
    html: buildInviteEmail(inviterName, trip.name, tokenRow.token),
  });

  if (emailErr) {
    console.error('[invite] Resend error:', emailErr);
    return NextResponse.json({ error: `Email failed: ${emailErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ member, token: tokenRow.token }, { status: 201 });
}
