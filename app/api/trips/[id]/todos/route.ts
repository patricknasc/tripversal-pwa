import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
        .from('trip_todos')
        .select('*')
        .eq('trip_id', params.id)
        .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
    const body = await req.json();
    const { title, description, due_date, priority } = body;

    if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
        .from('trip_todos')
        .insert({
            trip_id: params.id,
            title,
            description: description || '',
            due_date: due_date || null,
            priority: priority || 'medium',
        })
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
}
