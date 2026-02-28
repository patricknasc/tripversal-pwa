import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// Upsert user profile on login and return stored profile
export async function POST(req: NextRequest, { params }: { params: { sub: string } }) {
  const body = await req.json();
  const { name, email, avatarUrl } = body;

  const sb = getSupabaseAdmin();
  const row = {
    google_sub: params.sub,
    name: name ?? null,
    email: email ?? null,
    avatar_url: avatarUrl ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from('users')
    .upsert(row, { onConflict: 'google_sub' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('users')
    .select('*')
    .eq('google_sub', params.sub)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
}
