import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { userSub, emoji } = await req.json();
  const sb = getSupabaseAdmin();

  // Check existing reaction
  const { data: existing } = await sb
    .from('social_reactions')
    .select('id, emoji')
    .eq('post_id', params.postId)
    .eq('user_sub', userSub)
    .single();

  if (existing && existing.emoji === emoji) {
    // Same emoji → remove (toggle off)
    await sb.from('social_reactions').delete().eq('id', existing.id);
  } else if (existing) {
    // Different emoji → update
    await sb.from('social_reactions').update({ emoji }).eq('id', existing.id);
  } else {
    // New reaction
    await sb.from('social_reactions').insert({ post_id: params.postId, user_sub: userSub, emoji });
  }

  const { data } = await sb.from('social_reactions').select('*').eq('post_id', params.postId);
  return NextResponse.json(data ?? []);
}
