import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('user_medical_ids')
    .select('*')
    .eq('google_sub', params.sub)
    .single();
  if (error && error.code !== 'PGRST116') // PGRST116 = no rows found
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? null);
}

export async function PUT(req: NextRequest, { params }: { params: { sub: string } }) {
  const body = await req.json();
  const row = {
    google_sub: params.sub,
    blood_type: body.bloodType ?? null,
    contact_name: body.contactName ?? null,
    contact_phone: body.contactPhone ?? null,
    allergies: body.allergies ?? null,
    medications: body.medications ?? null,
    notes: body.notes ?? null,
    sharing: body.sharing ?? true,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseAdmin()
    .from('user_medical_ids')
    .upsert(row, { onConflict: 'google_sub' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
