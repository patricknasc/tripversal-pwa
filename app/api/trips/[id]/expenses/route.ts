import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

async function isMember(tripId: string, googleSub: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from('trip_members')
    .select('id')
    .eq('trip_id', tripId)
    .eq('google_sub', googleSub)
    .single();
  return !!data;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const callerSub = req.nextUrl.searchParams.get('callerSub');
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await getSupabaseAdmin()
    .from('expenses')
    .select('*')
    .eq('trip_id', params.id)
    .is('deleted_at', null)
    .order('date', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { callerSub, ...fields } = body;
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const row = {
    id: fields.id,
    trip_id: params.id,
    description: fields.description,
    category: fields.category,
    date: fields.date,
    source_id: fields.sourceId,
    type: fields.type ?? 'personal',
    local_amount: fields.localAmount,
    local_currency: fields.localCurrency,
    base_amount: fields.baseAmount,
    base_currency: fields.baseCurrency,
    local_to_base_rate: fields.localToBaseRate ?? 1,
    who_paid: fields.whoPaid ?? null,
    splits: fields.splits ?? null,
    city: fields.city ?? null,
    edit_history: fields.editHistory ?? null,
    receipt_data: fields.receipt_data ?? null,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await getSupabaseAdmin()
    .from('expenses')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
