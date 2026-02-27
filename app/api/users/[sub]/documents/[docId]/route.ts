import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { sub: string; docId: string } },
) {
  const { error } = await getSupabaseAdmin()
    .from('user_documents')
    .delete()
    .eq('id', params.docId)
    .eq('google_sub', params.sub);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
