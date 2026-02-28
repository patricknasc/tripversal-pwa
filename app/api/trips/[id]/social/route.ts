import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const callerSub = req.nextUrl.searchParams.get('callerSub') ?? '';
  const sb = getSupabaseAdmin();

  const { data: posts, error } = await sb
    .from('social_posts')
    .select('*, social_reactions(*)')
    .eq('trip_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = (posts ?? []).map((p: any) => ({
    id: p.id,
    tripId: p.trip_id,
    userSub: p.user_sub,
    userName: p.user_name,
    userAvatar: p.user_avatar ?? undefined,
    mediaUrl: p.media_url,
    mediaType: p.media_type,
    caption: p.caption ?? undefined,
    reactions: p.social_reactions ?? [],
    myReaction: callerSub
      ? (p.social_reactions ?? []).find((r: any) => r.user_sub === callerSub)?.emoji
      : undefined,
    createdAt: p.created_at,
  }));

  return NextResponse.json(result);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getSupabaseAdmin();

  // Ensure bucket exists (no-op if already created)
  await sb.storage.createBucket('social-media', { public: true }).catch(() => {});

  const form = await req.formData();
  const file = form.get('file') as File | null;
  const userSub = (form.get('userSub') as string) ?? '';
  const userName = (form.get('userName') as string) ?? 'Unknown';
  const userAvatar = (form.get('userAvatar') as string) || null;
  const caption = (form.get('caption') as string) || null;

  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });

  const mediaType = file.type.startsWith('video/') ? 'video' : 'photo';
  const ext = file.name.split('.').pop() ?? (mediaType === 'video' ? 'mp4' : 'jpg');
  const path = `${params.id}/${userSub}/${crypto.randomUUID()}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await sb.storage
    .from('social-media')
    .upload(path, buffer, { contentType: file.type, upsert: false });

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });

  const { data: { publicUrl } } = sb.storage.from('social-media').getPublicUrl(path);

  const { data, error } = await sb
    .from('social_posts')
    .insert({ trip_id: params.id, user_sub: userSub, user_name: userName, user_avatar: userAvatar, media_url: publicUrl, media_type: mediaType, caption })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    id: data.id, tripId: data.trip_id, userSub: data.user_sub, userName: data.user_name,
    userAvatar: data.user_avatar, mediaUrl: data.media_url, mediaType: data.media_type,
    caption: data.caption, reactions: [], myReaction: undefined, createdAt: data.created_at,
  }, { status: 201 });
}
