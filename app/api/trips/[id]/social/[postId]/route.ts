import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function PUT(req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { userSub, caption } = await req.json();
  const sb = getSupabaseAdmin();

  const { data: post } = await sb
    .from('social_posts')
    .select('user_sub')
    .eq('id', params.postId)
    .single();

  if (!post) return new NextResponse(null, { status: 404 });
  if (post.user_sub !== userSub) return new NextResponse(null, { status: 403 });

  const { data, error } = await sb
    .from('social_posts')
    .update({ caption: caption ?? null })
    .eq('id', params.postId)
    .select('caption')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ caption: data.caption });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; postId: string } }) {
  const { userSub } = await req.json();
  const sb = getSupabaseAdmin();

  // Fetch post to verify ownership and get storage path
  const { data: post } = await sb
    .from('social_posts')
    .select('user_sub, media_url')
    .eq('id', params.postId)
    .single();

  if (!post) return new NextResponse(null, { status: 404 });
  if (post.user_sub !== userSub) return new NextResponse(null, { status: 403 });

  // Extract storage path from public URL
  try {
    const url = new URL(post.media_url);
    const pathMatch = url.pathname.match(/social-media\/(.+)$/);
    if (pathMatch) {
      await sb.storage.from('social-media').remove([pathMatch[1]]);
    }
  } catch { /* best-effort */ }

  await sb.from('social_posts').delete().eq('id', params.postId);

  return new NextResponse(null, { status: 204 });
}
