import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
        .from('weather_forecasts')
        .select('date, forecast')
        .eq('trip_id', params.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const map: Record<string, any> = {};
    (data || []).forEach(row => {
        map[row.date] = row.forecast;
    });

    return NextResponse.json(map);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
    const body = await req.json(); // Expected: Record<string, { temp, code }>
    const sb = getSupabaseAdmin();

    const rows = Object.entries(body).map(([date, forecast]) => ({
        trip_id: params.id,
        date,
        forecast,
        updated_at: new Date().toISOString()
    }));

    if (rows.length === 0) return NextResponse.json({ success: true });

    const { error } = await sb
        .from('weather_forecasts')
        .upsert(rows, { onConflict: 'trip_id,date' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
}
