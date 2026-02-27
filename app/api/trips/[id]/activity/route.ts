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
