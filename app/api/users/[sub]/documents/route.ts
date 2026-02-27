import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const { data, error } = await getSupabaseAdmin()
    .from('user_documents')
    .select('id, google_sub, name, doc_type, file_data, created_at')
    .eq('google_sub', params.sub)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: { sub: string } }) {
  const body = await req.json();
  const row = {
    id: body.id ?? undefined, // allow client to provide id for idempotency
    google_sub: params.sub,
    name: body.name,
    doc_type: body.docType,
    file_data: body.fileData,
  };
  const { data, error } = await getSupabaseAdmin()
    .from('user_documents')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
