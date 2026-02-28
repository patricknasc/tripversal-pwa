import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('user_budgets')
    .select('*')
    .eq('google_sub', params.sub)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const mapped = (data ?? []).map(row => ({
    ...row,
    sources: row.sources ? (typeof row.sources === 'string' ? JSON.parse(row.sources) : row.sources) : undefined
  }));
  return NextResponse.json(mapped);
}

export async function POST(req: NextRequest, { params }: { params: { sub: string } }) {
  const body = await req.json();
  const { id, name, currency, amount, activeTripId, sources } = body;
  if (!id || !name || !currency || amount == null)
    return NextResponse.json({ error: 'id, name, currency, amount required' }, { status: 400 });

  const sb = getSupabaseAdmin();
  const row = {
    id,
    google_sub: params.sub,
    name,
    currency,
    amount,
    active_trip_id: activeTripId ?? null,
    sources: sources ? JSON.stringify(sources) : null,
    updated_at: new Date().toISOString(),
  };


  const { data, error } = await sb
    .from('user_budgets')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: { sub: string } }) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from('user_budgets')
    .delete()
    .eq('id', id)
    .eq('google_sub', params.sub);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
