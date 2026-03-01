import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10), 50);
  const { data, error } = await getSupabaseAdmin()
    .from('trip_activity')
    .select('*')
    .eq('trip_id', params.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

import webpush from 'web-push';

webpush.setVapidDetails(
  'mailto:support@voyasync.com',
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, callerName, action, subject } = body;
  if (!callerSub || !action) return NextResponse.json({ error: 'callerSub and action required' }, { status: 400 });

  if (action === 'SOS_ALERT') {
    // Broadcast Web Push to all trip members EXCEPT caller
    const { data: members } = await getSupabaseAdmin()
      .from('user_trips')
      .select('user_sub')
      .eq('trip_id', params.id)
      .neq('user_sub', callerSub);

    if (members && members.length > 0) {
      const memberSubs = members.map((m: any) => m.user_sub);
      const { data: subs } = await getSupabaseAdmin()
        .from('user_push_subscriptions')
        .select('*')
        .in('user_sub', memberSubs);

      if (subs && subs.length > 0) {
        const payload = JSON.stringify({
          title: `🚨 EMERGÊNCIA: ${callerName || 'Membro'} ativou o SOS!`,
          body: `Abra o aplicativo agora para ver a localização ao vivo.`,
          url: `/`
        });

        await Promise.allSettled(subs.map(async sub => {
          try {
            await webpush.sendNotification({
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth }
            }, payload);
          } catch (e: any) {
            if (e.statusCode === 410 || e.statusCode === 404) {
              await getSupabaseAdmin().from('user_push_subscriptions').delete().eq('endpoint', sub.endpoint);
            }
          }
        }));
      }
    }
  }


  const { error } = await getSupabaseAdmin()
    .from('trip_activity')
    .insert({
      trip_id: params.id,
      actor_sub: callerSub,
      actor_name: callerName || 'Member',
      action,
      subject
    });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true }, { status: 201 });
}
