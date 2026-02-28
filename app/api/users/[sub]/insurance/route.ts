import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('user_insurance')
    .select('*')
    .eq('google_sub', params.sub)
    .single();
  if (error && error.code !== 'PGRST116')
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? null);
}

export async function PUT(req: NextRequest, { params }: { params: { sub: string } }) {
  const body = await req.json();
  const row = {
    google_sub: params.sub,
    provider: body.provider ?? null,
    policy_number: body.policyNumber ?? null,
    emergency_phone: body.emergencyPhone ?? null,
    coverage_start: body.coverageStart || null,
    coverage_end: body.coverageEnd || null,
    notes: body.notes ?? null,
    sharing: body.sharing ?? false,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseAdmin()
    .from('user_insurance')
    .upsert(row, { onConflict: 'google_sub' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
