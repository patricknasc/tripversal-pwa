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
    source_id: fields.sourceId ?? fields.source_id ?? null,
    type: fields.type ?? 'personal',
    local_amount: fields.localAmount ?? fields.local_amount ?? fields.amount,
    local_currency: fields.localCurrency ?? fields.local_currency ?? fields.currency,
    base_amount: fields.baseAmount ?? fields.base_amount ?? fields.amount,
    base_currency: fields.baseCurrency ?? fields.base_currency ?? fields.currency,
    local_to_base_rate: fields.localToBaseRate ?? fields.local_to_base_rate ?? 1,
    tax_amount: fields.taxAmount ?? fields.tax_amount ?? 0,
    tax_type: fields.taxType ?? fields.tax_type ?? 'fixed',
    discount_amount: fields.discountAmount ?? fields.discount_amount ?? 0,
    discount_type: fields.discountType ?? fields.discount_type ?? 'fixed',
    cambial_rate: fields.cambialRate ?? fields.cambial_rate ?? 1,
    who_paid: fields.whoPaid ?? fields.who_paid ?? null,
    splits: fields.splits ?? null,
    city: fields.city ?? null,
    edit_history: fields.editHistory ?? fields.edit_history ?? null,
    receipt_data: fields.receiptDataUrl ?? fields.receipt_data ?? null,
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
