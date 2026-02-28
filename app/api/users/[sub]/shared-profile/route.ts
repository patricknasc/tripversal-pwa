import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { sub: string } }) {
  const sb = getSupabaseAdmin();

  const [
    { data: profile },
    { data: medical },
    { data: insurance },
    { data: documents },
  ] = await Promise.all([
    sb.from('users').select('google_sub, name, email, avatar_url').eq('google_sub', params.sub).single(),
    sb.from('user_medical_ids').select('*').eq('google_sub', params.sub).eq('sharing', true).single(),
    sb.from('user_insurance').select('*').eq('google_sub', params.sub).eq('sharing', true).single(),
    sb.from('user_documents').select('id, name, doc_type, file_data, created_at').eq('google_sub', params.sub).eq('sharing', true).order('created_at', { ascending: false }),
  ]);

  return NextResponse.json({
    profile: profile ?? null,
    medical: medical ? {
      bloodType: medical.blood_type,
      contactName: medical.contact_name,
      contactPhone: medical.contact_phone,
      allergies: medical.allergies,
      medications: medical.medications,
      notes: medical.notes,
    } : null,
    insurance: insurance ? {
      provider: insurance.provider,
      policyNumber: insurance.policy_number,
      emergencyPhone: insurance.emergency_phone,
      coverageStart: insurance.coverage_start,
      coverageEnd: insurance.coverage_end,
      notes: insurance.notes,
    } : null,
    documents: (documents ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      docType: d.doc_type,
      dataUrl: d.file_data,
      createdAt: d.created_at,
    })),
  });
}
