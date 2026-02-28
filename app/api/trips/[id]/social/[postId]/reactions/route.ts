import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { userSub, userName, userAvatar, emoji } = await req.json();
  const sb = getSupabaseAdmin();

  const { data: existing } = await sb
    .from('social_reactions')
    .select('id, emoji')
    .eq('post_id', params.postId)
    .eq('user_sub', userSub)
    .single();

  if (existing && existing.emoji === emoji) {
    await sb.from('social_reactions').delete().eq('id', existing.id);
  } else if (existing) {
    await sb.from('social_reactions').update({ emoji, user_name: userName ?? null, user_avatar: userAvatar ?? null }).eq('id', existing.id);
  } else {
    await sb.from('social_reactions').insert({ post_id: params.postId, user_sub: userSub, emoji, user_name: userName ?? null, user_avatar: userAvatar ?? null });
  }

  const { data } = await sb.from('social_reactions').select('*').eq('post_id', params.postId);
  return NextResponse.json(data ?? []);
}
