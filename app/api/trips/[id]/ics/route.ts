import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

function pad(n: number) { return String(n).padStart(2, '0'); }

function toIcsDate(dateStr: string): string {
  // dateStr: "YYYY-MM-DD" → "YYYYMMDD"
  return dateStr.replace(/-/g, '');
}

function toIcsDateTime(dateStr: string, timeStr: string): string {
  // Returns "YYYYMMDDTHHMMSS" (local, no Z — floating time)
  const [h, m] = timeStr.split(':');
  return `${toIcsDate(dateStr)}T${pad(Number(h))}${pad(Number(m))}00`;
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function generateUid(tripId: string, segId: string, suffix: string): string {
  return `${suffix}-${segId}-${tripId}@tripversal`;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getSupabaseAdmin();

  const { data: trip } = await sb.from('trips').select('name, destination, start_date, end_date').eq('id', params.id).single();
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  const { data: segments } = await sb
    .from('trip_segments')
    .select('id, name, start_date, end_date, origin, destination')
    .eq('trip_id', params.id)
    .order('start_date', { ascending: true });

  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tripversal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(trip.name)}`,
  ];

  for (const seg of (segments ?? [])) {
    // Travel event on start_date
    if (seg.origin && seg.destination && seg.start_date) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${generateUid(params.id, seg.id, 'travel')}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;VALUE=DATE:${toIcsDate(seg.start_date)}`,
        `DTEND;VALUE=DATE:${toIcsDate(seg.start_date)}`,
        `SUMMARY:${escapeIcs(`${seg.origin} → ${seg.destination}`)}`,
        `DESCRIPTION:${escapeIcs(seg.name)}`,
        `LOCATION:${escapeIcs(seg.destination)}`,
        'END:VEVENT',
      );
    }

    // Check-in event on start_date 14:00
    if (seg.start_date) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${generateUid(params.id, seg.id, 'checkin')}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${toIcsDateTime(seg.start_date, '14:00')}`,
        `DTEND:${toIcsDateTime(seg.start_date, '15:00')}`,
        `SUMMARY:${escapeIcs(`Check-in: ${seg.name}`)}`,
        seg.destination ? `LOCATION:${escapeIcs(seg.destination)}` : '',
        'END:VEVENT',
      );
    }

    // Check-out event on end_date 11:00
    if (seg.end_date && seg.end_date !== seg.start_date) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${generateUid(params.id, seg.id, 'checkout')}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${toIcsDateTime(seg.end_date, '11:00')}`,
        `DTEND:${toIcsDateTime(seg.end_date, '12:00')}`,
        `SUMMARY:${escapeIcs(`Check-out: ${seg.name}`)}`,
        seg.destination ? `LOCATION:${escapeIcs(seg.destination)}` : '',
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');

  const body = lines.filter(l => l !== '').join('\r\n');
  const filename = `${trip.name.replace(/[^a-z0-9]/gi, '_')}.ics`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
