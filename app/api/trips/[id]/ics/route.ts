import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

function pad(n: number) { return String(n).padStart(2, '0'); }

function toIcsDate(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

function toIcsDateTime(dateStr: string, timeStr: string): string {
  const [h, m] = timeStr.split(':');
  return `${toIcsDate(dateStr)}T${pad(Number(h))}${pad(Number(m))}00`;
}

function toIcsDateTimeISO(isoStr: string): string {
  const d = new Date(isoStr);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function generateUid(tripId: string, segId: string, suffix: string): string {
  return `${suffix}-${segId}-${tripId}@tripversal`;
}

function toSequence(updatedAt: string): number {
  return Math.floor(new Date(updatedAt).getTime() / 1000);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const sb = getSupabaseAdmin();

  const { data: trip } = await sb.from('trips').select('name, destination, start_date, end_date').eq('id', params.id).single();
  if (!trip) return NextResponse.json({ error: 'Trip not found' }, { status: 404 });

  const [{ data: segments }, { data: itinEvents }] = await Promise.all([
    sb.from('trip_segments')
      .select('id, name, start_date, end_date, origin, destination')
      .eq('trip_id', params.id)
      .order('start_date', { ascending: true }),
    sb.from('itinerary_events')
      .select('id, type, title, start_dt, end_dt, location, notes, confirmation, updated_at')
      .eq('trip_id', params.id)
      .is('deleted_at', null)
      .order('start_dt', { ascending: true }),
  ]);

  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tripversal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(trip.name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const seg of (segments ?? [])) {
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

  for (const evt of (itinEvents ?? [])) {
    const dtstart = toIcsDateTimeISO(evt.start_dt);
    const dtend = evt.end_dt ? toIcsDateTimeISO(evt.end_dt) : dtstart;
    const descParts = [evt.notes, evt.confirmation ? `Ref: ${evt.confirmation}` : ''].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT',
      `UID:evt-${evt.id}@tripversal`,
      `SEQUENCE:${toSequence(evt.updated_at)}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${dtstart}`,
      `DTEND:${dtend}`,
      `SUMMARY:${escapeIcs(evt.title)}`,
      descParts.length > 0 ? `DESCRIPTION:${escapeIcs(descParts.join(' | '))}` : '',
      evt.location ? `LOCATION:${escapeIcs(evt.location)}` : '',
      'END:VEVENT',
    );
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
