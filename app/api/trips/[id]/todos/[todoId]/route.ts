import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function PUT(req: NextRequest, { params }: { params: { id: string; todoId: string } }) {
    const body = await req.json();
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) updates.status = body.status;
    if (body.due_date !== undefined) updates.due_date = body.due_date;
    if (body.priority !== undefined) updates.priority = body.priority;

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
        .from('trip_todos')
        .update(updates)
        .eq('id', params.todoId)
        .eq('trip_id', params.id)
        .select()
        .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string; todoId: string } }) {
    const sb = getSupabaseAdmin();
    const { error } = await sb
        .from('trip_todos')
        .delete()
        .eq('id', params.todoId)
        .eq('trip_id', params.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
}
