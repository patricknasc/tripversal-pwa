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

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, callerName, action, subject } = body;
  if (!callerSub || !action) return NextResponse.json({ error: 'callerSub and action required' }, { status: 400 });

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
