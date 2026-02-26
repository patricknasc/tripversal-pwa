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

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; expenseId: string } },
) {
  const body = await req.json();
  const { callerSub, ...fields } = body;
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.date !== undefined) updates.date = fields.date;
  if (fields.sourceId !== undefined) updates.source_id = fields.sourceId;
  if (fields.type !== undefined) updates.type = fields.type;
  if (fields.localAmount !== undefined) updates.local_amount = fields.localAmount;
  if (fields.localCurrency !== undefined) updates.local_currency = fields.localCurrency;
  if (fields.baseAmount !== undefined) updates.base_amount = fields.baseAmount;
  if (fields.baseCurrency !== undefined) updates.base_currency = fields.baseCurrency;
  if (fields.localToBaseRate !== undefined) updates.local_to_base_rate = fields.localToBaseRate;
  if (fields.whoPaid !== undefined) updates.who_paid = fields.whoPaid;
  if (fields.splits !== undefined) updates.splits = fields.splits;
  if (fields.city !== undefined) updates.city = fields.city;
  if (fields.editHistory !== undefined) updates.edit_history = fields.editHistory;

  const { data, error } = await getSupabaseAdmin()
    .from('expenses')
    .update(updates)
    .eq('id', params.expenseId)
    .eq('trip_id', params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; expenseId: string } },
) {
  const { callerSub } = await req.json();
  if (!callerSub) return NextResponse.json({ error: 'callerSub required' }, { status: 400 });
  if (!(await isMember(params.id, callerSub)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { error } = await getSupabaseAdmin()
    .from('expenses')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', params.expenseId)
    .eq('trip_id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
