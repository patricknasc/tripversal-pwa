import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('social_post_views')
    .select('user_sub, user_name, created_at')
    .eq('post_id', params.postId)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { userSub, userName } = await req.json();
  if (!userSub) return NextResponse.json({ error: 'userSub required' }, { status: 400 });

  // Upsert — one view per user per post (UNIQUE constraint on post_id, user_sub)
  await getSupabaseAdmin()
    .from('social_post_views')
    .upsert(
      { post_id: params.postId, trip_id: params.id, user_sub: userSub, user_name: userName ?? null },
      { onConflict: 'post_id,user_sub', ignoreDuplicates: true }
    );

  return new NextResponse(null, { status: 204 });
}
