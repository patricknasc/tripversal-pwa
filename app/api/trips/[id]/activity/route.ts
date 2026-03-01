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

let webpushConfigured = false;
function getConfiguredWebPush() {
  if (!webpushConfigured && process.env.VAPID_PRIVATE_KEY && process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
    webpush.setVapidDetails(
      'mailto:support@voyasync.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    webpushConfigured = true;
  }
  return webpushConfigured ? webpush : null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, callerName, action, subject } = body;
  if (!callerSub || !action) return NextResponse.json({ error: 'callerSub and action required' }, { status: 400 });

  // SOS broadcast logic (fire-and-forget for speed)
  if (action === 'SOS_ALERT') {
    const wp = getConfiguredWebPush();
    if (wp) {
      const sb = getSupabaseAdmin(); // Renamed to sb for brevity as in the provided diff
      // Fetch trip members (excluding the caller) and their push subscriptions concurrently
      Promise.all([
        sb.from('trips').select('members').eq('id', params.id).single(),
        sb.from('user_trips').select('user_sub').eq('trip_id', params.id).neq('user_sub', callerSub)
      ]).then(async (promisesResults) => {
        const tripData = promisesResults[0]?.data;
        const members = promisesResults[1]?.data;

        if (members && members.length > 0) {
          const memberSubs = members.map((m: any) => m.user_sub);
          const { data: subs } = await sb
            .from('user_push_subscriptions')
            .select('*')
            .in('user_sub', memberSubs);

          if (subs && subs.length > 0) {
            const notifications = subs.map(async (sub: any) => {
              const payload = JSON.stringify({
                title: `🚨 EMERGÊNCIA: ${callerName || 'Membro'} ativou o SOS!`,
                body: `Abra o aplicativo agora para ver a localização ao vivo.`,
                url: `/`
              });
              try {
                await wp.sendNotification(
                  { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                  payload
                );
              } catch (e: any) {
                console.error('Push error:', e);
                if (e.statusCode === 410 || e.statusCode === 404) {
                  await sb.from('user_push_subscriptions').delete().eq('endpoint', sub.endpoint);
                }
              }
            });
            Promise.allSettled(notifications).catch(console.error);
          }
        }
      }).catch(console.error);
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
