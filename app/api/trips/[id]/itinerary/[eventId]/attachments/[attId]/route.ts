import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function DELETE(_req: NextRequest, { params }: { params: { attId: string } }) {
  await getSupabaseAdmin()
    .from('itinerary_event_attachments')
    .delete()
    .eq('id', params.attId);
  return new NextResponse(null, { status: 204 });
}
