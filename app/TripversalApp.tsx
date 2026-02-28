'use client'

import { useState, useEffect, useRef, useCallback } from "react";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";
import { useNetworkSync } from "@/lib/hooks/use_network_sync";

// ─── Types + Helpers ────────────────────────────────────────────────────────
type Currency = "BRL" | "EUR" | "USD" | "GBP" | "COP";
type SourceType = "balance" | "credit";

interface PaymentSource {
  id: string;
  name: string;
  type: SourceType;
  currency: Currency;
  limit: number;
  limitInBase?: number;
  color: string;
}

interface Expense {
  id: string;
  description: string;
  category: string;
  date: string;
  sourceId: string;
  type: "personal" | "group";
  localAmount: number;
  localCurrency: Currency;
  baseAmount: number;
  baseCurrency: Currency;
  localToBaseRate: number;
  whoPaid?: string;
  splits?: Record<string, number>;
  city?: string;
  receiptDataUrl?: string;
  tripId?: string;
  editHistory?: Array<{
    at: string;
    snapshot: {
      description: string; localAmount: number; category: string;
      date: string; sourceId: string; localCurrency: Currency;
    };
  }>;
}

interface SavedBudget {
  id: string;
  name: string;
  currency: string;
  amount: number;
  activeTripId?: string;
  createdAt: string;
}

interface TripBudget {
  baseCurrency: Currency;
  dailyLimit: number;
  sources: PaymentSource[];
}

interface TripMember {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  googleSub?: string;
  role: "admin" | "member";
  status: "pending" | "accepted";
  invitedAt: string;
  acceptedAt?: string;
}

interface SegmentAttachment {
  id: string;
  segmentId: string;
  tripId: string;
  name: string;
  fileData: string;
  createdAt: string;
}

interface TripSegment {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  origin?: string;
  destination?: string;
  color: string;
  visibility?: 'public' | 'private';
  assignedMemberIds: string[];
  invitedMemberIds?: string[];
  attachments?: SegmentAttachment[]; // metadata only from trips GET; full data in localStorage
}

interface Trip {
  id: string;
  ownerId: string;
  name: string;
  destination?: string;
  startDate: string;
  endDate: string;
  budget: TripBudget;
  crew: TripMember[];
  segments: TripSegment[];
}

type EventCategory = "flight" | "transit" | "checkin" | "hotel" | "activity" | "food" | "car" | "other";

interface ItineraryEvent {
  id: string;
  date: string;           // "YYYY-MM-DD"
  time: string;           // "HH:MM"
  category: EventCategory;
  title: string;
  subtitle?: string;
  location?: { address?: string; lat?: number; lng?: number };
  docUrls?: string[];
  durationMin?: number;
  segmentId?: string;  // source trip_segment.id — used for conflict cross-referencing
  isCustom?: boolean;
  _record?: ItineraryEventRecord;
}

interface ConflictSegment {
  id: string; trip_id: string; trip_name: string;
  name: string; start_date: string; end_date: string;
}
interface SegmentConflict { a: ConflictSegment; b: ConflictSegment; }

type ItinEventType = 'flight' | 'train' | 'bus' | 'car' | 'ferry' | 'hotel_in' | 'hotel_out' | 'tour' | 'meal' | 'event' | 'place' | 'other';

interface ItineraryEventRecord {
  id: string;
  tripId: string;
  type: ItinEventType;
  title: string;
  startDt: string;
  endDt?: string;
  location?: string;
  notes?: string;
  confirmation?: string;
  extras?: Record<string, string>;
  visibility?: 'all' | 'restricted';
  visibleTo?: string[];  // google_subs of members who can see this event
  createdBy: string;
  updatedBy?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface TripActivityItem {
  id: string;
  trip_id: string;
  actor_sub: string;
  actor_name?: string;
  action: string;
  subject?: string;
  created_at: string;
}

interface InviteEvent {
  id: string;
  type: "invited" | "accepted";
  email: string;
  name?: string;
  tripName: string;
  at: string;
}

interface MedicalId {
  bloodType: string;
  contactName: string;
  contactPhone: string;
  allergies: string;
  medications: string;
  notes: string;
  sharing: boolean;
}
interface Insurance {
  provider: string;
  policyNumber: string;
  emergencyPhone: string;
  coverageStart: string;
  coverageEnd: string;
  notes: string;
}
interface TravelDocument {
  id: string;
  name: string;
  docType: string;
  dataUrl: string;
  createdAt: string;
}

const DEFAULT_MEDICAL: MedicalId = { bloodType: '', contactName: '', contactPhone: '', allergies: '', medications: '', notes: '', sharing: true };
const DEFAULT_INSURANCE: Insurance = { provider: '', policyNumber: '', emergencyPhone: '', coverageStart: '', coverageEnd: '', notes: '' };
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const DOC_TYPES = ['Passport', 'Visa', 'Insurance Card', 'Vaccination', 'Driver License', 'Other'];

function calcSummary(budget: TripBudget, expenses: Expense[]) {
  const totalBudgetInBase = budget.sources.reduce(
    (acc, s) => acc + (s.limitInBase ?? s.limit), 0
  );
  const totalSpent = expenses.reduce((sum, e) => sum + e.baseAmount, 0);
  const remaining = totalBudgetInBase - totalSpent;
  const pct = totalBudgetInBase > 0 ? Math.min(totalSpent / totalBudgetInBase, 1) : 0;
  return { totalBudgetInBase, totalSpent, remaining, pct };
}

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  EUR: "€", USD: "$", BRL: "R$", GBP: "£", COP: "COL$",
};
const currSym = (c: Currency) => CURRENCY_SYMBOLS[c] ?? c;

function fmtAmt(n: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

const GlobalStyles = () => (
  <style>{`.no-scrollbar::-webkit-scrollbar{display:none}@keyframes net-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
);

// Use local date to avoid UTC-shift bugs when comparing expense dates
const localDateKey = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

function openMapLink(address?: string, lat?: number, lng?: number) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const query = lat != null && lng != null ? `${lat},${lng}` : encodeURIComponent(address ?? "");
  const url = isIOS
    ? `maps://maps.apple.com/?q=${query}`
    : `https://www.google.com/maps/dir/?api=1&destination=${query}`;
  window.open(url, "_blank");
}

function getDatesRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");
  while (cur <= end) {
    dates.push(localDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function formatDisplayDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en", {
    weekday: "long", day: "numeric", month: "short", year: "numeric",
  });
}

function segmentsToEvents(segments: TripSegment[]): ItineraryEvent[] {
  const events: ItineraryEvent[] = [];
  segments.forEach(seg => {
    if (seg.startDate && seg.origin && seg.destination) {
      events.push({
        id: `${seg.id}-travel`, date: seg.startDate, time: "09:00", category: "flight",
        title: `${seg.origin} → ${seg.destination}`, subtitle: seg.name,
        location: { address: seg.destination }, segmentId: seg.id,
      });
    }
    if (seg.startDate) {
      events.push({
        id: `${seg.id}-checkin`, date: seg.startDate, time: "14:00", category: "checkin",
        title: `Check-in: ${seg.name}`, subtitle: seg.destination,
        location: seg.destination ? { address: seg.destination } : undefined, segmentId: seg.id,
      });
    }
    if (seg.endDate && seg.endDate !== seg.startDate) {
      events.push({
        id: `${seg.id}-checkout`, date: seg.endDate, time: "11:00", category: "hotel",
        title: `Check-out: ${seg.name}`, subtitle: seg.destination, segmentId: seg.id,
      });
    }
  });
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

async function fetchRate(from: Currency, to: Currency): Promise<number> {
  const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
  const data = await res.json();
  return data.rates[to] as number;
}

const DEFAULT_BUDGET: TripBudget = { baseCurrency: "EUR", dailyLimit: 400, sources: [] };

// ─── Icons (inline SVG helpers) ────────────────────────────────────────────
const Icon = ({ d, size = 22, stroke = "currentColor", fill = "none", strokeWidth = 1.8, ...p }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path: string, i: number) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);

const icons: Record<string, any> = {
  home: "M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z",
  map: ["M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z", "M8 2v16", "M16 6v16"],
  wallet: ["M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2z", "M16 12a1 1 0 100 2 1 1 0 000-2z"],
  camera: ["M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z", "M12 17a4 4 0 100-8 4 4 0 000 8z"],
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  settings: ["M12 15a3 3 0 100-6 3 3 0 000 6z", "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"],
  plus: "M12 5v14M5 12h14",
  plane: "M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z",
  ticket: ["M15 5v2", "M15 11v2", "M15 17v2", "M5 5h14a2 2 0 012 2v3a2 2 0 000 4v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3a2 2 0 000-4V7a2 2 0 012-2z"],
  navigation: "M3 11l19-9-9 19-2-8-8-2z",
  phone: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z",
  users: ["M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2", "M9 11a4 4 0 100-8 4 4 0 000 8z", "M23 21v-2a4 4 0 00-3-3.87", "M16 3.13a4 4 0 010 7.75"],
  copy: ["M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2z", "M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"],
  edit: ["M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7", "M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"],
  eye: ["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", "M12 15a3 3 0 100-6 3 3 0 000 6z"],
  share: ["M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8", "M16 6l-4-4-4 4", "M12 2v13"],
  layers: ["M12 2L2 7l10 5 10-5-10-5z", "M2 17l10 5 10-5", "M2 12l10 5 10-5"],
  globe: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M2 12h20", "M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"],
  login: ["M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4", "M10 17l5-5-5-5", "M15 12H3"],
  sun: ["M12 17a5 5 0 100-10 5 5 0 000 10z", "M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"],
  moon: "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  cloud: "M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z",
  heart: "M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z",
  droplet: "M12 2.69l5.66 5.66a8 8 0 11-11.31 0z",
  userCheck: ["M16 11a4 4 0 100-8 4 4 0 000 8z", "M17.5 21H1v-1a7 7 0 0110.807-5.882M22 16l-2 2-1-1"],
  stethoscope: ["M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v11a6 6 0 0012 0V3", "M3 9a9 9 0 0018 0"],
  fileText: ["M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8"],
  wifi: ["M5 12.55a11 11 0 0114.08 0", "M1.42 9a16 16 0 0121.16 0", "M8.53 16.11a6 6 0 016.95 0", "M12 20h.01"],
  refreshCw: ["M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"],
  receipt: ["M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z", "M9 7h6", "M9 11h6", "M9 15h4"],
  food: ["M18 8h1a4 4 0 010 8h-1", "M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z", "M6 1v3", "M10 1v3", "M14 1v3"],
  car: ["M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v9a2 2 0 01-2 2h-2", "M18 17a2 2 0 100-4 2 2 0 000 4z", "M7 17a2 2 0 100-4 2 2 0 000 4z"],
  building: ["M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", "M9 22V12h6v10"],
  tag: ["M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z", "M7 7h.01"],
  shoppingBag: ["M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z", "M3 6h18", "M16 10a4 4 0 01-8 0"],
  moreH: "M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  chevronRight: "M9 18l6-6-6-6",
  bug: ["M8 2l1.88 1.88", "M14.12 3.88L16 2", "M9 7.13v-1a3.003 3.003 0 116 0v1", "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z", "M12 20v-9", "M6.53 9C4.6 8.8 3 7.1 3 5", "M6 13H2", "M3 21c0-2.1 1.7-3.9 3.8-4", "M20.97 5c0 2.1-1.6 3.8-3.5 4", "M22 13h-4", "M20.2 17c2.1.1 3.8 1.9 3.8 4"],
  arrowRight: "M5 12h14M12 5l7 7-7 7",
  clock: ["M12 22a10 10 0 100-20 10 10 0 000 20z", "M12 6v6l4 2"],
  calendar: ["M3 9h18", "M8 3v3", "M16 3v3", "M3 5a2 2 0 012-2h14a2 2 0 012 2v15a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"],
};

const CATEGORY_ICONS: Record<EventCategory, string> = {
  flight: icons.plane, transit: icons.car, checkin: icons.building, hotel: icons.building,
  activity: icons.tag, food: icons.food, car: icons.car, other: icons.calendar,
};

const C = {
  bg: "#0a0a0a", card: "#141414", card2: "#1c1c1e", card3: "#232326",
  border: "#2a2a2e", cyan: "#00e5ff", cyanDim: "#00b8cc", text: "#ffffff",
  textMuted: "#8e8e93", textSub: "#636366", red: "#ff3b30", redDim: "#3d1a1a",
  green: "#30d158", yellow: "#ffd60a", purple: "#1a1333", purpleBorder: "#3d2d6e",
};

function rowToTrip(row: any): Trip {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    budget: row.budget && row.budget.baseCurrency ? row.budget : DEFAULT_BUDGET,
    crew: (row.trip_members || []).map((m: any) => ({
      id: m.id,
      email: m.email,
      name: m.name,
      avatarUrl: m.avatar_url,
      googleSub: m.google_sub,
      role: m.role as "admin" | "member",
      status: m.status as "pending" | "accepted",
      invitedAt: m.invited_at,
      acceptedAt: m.accepted_at,
    })),
    segments: (row.trip_segments || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      startDate: s.start_date,
      endDate: s.end_date,
      origin: s.origin,
      destination: s.destination,
      color: s.color || C.cyan,
      visibility: s.visibility || 'public',
      assignedMemberIds: s.assigned_member_ids || [],
      invitedMemberIds: s.invited_member_ids || [],
      attachments: (s.segment_attachments || []).map((a: any) => ({
        id: a.id,
        segmentId: s.id,
        tripId: row.id,
        name: a.name,
        fileData: '', // not included in trips GET to avoid large payloads
        createdAt: a.created_at,
      })),
    })),
  };
}

function rowToExpense(row: any): Expense {
  return {
    id: row.id,
    description: row.description,
    category: row.category,
    date: row.date,
    sourceId: row.source_id,
    type: row.type as "personal" | "group",
    localAmount: Number(row.local_amount),
    localCurrency: row.local_currency as Currency,
    baseAmount: Number(row.base_amount),
    baseCurrency: row.base_currency as Currency,
    localToBaseRate: Number(row.local_to_base_rate),
    whoPaid: row.who_paid ?? undefined,
    splits: row.splits ?? undefined,
    city: row.city ?? undefined,
    editHistory: row.edit_history ?? undefined,
    receiptDataUrl: row.receipt_data ?? undefined,
    tripId: row.trip_id,
  };
}

function expenseToRow(e: Expense): Record<string, unknown> {
  return {
    id: e.id,
    description: e.description,
    category: e.category,
    date: e.date,
    source_id: e.sourceId,
    type: e.type,
    local_amount: e.localAmount,
    local_currency: e.localCurrency,
    base_amount: e.baseAmount,
    base_currency: e.baseCurrency,
    local_to_base_rate: e.localToBaseRate,
    who_paid: e.whoPaid ?? null,
    splits: e.splits ?? null,
    city: e.city ?? null,
    edit_history: e.editHistory ?? null,
    receipt_data: e.receiptDataUrl ?? null,
    trip_id: e.tripId ?? null,
  };
}

function mergeServerExpenses(stored: Expense[], server: Expense[], tripId: string): Expense[] {
  // If server returned nothing, trust localStorage — table may not have been migrated yet.
  // This prevents the "flash of empty" caused by an uninitialized Supabase table.
  if (server.length === 0) return stored;
  const others = stored.filter(e => e.tripId !== tripId);
  return [...others, ...server].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  const sStr = s.toLocaleDateString("en", { month: "short", day: "numeric" });
  const eStr = e.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  return `${sStr} – ${eStr}`;
}

const INVITE_EVENTS_KEY = 'tripversal_invite_events';
function pushInviteEvent(ev: InviteEvent) {
  try {
    const arr = getInviteEvents();
    localStorage.setItem(INVITE_EVENTS_KEY, JSON.stringify([ev, ...arr].slice(0, 50)));
  } catch { }
}
function getInviteEvents(): InviteEvent[] {
  try { const s = localStorage.getItem(INVITE_EVENTS_KEY); return s ? JSON.parse(s) : []; } catch { return []; }
}

const Avatar = ({ name, src, size = 36, color = C.cyan }: any) => {
  const bg = color === C.cyan ? "#003d45" : "#2a2a2e";
  if (src) return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", border: `2px solid ${color}`, flexShrink: 0 }}>
      <img src={src} alt={name} referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </div>
  );
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: bg, border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700, color, flexShrink: 0, fontFamily: "inherit" }}>
      {(name || "?")[0].toUpperCase()}
    </div>
  );
};

const Badge = ({ children, color = C.cyan, bg }: any) => (
  <span style={{ background: bg || (color === C.cyan ? "#003d45" : "#2a2a2e"), color, border: `1px solid ${color}40`, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
    {children}
  </span>
);

const Toggle = ({ value, onChange }: any) => (
  <div onClick={() => onChange(!value)} style={{ width: 51, height: 31, borderRadius: 16, background: value ? C.cyan : "#3a3a3c", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
    <div style={{ position: "absolute", top: 3, left: value ? 23 : 3, width: 25, height: 25, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.4)" }} />
  </div>
);

const Input = ({ placeholder, value, onChange, style = {} }: any) => (
  <input
    placeholder={placeholder} value={value} onChange={(e: any) => onChange(e.target.value)}
    style={{ background: C.card3, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", color: C.text, fontSize: 15, width: "100%", outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, ...style }}
  />
);

// Renders a segment color dot OR an emoji/flag string
const SegmentIcon = ({ color, size = 10 }: { color: string; size?: number }) => {
  if (color.startsWith('#'))
    return <div style={{ width: size, height: size, borderRadius: "50%", background: color, flexShrink: 0 }} />;
  return <span style={{ fontSize: size * 1.8, lineHeight: 1, flexShrink: 0 }}>{color}</span>;
};

const SEG_FLAGS = ['🇧🇷', '🇺🇸', '🇬🇧', '🇫🇷', '🇩🇪', '🇮🇹', '🇪🇸', '🇵🇹', '🇯🇵', '🇨🇳', '🇰🇷', '🇦🇷', '🇨🇴', '🇲🇽', '🇨🇱', '🇦🇺', '🇳🇿', '🇨🇦', '🇮🇳', '🇷🇺', '🇹🇷', '🇬🇷', '🇳🇱', '🇧🇪', '🇨🇭', '🇦🇹', '🇸🇪', '🇳🇴', '🇩🇰', '🇵🇱', '🇨🇿', '🇸🇬', '🇹🇭', '🇮🇩', '🇻🇳', '🇲🇾', '🇵🇭', '🇪🇬', '🇿🇦', '🇲🇦', '🇮🇱', '🇸🇦', '🇦🇪', '🇺🇾', '🇵🇪', '🇧🇴', '🇪🇨', '🇨🇷', '🇨🇺', '🇭🇺', '🇷🇴', '🇧🇬', '🇭🇷', '🇸🇰', '🇸🇮', '🇷🇸'];
const SEG_EMOJIS = ['✈️', '🚂', '🚢', '🚁', '🏨', '🏝', '🗺️', '🏕', '🌋', '🌊', '🗼', '🗽', '🏰', '🎡', '🎭', '🎿', '⛷️', '🏄', '🎪', '🎨', '🏔', '🌅', '🌃', '🌆', '🌉', '🎠', '🚡', '🛥️', '🏺', '⛩️', '🕌', '🕍', '🏯', '🏟', '🛕', '🗿', '🎑', '🎆', '🎇', '🌄'];

const ITIN_TYPES: { type: ItinEventType; emoji: string; label: string; extras: string[] }[] = [
  { type: 'flight', emoji: '✈️', label: 'Flight', extras: ['From Airport', 'To Airport', 'Airline', 'Flight #', 'Seat', 'Terminal', 'Gate'] },
  { type: 'train', emoji: '🚂', label: 'Train', extras: ['From Station', 'To Station', 'Train #', 'Seat', 'Platform'] },
  { type: 'bus', emoji: '🚌', label: 'Bus', extras: ['From Stop', 'To Stop', 'Bus #', 'Seat'] },
  { type: 'car', emoji: '🚗', label: 'Car', extras: ['Company', 'Pickup', 'Dropoff'] },
  { type: 'ferry', emoji: '⛴️', label: 'Ferry', extras: ['From Port', 'To Port', 'Ferry Name', 'Cabin'] },
  { type: 'hotel_in', emoji: '🏨', label: 'Check-in', extras: ['Hotel', 'Room', 'Address'] },
  { type: 'hotel_out', emoji: '🛏️', label: 'Check-out', extras: ['Hotel', 'Address'] },
  { type: 'tour', emoji: '🗺️', label: 'Tour', extras: ['Operator', 'Meeting Point'] },
  { type: 'meal', emoji: '🍽️', label: 'Meal', extras: ['Restaurant', 'Cuisine', 'Reservation'] },
  { type: 'event', emoji: '🎭', label: 'Event', extras: ['Venue', 'Ticket #'] },
  { type: 'place', emoji: '📍', label: 'Place', extras: ['Address'] },
  { type: 'other', emoji: '📌', label: 'Other', extras: ['Venue'] },
];

function weatherIcon(code: number): string {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 86) return '🌨️';
  return '⛈️';
}

function itinTypeIcon(type: ItinEventType): string {
  if (type === 'flight') return icons.plane;
  if (type === 'train' || type === 'bus') return icons.car;
  if (type === 'car') return icons.car;
  if (type === 'ferry') return icons.layers;
  if (type === 'hotel_in' || type === 'hotel_out') return icons.building;
  if (type === 'tour') return icons.map;
  if (type === 'meal') return icons.food;
  if (type === 'event') return icons.ticket;
  if (type === 'place') return icons.navigation;
  return icons.calendar;
}

function itinRecordToEvent(rec: ItineraryEventRecord): ItineraryEvent & { isCustom: true; _record: ItineraryEventRecord } {
  const dt = new Date(rec.startDt);
  const date = localDateKey(dt);
  const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const cat: EventCategory =
    rec.type === 'flight' ? 'flight' :
      rec.type === 'meal' ? 'food' :
        rec.type === 'car' ? 'car' :
          (rec.type === 'hotel_in' || rec.type === 'hotel_out') ? 'hotel' :
            'activity';
  return {
    id: rec.id, date, time, category: cat,
    title: rec.title,
    subtitle: rec.location,
    location: rec.location ? { address: rec.location } : undefined,
    isCustom: true,
    _record: rec,
  };
}

const Btn = ({ children, onClick, variant = "primary", style = {}, icon }: any) => {
  const styles: any = {
    primary: { background: C.cyan, color: "#000", fontWeight: 700 },
    secondary: { background: C.card3, color: C.text, fontWeight: 600 },
    ghost: { background: "transparent", color: C.text, border: `1.5px solid ${C.border}` },
    danger: { background: C.redDim, color: C.red, fontWeight: 700 },
    white: { background: "#fff", color: "#000", fontWeight: 700 },
  };
  return (
    <button onClick={onClick} style={{ borderRadius: 14, padding: "14px 20px", fontSize: 15, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "opacity 0.15s", fontFamily: "inherit", ...styles[variant], ...style }}>
      {icon && icon}{children}
    </button>
  );
};

const SectionLabel = ({ children, icon, action }: any) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 1.2 }}>
      {icon && <Icon d={icons[icon]} size={14} />}{children}
    </div>
    {action}
  </div>
);

const Card = ({ children, style = {}, onClick }: any) => (
  <div onClick={onClick} style={{ background: C.card, borderRadius: 16, padding: 16, ...style, cursor: onClick ? "pointer" : undefined }}>
    {children}
  </div>
);

const Header = ({ onSettings, isOnline = true, isSyncing = false, user }: any) => {
  const [weather, setWeather] = useState<{ temp: number; code: number; isDay: boolean } | null>(null);
  const [cityName, setCityName] = useState("Localizando...");
  const [localTime, setLocalTime] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

  useEffect(() => {
    const tick = () => {
      setLocalTime(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }));
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [tz]);

  useEffect(() => {
    if (!navigator.geolocation) { setCityName("Paris, France"); return; }
    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude, longitude } }) => {
        try {
          const [wRes, gRes] = await Promise.all([
            fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&timezone=auto`),
            fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, { headers: { "Accept-Language": "en" } }),
          ]);
          const wData = await wRes.json();
          const gData = await gRes.json();
          if (wData.current_weather) {
            setWeather({ temp: Math.round(wData.current_weather.temperature), code: wData.current_weather.weathercode, isDay: wData.current_weather.is_day === 1 });
            if (wData.timezone) setTz(wData.timezone);
          }
          const addr = gData.address || {};
          const city = addr.city || addr.town || addr.village || addr.county || "";
          const country = addr.country || "";
          if (city) setCityName(country ? `${city}, ${country}` : city);
        } catch { setCityName("Paris, France"); }
      },
      () => setCityName("Paris, France")
    );
  }, []);

  const getWeatherIcon = () => {
    if (!weather) return icons.sun;
    const { code, isDay } = weather;
    if (code <= 1) return isDay ? icons.sun : icons.moon;
    if (code <= 48) return icons.cloud;
    return icons.droplet;
  };

  return (
    <div style={{ padding: "12px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}20` }}>
      <div>
        <div style={{ color: C.cyan, fontSize: 13, fontWeight: 800, letterSpacing: 2 }}>TRIPVERSAL</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.textMuted, fontSize: 13 }}>
          <Icon d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a2 2 0 100-4 2 2 0 000 4z" size={13} />
          {cityName}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ background: "#1c1c1e", borderRadius: 20, padding: "6px 12px", display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: isSyncing ? C.yellow : isOnline ? C.green : C.red, animation: isSyncing ? 'net-pulse 1s ease-in-out infinite' : 'none' }} />
          {isSyncing && <span style={{ color: C.yellow, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>SYNC</span>}
          {localTime && <span style={{ color: C.textMuted, fontSize: 12 }}>{localTime}</span>}
          <Icon d={getWeatherIcon()} size={14} stroke={C.textMuted} />
          <span style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>{weather ? `${weather.temp}°C` : "—"}</span>
        </div>
        <button onClick={onSettings} style={{ width: 38, height: 38, borderRadius: "50%", background: "#1c1c1e", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, padding: 0, overflow: "hidden" }}>
          {user?.picture ? (
            <img src={user.picture} alt={user.name} referrerPolicy="no-referrer" style={{ width: 38, height: 38, objectFit: "cover" }} />
          ) : (
            <Icon d={icons.settings} size={18} />
          )}
        </button>
      </div>
    </div>
  );
};

const BottomNav = ({ active, onNav }: any) => {
  const tabs = [
    { id: "home", icon: icons.home },
    { id: "itinerary", icon: icons.map },
    { id: "wallet", icon: icons.wallet },
    { id: "photos", icon: icons.camera },
    { id: "sos", icon: icons.shield },
  ];
  return (
    <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "#111113", borderTop: `1px solid ${C.border}30`, display: "flex", padding: "10px 0 24px", zIndex: 100 }}>
      {tabs.map(t => {
        const isActive = active === t.id;
        return (
          <button key={t.id} onClick={() => onNav(t.id)} style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: isActive ? C.cyan : "transparent", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.2s" }}>
              <Icon d={t.icon} size={20} stroke={isActive ? "#000" : C.textMuted} fill={isActive && t.id === "home" ? "#000" : "none"} strokeWidth={isActive ? 2 : 1.8} />
            </div>
          </button>
        );
      })}
    </div>
  );
};

const HomeScreen = ({ onNav, onAddExpense, onShowGroup, activeTripId, activeTrip, user }: any) => {
  const [budget, setBudget] = useState<TripBudget>(DEFAULT_BUDGET);
  const [todaySpent, setTodaySpent] = useState(0);
  const [yesterdaySpent, setYesterdaySpent] = useState(0);
  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [inviteEvents, setInviteEvents] = useState<InviteEvent[]>([]);
  const [serverActivity, setServerActivity] = useState<TripActivityItem[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<ItineraryEventRecord[]>([]);
  const [visibleCount, setVisibleCount] = useState(10);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [selectedActivityExp, setSelectedActivityExp] = useState<Expense | null>(null);
  const [homeEditMode, setHomeEditMode] = useState(false);
  const [homeEditDesc, setHomeEditDesc] = useState("");
  const [homeEditAmount, setHomeEditAmount] = useState("");
  const [homeEditCat, setHomeEditCat] = useState("");
  const [homeEditDate, setHomeEditDate] = useState("");
  const [homeEditSourceId, setHomeEditSourceId] = useState("");
  const [homeEditCurrency, setHomeEditCurrency] = useState<Currency>("EUR");
  const [homeEditCity, setHomeEditCity] = useState("");
  const [homeConfirmDelete, setHomeConfirmDelete] = useState(false);

  useEffect(() => {
    try {
      const bs = localStorage.getItem('tripversal_budget');
      const b: TripBudget = bs ? JSON.parse(bs) : DEFAULT_BUDGET;
      setBudget(b);
      const es = localStorage.getItem('tripversal_expenses');
      const all: Expense[] = es ? JSON.parse(es) : [];
      const expenses: Expense[] = all
        .filter(e => !e.tripId || !activeTripId || e.tripId === activeTripId)
        .sort((a: Expense, b: Expense) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const todayKey = localDateKey(new Date());
      const yest = new Date(); yest.setDate(yest.getDate() - 1);
      const yesterdayKey = localDateKey(yest);
      setTodaySpent(expenses.filter(e => localDateKey(new Date(e.date)) === todayKey).reduce((s, e) => s + e.baseAmount, 0));
      setYesterdaySpent(expenses.filter(e => localDateKey(new Date(e.date)) === yesterdayKey).reduce((s, e) => s + e.baseAmount, 0));
      setAllExpenses(expenses);
      setInviteEvents(getInviteEvents());
    } catch { }
    // Background hydration from server
    if (activeTripId && user?.sub) {
      const callerSub = user.sub;
      fetch(`/api/trips/${activeTripId}/expenses?callerSub=${callerSub}`)
        .then(r => r.ok ? r.json() : null)
        .then((rows: any[] | null) => {
          if (!rows) return;
          const stored: Expense[] = (() => { try { const s = localStorage.getItem('tripversal_expenses'); return s ? JSON.parse(s) : []; } catch { return []; } })();
          // If server is empty, upload expenses for this trip (one-time migration)
          if (rows.length === 0) {
            // Clean orphaned expenses (no tripId) from localStorage before migrating
            const cleaned = stored.filter(e => !!e.tripId);
            if (cleaned.length !== stored.length) {
              localStorage.setItem('tripversal_expenses', JSON.stringify(cleaned));
            }
            cleaned.filter(e => e.tripId === activeTripId).forEach(e => {
              fetch(`/api/trips/${activeTripId}/expenses`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callerSub, ...expenseToRow(e) }),
              }).catch(() => { });
            });
            return; // keep localStorage as-is
          }
          const merged = mergeServerExpenses(stored, rows.map(rowToExpense), activeTripId);
          localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
          // Use same filter as initial render — includes expenses with no tripId
          const forTrip = merged.filter(e => !e.tripId || !activeTripId || e.tripId === activeTripId);
          const todayKey = localDateKey(new Date());
          const yest = new Date(); yest.setDate(yest.getDate() - 1);
          const yesterdayKey = localDateKey(yest);
          setTodaySpent(forTrip.filter(e => localDateKey(new Date(e.date)) === todayKey).reduce((s, e) => s + e.baseAmount, 0));
          setYesterdaySpent(forTrip.filter(e => localDateKey(new Date(e.date)) === yesterdayKey).reduce((s, e) => s + e.baseAmount, 0));
          setAllExpenses(forTrip);
        })
        .catch(() => { });
      // Fetch activity feed
      fetch(`/api/trips/${activeTripId}/activity?callerSub=${encodeURIComponent(user.sub)}&limit=10`)
        .then(r => r.ok ? r.json() : [])
        .then((rows: TripActivityItem[]) => setServerActivity(rows))
        .catch(() => { });
      // Fetch upcoming itinerary events (next 5)
      fetch(`/api/trips/${activeTripId}/itinerary?callerSub=${encodeURIComponent(user.sub)}`)
        .then(r => r.ok ? r.json() : [])
        .then((evts: ItineraryEventRecord[]) => {
          const now = new Date().toISOString();
          const upcoming = evts.filter(e => e.startDt >= now).slice(0, 5);
          setUpcomingEvents(upcoming);
        })
        .catch(() => { });
    }
  }, [activeTripId]);

  const sourceMap = Object.fromEntries(budget.sources.map(s => [s.id, s]));

  const saveHomeExpenses = (arr: Expense[]) => {
    const sorted = [...arr].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setAllExpenses(sorted);
    localStorage.setItem('tripversal_expenses', JSON.stringify(sorted));
  };
  const handleHomeDelete = (id: string) => {
    const exp = allExpenses.find(e => e.id === id);
    if (exp) {
      try {
        const prev = localStorage.getItem('tripversal_deleted_expenses');
        const arr = prev ? JSON.parse(prev) : [];
        localStorage.setItem('tripversal_deleted_expenses',
          JSON.stringify([{ ...exp, deletedAt: new Date().toISOString() }, ...arr]));
      } catch { }
    }
    saveHomeExpenses(allExpenses.filter(e => e.id !== id));
    setSelectedActivityExp(null); setHomeConfirmDelete(false);
    // Background soft-delete on server
    if (exp?.tripId && user?.sub) {
      fetch(`/api/trips/${exp.tripId}/expenses/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      }).catch(() => { });
    }
  };
  const handleHomeEdit = (id: string) => {
    const next = allExpenses.map(e => {
      if (e.id !== id) return e;
      const snap = { description: e.description, localAmount: e.localAmount, category: e.category, date: e.date, sourceId: e.sourceId, localCurrency: e.localCurrency };
      return {
        ...e, description: homeEditDesc, localAmount: parseFloat(homeEditAmount) || e.localAmount,
        category: homeEditCat, date: homeEditDate ? new Date(`${homeEditDate}T12:00:00`).toISOString() : e.date,
        sourceId: homeEditSourceId || e.sourceId, localCurrency: homeEditCurrency, city: homeEditCity || e.city,
        editHistory: [...(e.editHistory || []), { at: new Date().toISOString(), snapshot: snap }]
      };
    });
    saveHomeExpenses(next);
    setHomeEditMode(false); setSelectedActivityExp(null);
    // Background update on server
    const updated = next.find(e => e.id === id);
    if (updated?.tripId && user?.sub) {
      fetch(`/api/trips/${updated.tripId}/expenses/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, ...expenseToRow(updated) }),
      }).catch(() => { });
    }
  };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) setVisibleCount(c => c + 10); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [allExpenses.length]);

  const pct = budget.dailyLimit > 0 ? Math.min(todaySpent / budget.dailyLimit, 1) : 0;
  const barColor = pct > 0.85 ? C.red : pct > 0.6 ? C.yellow : C.cyan;

  // Badge: compare today vs yesterday
  let badgeArrow = "—";
  let badgeLabel = "—";
  let badgeBg = C.card3;
  let badgeColor = C.textMuted;
  if (yesterdaySpent > 0) {
    const diff = ((todaySpent - yesterdaySpent) / yesterdaySpent) * 100;
    badgeLabel = `${Math.abs(diff).toFixed(0)}%`;
    if (todaySpent <= yesterdaySpent) {
      badgeArrow = "↘"; badgeBg = "#1a2a1a"; badgeColor = C.green;
    } else {
      badgeArrow = "↗"; badgeBg = "#2a1400"; badgeColor = C.yellow;
    }
  } else if (todaySpent > 0) {
    badgeArrow = "↗"; badgeLabel = `${(pct * 100).toFixed(0)}%`;
    badgeBg = "#1a2a1a"; badgeColor = C.green;
  }

  return (
    <div style={{ padding: "0 0 100px" }}>
      <div style={{ padding: "16px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 40, fontWeight: 800, color: C.text, letterSpacing: -1 }}>{currSym(budget.baseCurrency)}{fmtAmt(todaySpent)}</span>
            <span style={{ color: C.textMuted, fontSize: 18 }}>/ {currSym(budget.baseCurrency)}{fmtAmt(budget.dailyLimit, 0)}</span>
          </div>
          <div style={{ background: badgeBg, color: badgeColor, borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
            <span>{badgeArrow}</span> {badgeLabel}
          </div>
        </div>
        <div style={{ height: 6, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${pct * 100}%`, height: "100%", background: barColor, borderRadius: 4, transition: "width 0.3s" }} />
        </div>
        {yesterdaySpent > 0 && (
          <div style={{ color: C.textSub, fontSize: 11, marginTop: 6, textAlign: "right" }}>
            vs yesterday {currSym(budget.baseCurrency)}{fmtAmt(yesterdaySpent)}
          </div>
        )}
      </div>
      {(() => {
        const events: ItineraryEvent[] = activeTrip ? segmentsToEvents(activeTrip.segments) : [];
        const todayStr = localDateKey(new Date());
        const nowStr = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
        const next = events.find(e => e.date > todayStr || (e.date === todayStr && e.time >= nowStr));
        if (!next) return null;
        const eventDate = new Date(`${next.date}T${next.time}:00`);
        const diffMs = eventDate.getTime() - Date.now();
        const diffH = Math.floor(diffMs / 3_600_000);
        const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
        const timeLabel = diffMs < 0 ? "NOW" : diffH > 0 ? `IN ${diffH}H ${diffM}M` : `IN ${diffM}M`;
        const catIcon = CATEGORY_ICONS[next.category] || icons.calendar;
        return (
          <div style={{ margin: "16px 20px 0", background: "linear-gradient(135deg, #0d2526 0%, #0a1a1a 100%)", borderRadius: 20, padding: 20, border: `1px solid ${C.cyan}20` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ background: "#003d4520", border: `1px solid ${C.cyan}40`, borderRadius: 20, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6, color: C.cyan, fontSize: 12, fontWeight: 700 }}>
                <Icon d={icons.clock} size={12} stroke={C.cyan} /> {timeLabel}
              </div>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#ffffff15", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon d={catIcon} size={20} stroke={C.text} />
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>{next.title}</div>
            {next.subtitle && <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 14 }}>{next.subtitle}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              {next.location?.address && (
                <Btn style={{ flex: 1, borderRadius: 12 }} variant="secondary" onClick={() => openMapLink(next.location?.address, next.location?.lat, next.location?.lng)} icon={<Icon d={icons.navigation} size={16} />}>Directions</Btn>
              )}
              <Btn style={{ flex: 1, borderRadius: 12 }} variant="secondary" onClick={() => onNav("itinerary")} icon={<Icon d={icons.calendar} size={16} />}>Itinerary</Btn>
            </div>
          </div>
        );
      })()}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, margin: "16px 20px 0" }}>
        {[
          { label: "EXPENSE", icon: icons.plus, action: onAddExpense },
          { label: "PHOTO", icon: icons.camera, action: () => onNav("photos") },
          { label: "GROUP", icon: icons.users, action: onShowGroup },
          { label: "SOS", icon: icons.phone, variant: "red" },
        ].map(({ label, icon, variant, action }: any) => (
          <button key={label} onClick={action} style={{ background: variant === "red" ? C.redDim : C.card2, borderRadius: 16, padding: "16px 8px", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <Icon d={icon} size={22} stroke={variant === "red" ? C.red : C.cyan} />
            <span style={{ color: variant === "red" ? C.red : C.textMuted, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{label}</span>
          </button>
        ))}
      </div>
      <div style={{ margin: "20px 20px 0" }}>
        <SectionLabel>RECENT ACTIVITY</SectionLabel>
        {(() => {
          const activityItems = [
            ...allExpenses.map(e => ({ kind: 'expense' as const, at: e.date, data: e })),
            ...inviteEvents.map(ev => ({ kind: 'event' as const, at: ev.at, data: ev })),
            ...serverActivity.map(a => ({ kind: 'activity' as const, at: a.created_at, data: a })),
            ...upcomingEvents.map(e => ({ kind: 'upcoming' as const, at: e.startDt, data: e })),
          ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

          if (activityItems.length === 0) return (
            <Card>
              <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "8px 0" }}>No expenses yet. Tap + to add one.</div>
            </Card>
          );

          return activityItems.slice(0, visibleCount).map(item => {
            if (item.kind === 'upcoming') {
              const e = item.data as ItineraryEventRecord;
              const evtEmojis: Record<string, string> = { flight: '✈️', train: '🚂', bus: '🚌', car: '🚗', ferry: '⛴️', hotel_in: '🏨', hotel_out: '🛏️', tour: '🗺️', meal: '🍽️', event: '🎭', place: '📍', other: '📌' };
              const emoji = evtEmojis[e.type] || '📅';
              const dt = new Date(e.startDt);
              const isToday = localDateKey(dt) === localDateKey(new Date());
              return (
                <Card key={`up-${e.id}`} style={{ marginBottom: 8, borderLeft: `3px solid ${C.cyan}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>{emoji}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{e.title}</div>
                      <div style={{ color: C.textMuted, fontSize: 12 }}>{e.location || 'Itinerary'}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 11, color: isToday ? C.cyan : C.textMuted, fontWeight: isToday ? 700 : 400 }}>{isToday ? 'Today' : dt.toLocaleDateString("en", { month: "short", day: "numeric" })}</div>
                      <div style={{ fontSize: 10, color: C.textSub }}>{dt.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                  </div>
                </Card>
              );
            }
            if (item.kind === 'activity') {
              const a = item.data as TripActivityItem;
              const actionLabel = a.action === 'event_created' ? 'added' : a.action === 'event_updated' ? 'updated' : 'removed';
              return (
                <Card key={`act-${a.id}`} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>📅</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {a.actor_name || a.actor_sub.slice(0, 8)} {actionLabel}: {a.subject}
                      </div>
                      <div style={{ color: C.textMuted, fontSize: 12 }}>Itinerary event</div>
                    </div>
                    <div style={{ color: C.textMuted, fontSize: 11, flexShrink: 0 }}>
                      {new Date(a.created_at).toLocaleDateString("en", { day: "numeric", month: "short" })}
                    </div>
                  </div>
                </Card>
              );
            }
            if (item.kind === 'event') {
              const ev = item.data as InviteEvent;
              return (
                <Card key={`ev-${ev.id}`} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>
                      {ev.type === 'invited' ? '✉️' : '✅'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {ev.type === 'invited' ? `Invited ${ev.email}` : `${ev.name || ev.email} joined`}
                      </div>
                      <div style={{ color: C.textMuted, fontSize: 12 }}>{ev.tripName}</div>
                    </div>
                    <div style={{ color: C.textMuted, fontSize: 11, flexShrink: 0 }}>
                      {new Date(ev.at).toLocaleDateString("en", { day: "numeric", month: "short" })}
                    </div>
                  </div>
                </Card>
              );
            }
            const exp = item.data as Expense;
            const catIcon = categories.find(c => c.id === exp.category)?.icon || icons.moreH;
            const timeStr = new Date(exp.date).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
            const dateStr = new Date(exp.date).toLocaleDateString("en", { day: "numeric", month: "short" });
            return (
              <Card key={exp.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon d={catIcon} size={18} stroke={C.cyan} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{exp.description}</div>
                    <div style={{ color: C.textMuted, fontSize: 12 }}>
                      {exp.city ? `📍 ${exp.city} • ` : ""}{exp.category.toUpperCase()} • {dateStr}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ color: C.textMuted, fontSize: 11 }}>{timeStr}</div>
                    <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)}</div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); setSelectedActivityExp(exp); setHomeEditMode(false); setHomeConfirmDelete(false); }}
                    style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", flexShrink: 0 }}>
                    <Icon d={icons.moreH} size={16} stroke={C.textMuted} />
                  </button>
                </div>
              </Card>
            );
          });
        })()}
        {visibleCount < allExpenses.length && (
          <div ref={sentinelRef} style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ color: C.textSub, fontSize: 12 }}>Loading more...</div>
          </div>
        )}
        {visibleCount >= allExpenses.length && allExpenses.length > 10 && (
          <div style={{ color: C.textSub, fontSize: 11, textAlign: "center", padding: "12px 0" }}>All {allExpenses.length} transactions shown</div>
        )}
      </div>
      {selectedActivityExp && (() => {
        const exp = selectedActivityExp;
        return (
          <>
            <div onClick={() => { setSelectedActivityExp(null); setHomeEditMode(false); setHomeConfirmDelete(false); }}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200 }} />
            <div style={{
              position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
              width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0",
              padding: "20px 20px 40px", zIndex: 201, maxHeight: "80vh", overflowY: "auto"
            }}>
              <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: "0 auto 16px" }} />
              {!homeEditMode && !homeConfirmDelete ? (
                <>
                  {exp.receiptDataUrl && <img src={exp.receiptDataUrl} style={{ width: "100%", borderRadius: 12, marginBottom: 16, maxHeight: 180, objectFit: "cover" }} />}
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 2 }}>{exp.description}</div>
                  {exp.city && <div style={{ color: C.cyan, fontSize: 12, marginBottom: 4 }}>📍 {exp.city}</div>}
                  <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>
                    {new Date(exp.date).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })} · {new Date(exp.date).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>LOCAL</div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)}</div>
                    </div>
                    {exp.localCurrency !== exp.baseCurrency && (
                      <div style={{ background: C.card3, borderRadius: 12, padding: 12, flex: 1 }}>
                        <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>BASE</div>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>{currSym(exp.baseCurrency)}{fmtAmt(exp.baseAmount)}</div>
                      </div>
                    )}
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>SOURCE</div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{sourceMap[exp.sourceId]?.name || "—"}</div>
                    </div>
                  </div>
                  {exp.editHistory && exp.editHistory.length > 0 && (
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, marginBottom: 16 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>EDIT HISTORY</div>
                      {exp.editHistory.map((h, i) => (
                        <div key={i} style={{ color: C.textSub, fontSize: 11, marginBottom: 4 }}>
                          {new Date(h.at).toLocaleString("en")} — was "{h.snapshot.description}" {currSym(h.snapshot.localCurrency)}{fmtAmt(h.snapshot.localAmount)}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="secondary" icon={<Icon d={icons.edit} size={16} />}
                      onClick={() => { setHomeEditDesc(exp.description); setHomeEditAmount(String(exp.localAmount)); setHomeEditCat(exp.category); setHomeEditDate(exp.date.slice(0, 10)); setHomeEditSourceId(exp.sourceId); setHomeEditCurrency(exp.localCurrency); setHomeEditCity(exp.city || ""); setHomeEditMode(true); }}>
                      Edit
                    </Btn>
                    <Btn style={{ flex: 1 }} variant="danger" icon={<Icon d={icons.trash} size={16} stroke={C.red} />}
                      onClick={() => setHomeConfirmDelete(true)}>Delete</Btn>
                  </div>
                </>
              ) : homeConfirmDelete ? (
                <>
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.red, marginBottom: 8 }}>Delete transaction?</div>
                    <div style={{ color: C.textMuted, fontSize: 13 }}>It will be archived and cannot be undone.</div>
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setHomeConfirmDelete(false)}>Cancel</Btn>
                    <Btn style={{ flex: 1 }} variant="danger" onClick={() => handleHomeDelete(exp.id)}>Delete</Btn>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 16 }}>Edit Transaction</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DESCRIPTION</div>
                    <Input value={homeEditDesc} onChange={setHomeEditDesc} placeholder="Description" />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>AMOUNT</div>
                    <Input value={homeEditAmount} onChange={setHomeEditAmount} placeholder="0.00" />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DATE</div>
                    <Card style={{ display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
                      <input type="date" value={homeEditDate} onChange={e => setHomeEditDate(e.target.value)}
                        style={{ background: "transparent", border: "none", color: C.text, flex: 1, outline: "none", fontFamily: "inherit", colorScheme: "dark" }} />
                    </Card>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>LOCATION</div>
                    <Card style={{ display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
                      <input value={homeEditCity} onChange={e => setHomeEditCity(e.target.value)} placeholder="City"
                        style={{ background: "transparent", border: "none", color: C.text, flex: 1, outline: "none", fontFamily: "inherit", fontSize: 14 }} />
                    </Card>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CATEGORY</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {categories.map(c => (
                        <button key={c.id} onClick={() => setHomeEditCat(c.id)} style={{ background: homeEditCat === c.id ? "#003d45" : C.card3, border: homeEditCat === c.id ? `2px solid ${C.cyan}` : "2px solid transparent", borderRadius: 10, padding: "8px 12px", cursor: "pointer", color: homeEditCat === c.id ? C.cyan : C.textMuted, fontSize: 12, fontWeight: homeEditCat === c.id ? 700 : 400, fontFamily: "inherit" }}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {budget.sources.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>SOURCE</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {budget.sources.map(s => (
                          <button key={s.id} onClick={() => setHomeEditSourceId(s.id)} style={{ background: homeEditSourceId === s.id ? "#003d45" : C.card3, border: homeEditSourceId === s.id ? `2px solid ${s.color}` : "2px solid transparent", borderRadius: 10, padding: "8px 12px", cursor: "pointer", color: homeEditSourceId === s.id ? C.text : C.textMuted, fontSize: 12, fontFamily: "inherit" }}>
                            {s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setHomeEditMode(false)}>Cancel</Btn>
                    <Btn style={{ flex: 1 }} onClick={() => handleHomeEdit(exp.id)}>Save Changes</Btn>
                  </div>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
};

const ItineraryScreen = ({ activeTripId, activeTrip, userSub }: { activeTripId: string | null; activeTrip?: Trip | null; userSub?: string }) => {
  const [now, setNow] = useState(() => new Date());
  const todayKey = localDateKey(now);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [conflicts, setConflicts] = useState<SegmentConflict[]>([]);

  // Custom events
  const [itinEvents, setItinEvents] = useState<ItineraryEventRecord[]>([]);
  const [showEventForm, setShowEventForm] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [evtType, setEvtType] = useState<ItinEventType>('other');
  const [evtTitle, setEvtTitle] = useState('');
  const [evtDate, setEvtDate] = useState('');
  const [evtTime, setEvtTime] = useState('12:00');
  const [evtEndDate, setEvtEndDate] = useState('');
  const [evtEndTime, setEvtEndTime] = useState('');
  const [evtLocation, setEvtLocation] = useState('');
  const [evtNotes, setEvtNotes] = useState('');
  const [evtConfirmation, setEvtConfirmation] = useState('');
  const [evtExtras, setEvtExtras] = useState<Record<string, string>>({});
  const [evtVisibility, setEvtVisibility] = useState<'all' | 'restricted'>('all');
  const [evtVisibleTo, setEvtVisibleTo] = useState<string[]>([]);
  const [evtAttachments, setEvtAttachments] = useState<Array<{ id: string; name: string; fileData: string }>>([]);
  const [evtSaving, setEvtSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [weatherMap, setWeatherMap] = useState<Record<string, { temp: number; code: number }>>({});
  const [countdown, setCountdown] = useState<{ title: string; remaining: string } | null>(null);

  // Tick every 30s
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fetch cross-trip conflicts
  useEffect(() => {
    if (!userSub) return;
    fetch(`/api/users/${encodeURIComponent(userSub)}/segment-conflicts`)
      .then(r => r.ok ? r.json() : { conflicts: [] })
      .then(d => setConflicts(d.conflicts ?? []))
      .catch(() => { });
  }, [userSub]);

  // Load custom itinerary events
  useEffect(() => {
    if (!activeTripId) { setItinEvents([]); return; }
    const lsKey = `tripversal_itin_${activeTripId}`;
    try {
      const stored = localStorage.getItem(lsKey);
      if (stored) setItinEvents(JSON.parse(stored));
    } catch { }
    if (userSub) {
      fetch(`/api/trips/${activeTripId}/itinerary?callerSub=${encodeURIComponent(userSub)}`)
        .then(r => r.ok ? r.json() : null)
        .then((rows: ItineraryEventRecord[] | null) => {
          if (!rows) return;
          setItinEvents(rows);
          localStorage.setItem(lsKey, JSON.stringify(rows));
        })
        .catch(() => { });
    }
  }, [activeTripId]);

  // Weather from Open-Meteo using segment destinations
  useEffect(() => {
    if (!activeTripId || !activeTrip) return;
    const segments = (activeTrip.segments || []).filter((s: any) => s.destination || s.name);
    if (segments.length === 0) return;

    const today = localDateKey(new Date());
    const endD = new Date(); endD.setDate(endD.getDate() + 15);
    const endDate = localDateKey(endD);

    const geocodeCache: Record<string, { lat: number; lon: number }> = {};

    Promise.all(
      segments.map(async (seg: any) => {
        const loc = seg.destination || seg.name;
        if (!loc) return null;
        if (!geocodeCache[loc]) {
          try {
            const gRes = await fetch(
              `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(loc)}&format=json&limit=1`,
              { headers: { 'Accept-Language': 'en' } }
            );
            const gData = await gRes.json();
            if (gData[0]) geocodeCache[loc] = { lat: parseFloat(gData[0].lat), lon: parseFloat(gData[0].lon) };
            else return null;
          } catch { return null; }
        }
        const coords = geocodeCache[loc];
        if (!coords) return null;

        const segDates = new Set(
          getDatesRange(seg.startDate ?? today, seg.endDate ?? seg.startDate ?? today)
        );

        try {
          const wRes = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=temperature_2m_max,weathercode&timezone=auto&start_date=${today}&end_date=${endDate}`
          );
          const d = await wRes.json();
          if (!d.daily?.time) return null;
          const entries: Record<string, { temp: number; code: number }> = {};
          d.daily.time.forEach((date: string, i: number) => {
            if (segDates.has(date)) {
              entries[date] = { temp: Math.round(d.daily.temperature_2m_max[i]), code: d.daily.weathercode[i] };
            }
          });
          return entries;
        } catch { return null; }
      })
    ).then(results => {
      const map: Record<string, { temp: number; code: number }> = {};
      results.forEach(entries => { if (entries) Object.assign(map, entries); });
      if (Object.keys(map).length > 0) setWeatherMap(map);
    });
  }, [activeTripId, activeTrip?.segments?.length]);

  // Countdown to next event today
  useEffect(() => {
    const today = localDateKey(now);
    const nowMs = now.getTime();
    const next = itinEvents
      .filter(e => !e.deletedAt && new Date(e.startDt).getTime() > nowMs && localDateKey(new Date(e.startDt)) === today)
      .sort((a, b) => new Date(a.startDt).getTime() - new Date(b.startDt).getTime())[0];
    if (!next) { setCountdown(null); return; }
    const diffMs = new Date(next.startDt).getTime() - nowMs;
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.floor((diffMs % 3_600_000) / 60_000);
    setCountdown({ title: next.title, remaining: h > 0 ? `${h}h ${m}m` : `${m}m` });
  }, [now, itinEvents]);

  const segEvents: ItineraryEvent[] = activeTrip ? segmentsToEvents(activeTrip.segments) : [];
  const activeItinEvents = itinEvents.filter(e => !e.deletedAt);
  const customEventDates = activeItinEvents.map(e => localDateKey(new Date(e.startDt)));

  const eventDates = segEvents.map(e => e.date);
  // Include every day within each segment's date range (not just event trigger days)
  const segmentRangeDates = activeTrip?.segments.flatMap(seg =>
    seg.startDate ? getDatesRange(seg.startDate, seg.endDate ?? seg.startDate) : []
  ) ?? [];
  const allDates = activeTrip
    ? [...getDatesRange(activeTrip.startDate, activeTrip.endDate), ...eventDates, ...customEventDates, ...segmentRangeDates]
    : [todayKey, ...customEventDates];
  const dateRange = Array.from(new Set(allDates)).sort();

  useEffect(() => {
    if (!activeTrip) { setSelectedDay(localDateKey(new Date())); return; }
    const today = localDateKey(new Date());
    if (dateRange.includes(today)) { setSelectedDay(today); return; }
    const firstEvent = [...eventDates, ...customEventDates].sort()[0];
    setSelectedDay(firstEvent ?? activeTrip.startDate);
  }, [activeTripId]);

  const daySegEvents = segEvents.filter(e => e.date === selectedDay);
  const dayCustomEvents = activeItinEvents
    .filter(e => localDateKey(new Date(e.startDt)) === selectedDay)
    .map(rec => itinRecordToEvent(rec));
  const allDayEvents = [...daySegEvents, ...dayCustomEvents]
    .sort((a, b) => a.time.localeCompare(b.time));

  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const nowEventId: string | null = selectedDay === todayKey
    ? (allDayEvents.filter(e => e.time <= nowTime).at(-1)?.id ?? null)
    : null;

  const getStatus = (e: ItineraryEvent): "done" | "now" | "upcoming" => {
    if (e.id === nowEventId) return "now";
    if (e.date < todayKey || (e.date === todayKey && e.time < nowTime)) return "done";
    return "upcoming";
  };

  const daySelectorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = daySelectorRef.current?.querySelector<HTMLElement>("[data-selected=true]");
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedDay]);

  const dayConflicts = conflicts.filter(c =>
    (c.a.start_date <= selectedDay && c.a.end_date >= selectedDay) ||
    (c.b.start_date <= selectedDay && c.b.end_date >= selectedDay)
  );
  const conflictingSegIds = new Set(
    conflicts.flatMap(c => [c.a, c.b]).filter(s => s.trip_id === activeTripId).map(s => s.id)
  );
  const conflictingTripNames = Array.from(new Set(
    dayConflicts.flatMap(c => [c.a, c.b]).filter(s => s.trip_id !== activeTripId).map(s => s.trip_name)
  ));

  const saveItinEvents = (arr: ItineraryEventRecord[]) => {
    setItinEvents(arr);
    if (activeTripId) localStorage.setItem(`tripversal_itin_${activeTripId}`, JSON.stringify(arr));
  };

  const openAddForm = () => {
    setEditingEventId(null);
    setEvtType('other'); setEvtTitle(''); setEvtDate(selectedDay); setEvtTime('12:00');
    setEvtEndDate(''); setEvtEndTime(''); setEvtLocation(''); setEvtNotes('');
    setEvtConfirmation(''); setEvtExtras({}); setEvtVisibility('all'); setEvtVisibleTo([]); setEvtAttachments([]);
    setShowEventForm(true);
  };

  const openEditForm = (rec: ItineraryEventRecord) => {
    const dt = new Date(rec.startDt);
    const endDt = rec.endDt ? new Date(rec.endDt) : null;
    setEditingEventId(rec.id);
    setEvtType(rec.type); setEvtTitle(rec.title);
    setEvtDate(localDateKey(dt));
    setEvtTime(`${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`);
    setEvtEndDate(endDt ? localDateKey(endDt) : '');
    setEvtEndTime(endDt ? `${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}` : '');
    setEvtLocation(rec.location || ''); setEvtNotes(rec.notes || '');
    setEvtConfirmation(rec.confirmation || ''); setEvtExtras(rec.extras || {});
    setEvtVisibility(rec.visibility ?? 'all'); setEvtVisibleTo(rec.visibleTo ?? []);
    setEvtAttachments([]);
    setShowEventForm(true);
  };

  const handleSaveEvent = async () => {
    if (!evtTitle.trim() || !evtDate || !evtTime) return;
    setEvtSaving(true);
    const startDt = new Date(`${evtDate}T${evtTime}:00`).toISOString();
    const endDt = evtEndDate && evtEndTime ? new Date(`${evtEndDate}T${evtEndTime}:00`).toISOString() : undefined;
    const ts = new Date().toISOString();
    const extrasObj = Object.keys(evtExtras).length > 0 ? evtExtras : undefined;
    const visibilityVal = evtVisibility === 'restricted' ? 'restricted' : 'all';
    const visibleToVal = evtVisibility === 'restricted' ? evtVisibleTo : [];
    let savedId: string;

    if (editingEventId) {
      savedId = editingEventId;
      const updated: ItineraryEventRecord = {
        ...itinEvents.find(e => e.id === editingEventId)!,
        type: evtType, title: evtTitle.trim(), startDt, endDt,
        location: evtLocation || undefined, notes: evtNotes || undefined,
        confirmation: evtConfirmation || undefined, extras: extrasObj,
        visibility: visibilityVal, visibleTo: visibleToVal, updatedAt: ts,
      };
      saveItinEvents(itinEvents.map(e => e.id === editingEventId ? updated : e));
      if (activeTripId) {
        fetch(`/api/trips/${activeTripId}/itinerary/${editingEventId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callerSub: userSub, actorName: null, type: evtType, title: evtTitle.trim(), startDt, endDt: endDt ?? null, location: evtLocation || null, notes: evtNotes || null, confirmation: evtConfirmation || null, extras: extrasObj ?? null, visibility: visibilityVal, visibleTo: visibleToVal }),
        }).catch(() => { });
      }
    } else {
      savedId = crypto.randomUUID();
      const newRec: ItineraryEventRecord = {
        id: savedId, tripId: activeTripId!, type: evtType, title: evtTitle.trim(), startDt, endDt,
        location: evtLocation || undefined, notes: evtNotes || undefined,
        confirmation: evtConfirmation || undefined, extras: extrasObj,
        visibility: visibilityVal, visibleTo: visibleToVal,
        createdBy: userSub!, createdAt: ts, updatedAt: ts,
      };
      saveItinEvents([...itinEvents, newRec]);
      if (activeTripId) {
        fetch(`/api/trips/${activeTripId}/itinerary`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callerSub: userSub, actorName: null, id: savedId, type: evtType, title: evtTitle.trim(), startDt, endDt: endDt ?? null, location: evtLocation || null, notes: evtNotes || null, confirmation: evtConfirmation || null, extras: extrasObj ?? null, visibility: visibilityVal, visibleTo: visibleToVal }),
        }).catch(() => { });
      }
    }
    // Upload attachments (fire-and-forget)
    evtAttachments.forEach(att => {
      fetch(`/api/trips/${activeTripId}/itinerary/${savedId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: userSub, id: att.id, name: att.name, fileData: att.fileData }),
      }).catch(() => { });
    });
    setEvtAttachments([]);
    setShowEventForm(false);
    setEvtSaving(false);
  };

  const handleDeleteEvent = (id: string) => {
    const ts = new Date().toISOString();
    saveItinEvents(itinEvents.map(e => e.id === id ? { ...e, deletedAt: ts } : e));
    if (activeTripId) {
      fetch(`/api/trips/${activeTripId}/itinerary/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: userSub, actorName: null }),
      }).catch(() => { });
    }
    setConfirmDeleteId(null);
  };

  const extrasForType = ITIN_TYPES.find(t => t.type === evtType)?.extras ?? [];

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div style={{ padding: "16px 20px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Itinerary</div>
          <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>
            {formatDisplayDate(selectedDay)}{activeTrip?.destination ? ` · ${activeTrip.destination}` : ""}
          </div>
        </div>
        {activeTripId && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, marginTop: 4 }}>
            <a href={`/api/trips/${activeTripId}/ics`} download
              style={{ color: C.cyan, fontSize: 12, display: "flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
              <Icon d={icons.calendar} size={13} stroke={C.cyan} /> Export
            </a>
            <button onClick={() => {
              const url = `webcal://${typeof window !== 'undefined' ? window.location.host : ''}/api/trips/${activeTripId}/ics`;
              navigator.clipboard.writeText(url).catch(() => { });
            }} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 12, display: "flex", alignItems: "center", gap: 4, padding: 0, fontFamily: "inherit" }}>
              <Icon d={icons.refreshCw} size={13} stroke={C.textMuted} /> Subscribe
            </button>
          </div>
        )}
      </div>

      {/* Day selector */}
      <div ref={daySelectorRef} style={{ overflowX: "auto" }} className="no-scrollbar">
        <div style={{ display: "flex", gap: 8, padding: "0 20px 16px", width: "max-content" }}>
          {dateRange.map(day => {
            const isSel = day === selectedDay;
            const isToday = day === todayKey;
            const hasEvents = segEvents.some(e => e.date === day) || activeItinEvents.some(e => localDateKey(new Date(e.startDt)) === day);
            const d = new Date(day + "T12:00:00");
            const wx = weatherMap[day];
            return (
              <div key={day} data-selected={isSel} onClick={() => setSelectedDay(day)}
                style={{
                  padding: "8px 12px", borderRadius: 12, cursor: "pointer", flexShrink: 0,
                  background: isSel ? C.cyan : C.card,
                  color: isSel ? "#000" : isToday ? C.cyan : C.text,
                  border: `1px solid ${isSel ? C.cyan : isToday ? C.cyan + "40" : C.border}`,
                  fontSize: 13, fontWeight: isSel ? 700 : 400,
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 44,
                }}>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{d.toLocaleDateString("en", { weekday: "short" })}</span>
                <span>{d.getDate()}</span>
                {wx ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
                    <span style={{ fontSize: 11 }}>{weatherIcon(wx.code)}</span>
                    <span style={{ fontSize: 9, opacity: 0.8 }}>{wx.temp}°</span>
                  </div>
                ) : (
                  <div style={{ width: 4, height: 4, borderRadius: "50%", background: hasEvents ? (isSel ? "#000" : C.cyan) : "transparent", marginTop: 1 }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Countdown */}
      {countdown && selectedDay === todayKey && (
        <div style={{ margin: "0 20px 12px", background: `${C.cyan}12`, border: `1px solid ${C.cyan}30`, borderRadius: 12, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 13, color: C.textMuted }}>
            Next: <span style={{ color: C.text, fontWeight: 600 }}>{countdown.title}</span>
          </div>
          <div style={{ background: C.cyan, color: "#000", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
            in {countdown.remaining}
          </div>
        </div>
      )}

      {/* Conflict banner */}
      {dayConflicts.length > 0 && (
        <div style={{ margin: "0 20px 12px", background: `${C.yellow}18`, border: `1px solid ${C.yellow}50`, borderRadius: 12, padding: "10px 14px", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
          <div>
            <div style={{ color: C.yellow, fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Scheduling conflict</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>
              You are assigned to overlapping segments in{" "}
              {conflictingTripNames.map((n, i) => (
                <span key={n}><strong style={{ color: C.text }}>{n}</strong>{i < conflictingTripNames.length - 1 ? " and " : ""}</span>
              ))}.
            </div>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div style={{ padding: "0 20px", position: "relative" }}>
        {allDayEvents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: C.textMuted }}>
            <Icon d={icons.calendar} size={32} stroke={C.textMuted} />
            <div style={{ marginTop: 12, fontSize: 14 }}>
              {segEvents.length === 0 && itinEvents.length === 0
                ? "Add segment dates or tap + to create your first event"
                : "No events on this day"}
            </div>
          </div>
        ) : (
          <>
            <div style={{ position: "absolute", left: 39, top: 0, bottom: 0, width: 2, background: `linear-gradient(to bottom, ${C.cyan}40, ${C.cyan}10)` }} />
            {allDayEvents.map(event => {
              const status = getStatus(event);
              const isNow = status === "now";
              const isDone = status === "done";
              const isConflict = !!event.segmentId && conflictingSegIds.has(event.segmentId);
              const rec = event._record;
              const typeCfg = rec ? ITIN_TYPES.find(t => t.type === rec.type) : null;
              const catIcon = rec ? itinTypeIcon(rec.type) : (CATEGORY_ICONS[event.category] ?? icons.tag);
              const hasMap = event.location && (event.location.address || event.location.lat != null);
              return (
                <div key={event.id} style={{ display: "flex", gap: 16, marginBottom: 16, position: "relative" }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: "50%", flexShrink: 0, zIndex: 1,
                    background: isNow ? C.cyan : isDone ? "#1a2a1a" : C.card3,
                    border: `2px solid ${isNow ? C.cyan : isDone ? C.green : isConflict ? C.yellow : C.border}`,
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18
                  }}>
                    {typeCfg
                      ? <span>{typeCfg.emoji}</span>
                      : <Icon d={catIcon} size={16} stroke={isNow ? "#000" : isDone ? C.green : isConflict ? C.yellow : C.textMuted} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      background: isNow ? `${C.cyan}15` : C.card, borderRadius: 14, padding: 14,
                      border: isNow ? `1px solid ${C.cyan}30` : isConflict ? `1px solid ${C.yellow}40` : "none"
                    }}>
                      {isNow && <div style={{ color: C.cyan, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>● NOW</div>}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 15, color: isDone ? C.textMuted : C.text }}>{event.title}</div>
                          {event.subtitle && <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{event.subtitle}</div>}
                          {rec?.confirmation && <div style={{ color: C.textSub, fontSize: 11, marginTop: 2 }}>Ref: {rec.confirmation}</div>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                          {isConflict && <span style={{ fontSize: 12 }}>⚠️</span>}
                          {rec?.visibility === 'restricted' && <span style={{ fontSize: 11 }} title="Restricted — visible to selected members only">🔒</span>}
                          <span style={{ color: C.textSub, fontSize: 12 }}>{event.time}</span>
                          {event.isCustom && rec && (
                            <>
                              <button onClick={() => openEditForm(rec)} style={{ background: C.card3, border: "none", borderRadius: 6, padding: "3px 5px", cursor: "pointer" }}>
                                <Icon d={icons.edit} size={13} stroke={C.textMuted} />
                              </button>
                              <button onClick={() => setConfirmDeleteId(event.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: "3px 2px" }}>
                                <Icon d={icons.trash} size={13} stroke={C.red} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {rec?.extras && Object.keys(rec.extras).some(k => rec.extras![k]) && (
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" as const, gap: 4 }}>
                          {Object.entries(rec.extras).map(([k, v]) => v ? (
                            <span key={k} style={{ background: C.card3, borderRadius: 6, padding: "2px 8px", fontSize: 11, color: C.textMuted }}>{k}: {v}</span>
                          ) : null)}
                        </div>
                      )}
                      {!isDone && hasMap && (
                        <div style={{ marginTop: 10 }}>
                          <div onClick={() => openMapLink(event.location?.address, event.location?.lat, event.location?.lng)}
                            style={{ display: "inline-flex", background: C.card3, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: C.textMuted, alignItems: "center", gap: 4, cursor: "pointer" }}>
                            <Icon d={icons.navigation} size={12} /> Map
                          </div>
                        </div>
                      )}
                      {rec?.notes && (
                        <div style={{ marginTop: 8, color: C.textSub, fontSize: 12, fontStyle: "italic", borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
                          {rec.notes}
                        </div>
                      )}
                      {rec?.location && (
                        <a href={`https://maps.google.com/maps?q=${encodeURIComponent(rec.location)}`} target="_blank" rel="noreferrer"
                          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: C.cyan, textDecoration: "none", marginTop: 4 }}>
                          📍 {rec.location}
                        </a>
                      )}
                      {confirmDeleteId === event.id && (
                        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                          <button onClick={() => handleDeleteEvent(event.id)} style={{ flex: 1, background: C.redDim, border: `1px solid ${C.red}40`, borderRadius: 8, padding: "8px", color: C.red, cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 700 }}>Delete</button>
                          <button onClick={() => setConfirmDeleteId(null)} style={{ flex: 1, background: C.card3, border: "none", borderRadius: 8, padding: "8px", color: C.textMuted, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>Cancel</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* FAB: Add event */}
      {activeTripId && !showEventForm && (
        <button onClick={openAddForm}
          style={{ position: "fixed", bottom: 88, right: "calc(50% - 200px)", width: 56, height: 56, borderRadius: "50%", background: C.cyan, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 20px rgba(0,229,255,0.35)", zIndex: 110 }}>
          <Icon d={icons.plus} size={24} stroke="#000" strokeWidth={2.5} />
        </button>
      )}

      {/* Event form (bottom sheet) */}
      {showEventForm && (
        <>
          <div onClick={() => setShowEventForm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200 }} />
          <div style={{ position: "fixed", bottom: 0, left: "max(0px, calc(50% - 215px))", right: "max(0px, calc(50% - 215px))", background: C.card, borderRadius: "24px 24px 0 0", padding: "20px 20px 44px", zIndex: 201, maxHeight: "92vh", overflowY: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{editingEventId ? "Edit Event" : "Add Event"}</div>
              <button onClick={() => setShowEventForm(false)} style={{ background: C.card3, border: "none", borderRadius: "50%", width: 30, height: 30, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon d={icons.x} size={16} stroke={C.textMuted} />
              </button>
            </div>

            {/* Type grid 4×3 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>TYPE</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                {ITIN_TYPES.map(t => (
                  <button key={t.type} onClick={() => { setEvtType(t.type); setEvtExtras({}); }}
                    style={{ background: evtType === t.type ? `${C.cyan}20` : C.card3, border: `1.5px solid ${evtType === t.type ? C.cyan : "transparent"}`, borderRadius: 10, padding: "10px 4px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 20 }}>{t.emoji}</span>
                    <span style={{ fontSize: 10, color: evtType === t.type ? C.cyan : C.textMuted, fontFamily: "inherit" }}>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TITLE *</div>
              <input value={evtTitle} onChange={e => setEvtTitle(e.target.value)}
                placeholder={ITIN_TYPES.find(t => t.type === evtType)?.label ?? "Event title"}
                style={{ width: "100%", boxSizing: "border-box" as const, background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
            </div>

            {/* Date + Time */}
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 2 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DATE *</div>
                <Card style={{ padding: "10px 14px" }}>
                  <input type="date" value={evtDate} onChange={e => setEvtDate(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} />
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TIME *</div>
                <Card style={{ padding: "10px 14px" }}>
                  <input type="time" value={evtTime} onChange={e => setEvtTime(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} />
                </Card>
              </div>
            </div>

            {/* End Date + Time */}
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 2 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END DATE</div>
                <Card style={{ padding: "10px 14px" }}>
                  <input type="date" value={evtEndDate} onChange={e => setEvtEndDate(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} />
                </Card>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END TIME</div>
                <Card style={{ padding: "10px 14px" }}>
                  <input type="time" value={evtEndTime} onChange={e => setEvtEndTime(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} />
                </Card>
              </div>
            </div>

            {/* Location */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>LOCATION</div>
              <input value={evtLocation} onChange={e => setEvtLocation(e.target.value)} placeholder="Airport, hotel, restaurant…"
                style={{ width: "100%", boxSizing: "border-box" as const, background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
              {evtLocation.trim() && (
                <a href={`https://maps.google.com/maps?q=${encodeURIComponent(evtLocation)}`} target="_blank" rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 6, fontSize: 12, color: C.cyan, textDecoration: "none" }}>
                  📍 Preview in Maps
                </a>
              )}
            </div>

            {/* Booking ref */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>BOOKING REF</div>
              <input value={evtConfirmation} onChange={e => setEvtConfirmation(e.target.value)} placeholder="Confirmation number"
                style={{ width: "100%", boxSizing: "border-box" as const, background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit" }} />
            </div>

            {/* Type-specific extras */}
            {extrasForType.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DETAILS</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {extrasForType.map(field => (
                    <input key={field} value={evtExtras[field] || ''} onChange={e => setEvtExtras(prev => ({ ...prev, [field]: e.target.value }))}
                      placeholder={field}
                      style={{ background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "10px 12px", color: C.text, fontSize: 13, outline: "none", fontFamily: "inherit" }} />
                  ))}
                </div>
              </div>
            )}

            {/* Visibility */}
            {activeTrip && activeTrip.crew.filter(m => m.status === 'accepted' && m.googleSub && m.googleSub !== userSub).length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>VISIBILITY</div>
                <div style={{ display: "flex", gap: 8, marginBottom: evtVisibility === 'restricted' ? 10 : 0 }}>
                  {(['all', 'restricted'] as const).map(v => (
                    <button key={v} onClick={() => { setEvtVisibility(v); if (v === 'all') setEvtVisibleTo([]); }}
                      style={{
                        flex: 1, background: evtVisibility === v ? (v === 'restricted' ? '#3a1a1a' : C.card3) : C.card2,
                        border: `1.5px solid ${evtVisibility === v ? (v === 'restricted' ? C.red + '60' : C.cyan + '60') : C.border}`,
                        borderRadius: 10, padding: "10px 0", color: evtVisibility === v ? (v === 'restricted' ? C.red : C.cyan) : C.textMuted,
                        cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600
                      }}>
                      {v === 'all' ? '🌐 Everyone' : '🔒 Restricted'}
                    </button>
                  ))}
                </div>
                {evtVisibility === 'restricted' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                    {activeTrip.crew.filter(m => m.status === 'accepted' && m.googleSub && m.googleSub !== userSub).map(m => {
                      const sub = m.googleSub!;
                      const selected = evtVisibleTo.includes(sub);
                      return (
                        <button key={sub} onClick={() => setEvtVisibleTo(prev => selected ? prev.filter(s => s !== sub) : [...prev, sub])}
                          style={{
                            background: selected ? `${C.cyan}20` : C.card2,
                            border: `1.5px solid ${selected ? C.cyan + '60' : C.border}`,
                            borderRadius: 20, padding: "6px 14px", color: selected ? C.cyan : C.textMuted,
                            cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600
                          }}>
                          {m.name || m.email}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Notes */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>NOTES</div>
              <textarea value={evtNotes} onChange={e => setEvtNotes(e.target.value)} placeholder="Additional notes…" rows={3}
                style={{ width: "100%", boxSizing: "border-box" as const, background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", color: C.text, fontSize: 14, outline: "none", fontFamily: "inherit", resize: "none" as const }} />
            </div>

            {/* Attachments */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>ATTACHMENTS</div>
              {evtAttachments.map(att => (
                <div key={att.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, background: C.card3, borderRadius: 10, padding: "8px 12px" }}>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{att.name}</div>
                  <button onClick={() => setEvtAttachments(p => p.filter(a => a.id !== att.id))} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={C.red} strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
              <label style={{ display: "flex", alignItems: "center", gap: 8, background: C.card3, border: `1.5px dashed ${C.border}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer" }}>
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={C.cyan} strokeWidth={2} strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                <span style={{ fontSize: 13, color: C.cyan, fontWeight: 600 }}>Add photo or file</span>
                <input type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    setEvtAttachments(p => [...p, { id: crypto.randomUUID(), name: file.name, fileData: reader.result as string }]);
                  };
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }} />
              </label>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowEventForm(false)} style={{ flex: 1, background: C.card3, border: "none", borderRadius: 14, padding: "14px", color: C.textMuted, cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>Cancel</button>
              <button onClick={handleSaveEvent} disabled={evtSaving || !evtTitle.trim() || !evtDate || !evtTime}
                style={{ flex: 2, background: evtSaving || !evtTitle.trim() ? C.card3 : C.cyan, border: "none", borderRadius: 14, padding: "14px", color: evtSaving || !evtTitle.trim() ? C.textMuted : "#000", cursor: "pointer", fontSize: 14, fontWeight: 700, fontFamily: "inherit" }}>
                {evtSaving ? "Saving…" : editingEventId ? "Save Changes" : "Add Event"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const WalletScreen = ({ onAddExpense, activeTripId, user, trips = [] }: any) => {
  const [budget, setBudgetState] = useState<TripBudget>(DEFAULT_BUDGET);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [activeSavedBudget, setActiveSavedBudget] = useState<SavedBudget | null>(null);
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCat, setEditCat] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editSourceId, setEditSourceId] = useState("");
  const [editCurrency, setEditCurrency] = useState<Currency>("EUR");
  const [editCity, setEditCity] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [visibleTxCount, setVisibleTxCount] = useState(10);
  const [walletTab, setWalletTab] = useState<'transactions' | 'analytics' | 'wallet'>('transactions');
  const txSentinelRef = useRef<HTMLDivElement>(null);

  // --- New Budget & Payment Sources States ---
  const [savedBudgets, setSavedBudgets] = useState<SavedBudget[]>(() => {
    try { const s = localStorage.getItem('tripversal_saved_budgets'); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [showAddBudget, setShowAddBudget] = useState(false);
  const [budgetName, setBudgetName] = useState('');
  const [formBudgetCurrency, setFormBudgetCurrency] = useState<Currency>('USD');
  const [budgetAmount, setBudgetAmount] = useState('');

  const [showAddSource, setShowAddSource] = useState(false);
  const [srcName, setSrcName] = useState("");
  const [srcType, setSrcType] = useState<SourceType>("balance");
  const [srcCurrency, setSrcCurrency] = useState<Currency>("EUR");
  const [srcAmount, setSrcAmount] = useState("");
  const [srcColor, setSrcColor] = useState("#00e5ff");
  const [srcSaving, setSrcSaving] = useState(false);
  const srcColors = ["#00e5ff", "#30d158", "#ffd60a", "#ff3b30", "#f57c00", "#6a1b9a", "#1565c0", "#e91e8c"];

  useEffect(() => {
    try {
      const bs = localStorage.getItem('tripversal_budget');
      if (bs) setBudgetState(JSON.parse(bs));
      const es = localStorage.getItem('tripversal_expenses');
      if (es) {
        const all = JSON.parse(es) as Expense[];
        const filtered = all.filter(e => !e.tripId || !activeTripId || e.tripId === activeTripId);
        setExpenses(filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
      }
      // Read active SavedBudget for this trip
      if (activeTripId) {
        const budgets: SavedBudget[] = JSON.parse(localStorage.getItem('tripversal_saved_budgets') || '[]');
        const found = budgets.find(b => b.activeTripId === activeTripId) ??
          (() => { const id = localStorage.getItem(`tripversal_active_budget_${activeTripId}`); return id ? budgets.find(b => b.id === id) : undefined; })() ?? null;
        setActiveSavedBudget(found ?? null);
      }
    } catch { }
    // Background hydration from server
    if (activeTripId && user?.sub) {
      const callerSub = user.sub;
      fetch(`/api/trips/${activeTripId}/expenses?callerSub=${callerSub}`)
        .then(r => r.ok ? r.json() : null)
        .then((rows: any[] | null) => {
          if (!rows) return;
          const stored: Expense[] = (() => { try { const s = localStorage.getItem('tripversal_expenses'); return s ? JSON.parse(s) : []; } catch { return []; } })();
          // If server is empty, upload expenses for this trip (one-time migration)
          if (rows.length === 0) {
            // Clean orphaned expenses (no tripId) from localStorage before migrating
            const cleaned = stored.filter(e => !!e.tripId);
            if (cleaned.length !== stored.length) {
              localStorage.setItem('tripversal_expenses', JSON.stringify(cleaned));
            }
            cleaned.filter(e => e.tripId === activeTripId).forEach(e => {
              fetch(`/api/trips/${activeTripId}/expenses`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callerSub, ...expenseToRow(e) }),
              }).catch(() => { });
            });
            return; // keep localStorage as-is
          }
          const merged = mergeServerExpenses(stored, rows.map(rowToExpense), activeTripId);
          localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
          // Same filter as initial render — includes expenses with no tripId
          setExpenses(merged.filter(e => !e.tripId || !activeTripId || e.tripId === activeTripId));
        })
        .catch(() => { });
    }
  }, [activeTripId]);

  useEffect(() => {
    if (!user?.sub) return;
    fetch(`/api/users/${user.sub}/budgets`)
      .then(r => r.ok ? r.json() : null)
      .then((rows: any[] | null) => {
        if (!rows || rows.length === 0) return;
        const serverBudgets: SavedBudget[] = rows.map(r => ({
          id: r.id, name: r.name, currency: r.currency,
          amount: Number(r.amount),
          activeTripId: r.active_trip_id ?? undefined,
          createdAt: r.created_at,
        }));
        setSavedBudgets(serverBudgets);
        localStorage.setItem('tripversal_saved_budgets', JSON.stringify(serverBudgets));
        if (activeTripId) {
          const active = serverBudgets.find(b => b.activeTripId === activeTripId) ?? null;
          setActiveSavedBudget(active);
        }
      })
      .catch(() => { });
  }, [user?.sub, activeTripId]);

  const saveBudgets = (budgets: SavedBudget[]) => {
    setSavedBudgets(budgets);
    localStorage.setItem('tripversal_saved_budgets', JSON.stringify(budgets));
  };

  const syncBudget = (b: SavedBudget) => {
    if (!user?.sub) return;
    fetch(`/api/users/${user.sub}/budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.id, name: b.name, currency: b.currency, amount: b.amount, activeTripId: b.activeTripId }),
    }).catch(() => { });
  };

  const deleteBudgetFromServer = (budgetId: string) => {
    if (!user?.sub) return;
    fetch(`/api/users/${user.sub}/budgets`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: budgetId }),
    }).catch(() => { });
  };

  const activateBudget = (budgetId: string | null) => {
    const updated = savedBudgets.map(b => {
      if (b.activeTripId === activeTripId) return { ...b, activeTripId: undefined };
      return b;
    }).map(b => {
      if (budgetId && b.id === budgetId) return { ...b, activeTripId: activeTripId };
      return b;
    });
    saveBudgets(updated);
    updated.forEach(b => syncBudget(b));
    if (budgetId) localStorage.setItem(`tripversal_active_budget_${activeTripId}`, budgetId);
    else localStorage.removeItem(`tripversal_active_budget_${activeTripId}`);
    setActiveSavedBudget(updated.find(b => b.id === budgetId) ?? null);
  };

  const handleAddBudget = () => {
    if (!budgetName.trim() || !budgetAmount) return;
    const b: SavedBudget = { id: crypto.randomUUID(), name: budgetName.trim(), currency: formBudgetCurrency, amount: parseFloat(budgetAmount), createdAt: new Date().toISOString() };
    saveBudgets([b, ...savedBudgets]);
    syncBudget(b);
    setBudgetName(''); setFormBudgetCurrency('USD'); setBudgetAmount(''); setShowAddBudget(false);
  };

  const handleDeleteBudget = (budgetId: string) => {
    saveBudgets(savedBudgets.filter(b => b.id !== budgetId));
    deleteBudgetFromServer(budgetId);
    if (activeSavedBudget?.id === budgetId) activateBudget(null);
  };

  const saveBudgetSettings = (next: TripBudget) => {
    setBudgetState(next);
    localStorage.setItem('tripversal_budget', JSON.stringify(next));
    if (activeTripId && user?.sub) {
      fetch(`/api/trips/${activeTripId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, budget: next }),
      }).catch(() => { });
    }
  };

  const addSource = async () => {
    if (!srcName.trim() || !srcAmount) return;
    setSrcSaving(true);
    let limitInBase = parseFloat(srcAmount);
    try {
      if (srcCurrency !== budget.baseCurrency) {
        const rate = await fetchRate(srcCurrency as Currency, budget.baseCurrency as Currency);
        limitInBase = parseFloat(srcAmount) * rate;
      }
    } catch { }
    const src: PaymentSource = {
      id: crypto.randomUUID(),
      name: srcName.trim(),
      type: srcType,
      currency: srcCurrency as Currency,
      limit: parseFloat(srcAmount),
      limitInBase,
      color: srcColor,
    };
    const next = { ...budget, sources: [...budget.sources, src] };
    saveBudgetSettings(next);
    setSrcName(""); setSrcType("balance"); setSrcCurrency("EUR"); setSrcAmount(""); setSrcColor("#00e5ff");
    setShowAddSource(false); setSrcSaving(false);
  };

  const removeSource = (id: string) => saveBudgetSettings({ ...budget, sources: budget.sources.filter(s => s.id !== id) });

  useEffect(() => {
    const el = txSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) setVisibleTxCount(c => c + 10); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [expenses.length]);

  const saveExpenses = (arr: Expense[]) => {
    const sorted = [...arr].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setExpenses(sorted);
    localStorage.setItem('tripversal_expenses', JSON.stringify(sorted));
  };
  const handleDelete = (id: string) => {
    const exp = expenses.find(e => e.id === id);
    if (exp) {
      try {
        const prev = localStorage.getItem('tripversal_deleted_expenses');
        const arr = prev ? JSON.parse(prev) : [];
        localStorage.setItem('tripversal_deleted_expenses',
          JSON.stringify([{ ...exp, deletedAt: new Date().toISOString() }, ...arr]));
      } catch { }
    }
    saveExpenses(expenses.filter(e => e.id !== id));
    setSelectedExpenseId(null); setConfirmDelete(false);
    // Background soft-delete on server
    if (exp?.tripId && user?.sub) {
      fetch(`/api/trips/${exp.tripId}/expenses/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      }).catch(() => { });
    }
  };
  const handleEdit = (id: string) => {
    const next = expenses.map(e => {
      if (e.id !== id) return e;
      const snap = {
        description: e.description, localAmount: e.localAmount,
        category: e.category, date: e.date, sourceId: e.sourceId, localCurrency: e.localCurrency
      };
      return {
        ...e, description: editDesc, localAmount: parseFloat(editAmount) || e.localAmount,
        category: editCat, date: editDate ? new Date(`${editDate}T12:00:00`).toISOString() : e.date,
        sourceId: editSourceId || e.sourceId, localCurrency: editCurrency, city: editCity || e.city,
        editHistory: [...(e.editHistory || []), { at: new Date().toISOString(), snapshot: snap }]
      };
    });
    saveExpenses(next);
    setEditMode(false); setSelectedExpenseId(null);
    // Background update on server
    const updated = next.find(e => e.id === id);
    if (updated?.tripId && user?.sub) {
      fetch(`/api/trips/${updated.tripId}/expenses/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, ...expenseToRow(updated) }),
      }).catch(() => { });
    }
  };

  const { totalBudgetInBase: legacyTotal, totalSpent } = calcSummary(budget, expenses);
  const activeTrip = (trips as Trip[]).find((t: Trip) => t.id === activeTripId) ?? null;
  const totalBudgetInBase = activeSavedBudget ? activeSavedBudget.amount : legacyTotal;
  const budgetCurrency = (activeSavedBudget ? activeSavedBudget.currency : budget.baseCurrency) as Currency;
  const remaining = totalBudgetInBase - totalSpent;
  const pctSpent = totalBudgetInBase > 0 ? Math.min(totalSpent / totalBudgetInBase, 1) : 0;

  // Daily budget: total / trip duration (recalculated whenever budget or trip changes)
  const tripDays = activeTrip
    ? Math.max(1, Math.round((new Date(activeTrip.endDate + 'T12:00:00').getTime() - new Date(activeTrip.startDate + 'T12:00:00').getTime()) / (1000 * 60 * 60 * 24)) + 1)
    : 0;
  const dailyBudget = tripDays > 0 && totalBudgetInBase > 0 ? totalBudgetInBase / tripDays : 0;

  // 14-day daily trend
  const today = new Date();
  const dayData = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (13 - i));
    const key = localDateKey(d);
    const label = i === 13 ? "Today" : d.toLocaleDateString("en", { weekday: "short" }).slice(0, 3);
    const showLabel = i === 13 || i % 2 === 0;
    const total = expenses.filter(e => localDateKey(new Date(e.date)) === key).reduce((s, e) => s + e.baseAmount, 0);
    return { label, total, isToday: i === 13, showLabel };
  });
  const maxDay = Math.max(...dayData.map(d => d.total), 1);

  // Category breakdown
  const CAT_COLORS: Record<string, string> = { food: "#ff9f0a", transport: "#0a84ff", lodging: "#bf5af2", activity: "#30d158", shopping: "#ff375f", general: "#8e8e93" };
  const catTotals = Object.entries(
    expenses.reduce((acc, e) => { acc[e.category] = (acc[e.category] || 0) + e.baseAmount; return acc; }, {} as Record<string, number>)
  ).sort((a, b) => b[1] - a[1]);
  const maxCat = catTotals[0]?.[1] || 1;

  // Source breakdown
  const sourceMap = Object.fromEntries(budget.sources.map(s => [s.id, s]));
  const srcTotals = Object.entries(
    expenses.reduce((acc, e) => { acc[e.sourceId] = (acc[e.sourceId] || 0) + e.baseAmount; return acc; }, {} as Record<string, number>)
  ).sort((a, b) => b[1] - a[1]);
  const maxSrc = srcTotals[0]?.[1] || 1;

  // SVG donut params
  const R = 54, CX = 70, CY = 70, CIRC = 2 * Math.PI * R;

  // ── Burndown chart data ──────────────────────────────────────────────────────
  const burndownDays: { key: string; isToday: boolean; isPast: boolean; spend: number }[] = [];
  if (totalBudgetInBase > 0 && activeTrip) {
    const start = new Date(activeTrip.startDate + 'T00:00:00');
    const end = new Date(activeTrip.endDate + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = new Date(start);
    while (cur <= end) {
      const key = localDateKey(cur);
      const isPast = cur <= today;
      const isToday = key === localDateKey(today);
      const spend = expenses.filter(e => localDateKey(new Date(e.date)) === key).reduce((s, e) => s + e.baseAmount, 0);
      burndownDays.push({ key, isToday, isPast, spend });
      cur.setDate(cur.getDate() + 1);
    }
  }
  // SVG chart area: viewBox "0 0 310 130", chart x: 36–300, y: 10–105
  const BD_X0 = 36, BD_X1 = 300, BD_Y0 = 10, BD_Y1 = 105;
  const bdW = BD_X1 - BD_X0, bdH = BD_Y1 - BD_Y0;
  const bdN = Math.max(burndownDays.length - 1, 1);
  const bdX = (i: number) => BD_X0 + (i / bdN) * bdW;
  const bdY = (rem: number) => BD_Y1 - (Math.max(0, rem) / totalBudgetInBase) * bdH;

  // Ideal line: straight from totalBudget → 0
  const idealPoints = burndownDays.map((_, i) => {
    const idealRem = totalBudgetInBase * (1 - i / bdN);
    return `${bdX(i).toFixed(1)},${bdY(idealRem).toFixed(1)}`;
  }).join(' ');

  // Actual line: cumulative spend, past days only
  let cumulativeSpent = 0;
  const actualPoints: string[] = [];
  let todayX = -1;
  burndownDays.forEach((d, i) => {
    if (d.isToday) todayX = bdX(i);
    if (d.isPast) {
      cumulativeSpent += d.spend;
      actualPoints.push(`${bdX(i).toFixed(1)},${bdY(totalBudgetInBase - cumulativeSpent).toFixed(1)}`);
    }
  });

  // ── Balances data ─────────────────────────────────────────────────────────────
  // Net debts from the current user's perspective (by name matching)
  const myName = user?.name;
  // debtMap[person][currency] > 0 → person owes me; < 0 → I owe person
  const debtMap: Record<string, Record<string, number>> = {};
  expenses.filter(e => e.type === 'group' && e.whoPaid && e.splits).forEach(exp => {
    const currency = exp.localCurrency;
    const payer = exp.whoPaid!;
    if (payer === myName) {
      // I paid — others owe me their share
      Object.entries(exp.splits!).forEach(([person, share]) => {
        if (person === myName) return;
        debtMap[person] = debtMap[person] || {};
        debtMap[person][currency] = (debtMap[person][currency] || 0) + (share as number);
      });
    } else if (myName && exp.splits![myName] != null) {
      // Someone else paid — I owe them my share
      debtMap[payer] = debtMap[payer] || {};
      debtMap[payer][currency] = (debtMap[payer][currency] || 0) - (exp.splits![myName] as number);
    }
  });
  // Flatten into a sorted list (largest amounts first)
  const balanceRows: { person: string; currency: string; amount: number }[] = [];
  Object.entries(debtMap).forEach(([person, currencies]) => {
    Object.entries(currencies).forEach(([currency, amount]) => {
      if (Math.abs(amount) > 0.001) balanceRows.push({ person, currency, amount });
    });
  });
  balanceRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    <div style={{ padding: "0 20px 100px" }}>
      {/* ── Active trip banner ── */}
      {activeTrip && (
        <div style={{ background: C.card3, borderRadius: 14, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginTop: 16, marginBottom: 12 }}>
          <span style={{ fontSize: 18 }}>✈️</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.textMuted, letterSpacing: 1 }}>ACTIVE TRIP</div>
            <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{activeTrip.name}</div>
          </div>
          {activeSavedBudget ? (
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: C.textMuted }}>Budget</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.cyan }}>{activeSavedBudget.currency} {activeSavedBudget.amount.toLocaleString()}</div>
              {dailyBudget > 0 && <div style={{ fontSize: 10, color: C.textSub }}>{currSym(budgetCurrency)}{fmtAmt(dailyBudget, 0)}/day · {tripDays}d</div>}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.textSub, fontStyle: "italic" }}>No budget set</div>
          )}
        </div>
      )}

      {/* ── Header totals ── */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", paddingTop: activeTrip ? 4 : 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -1 }}>{currSym(budgetCurrency)}{fmtAmt(totalSpent)}</div>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, fontWeight: 600 }}>TOTAL TRIP SPEND</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: remaining >= 0 ? C.green : C.red }}>{remaining >= 0 ? '+' : ''}{currSym(budgetCurrency)}{fmtAmt(Math.abs(remaining))}</div>
          <div style={{ color: C.textSub, fontSize: 11, letterSpacing: 1 }}>{remaining >= 0 ? 'REMAINING' : 'OVER BUDGET'}</div>
        </div>
      </div>

      {/* ── Tab switcher ── */}
      <div style={{ background: C.card3, borderRadius: 14, padding: 4, display: "flex", marginBottom: 20 }}>
        {(['transactions', 'analytics', 'wallet'] as const).map(t => (
          <button key={t} onClick={() => setWalletTab(t)} style={{ flex: 1, padding: "11px", borderRadius: 10, border: "none", cursor: "pointer", background: walletTab === t ? C.cyan : "transparent", color: walletTab === t ? "#000" : C.textMuted, fontWeight: walletTab === t ? 700 : 400, fontSize: 12, fontFamily: "inherit", letterSpacing: 1 }}>
            {t === 'transactions' ? 'TRANSACTIONS' : t === 'analytics' ? 'ANALYTICS' : 'WALLET'}
          </button>
        ))}
      </div>

      {walletTab === 'transactions' ? (
        <>
          {expenses.length === 0 && (
            <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", padding: "40px 0", textAlign: "center" }}>No expenses yet. Tap + to add one.</div>
          )}
          {expenses.slice(0, visibleTxCount).map(exp => {
            const src = sourceMap[exp.sourceId];
            const catIcon = categories.find(c => c.id === exp.category)?.icon || icons.moreH;
            const d = new Date(exp.date);
            const dateStr = d.toLocaleDateString("en", { day: "numeric", month: "short" }).toUpperCase() + " · " + d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
            return (
              <Card key={exp.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon d={catIcon} size={20} stroke={C.cyan} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{exp.description}</div>
                    <div style={{ color: src ? src.color : C.textMuted, fontSize: 11, letterSpacing: 0.5 }}>{src ? src.name.toUpperCase() : "—"} • {exp.category.toUpperCase()}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)}</div>
                    <div style={{ color: C.textSub, fontSize: 11 }}>{dateStr}</div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); setSelectedExpenseId(exp.id); setEditMode(false); setConfirmDelete(false); }}
                    style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", color: C.textMuted }}>
                    <Icon d={icons.moreH} size={16} stroke={C.textMuted} />
                  </button>
                </div>
              </Card>
            );
          })}
          {visibleTxCount < expenses.length && (
            <div ref={txSentinelRef} style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ color: C.textSub, fontSize: 12 }}>Loading more...</div>
            </div>
          )}
          {visibleTxCount >= expenses.length && expenses.length > 10 && (
            <div style={{ color: C.textSub, fontSize: 11, textAlign: "center", padding: "12px 0" }}>All {expenses.length} transactions shown</div>
          )}
        </>
      ) : walletTab === 'analytics' ? (
        <>
          {/* ── Budget Ring ── */}
          <Card style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 20 }}>
            <svg width={140} height={140} style={{ flexShrink: 0 }}>
              {/* track */}
              <circle cx={CX} cy={CY} r={R} fill="none" stroke={C.card3} strokeWidth={14} />
              {/* spent arc */}
              <circle cx={CX} cy={CY} r={R} fill="none"
                stroke={pctSpent >= 0.9 ? C.red : pctSpent >= 0.7 ? C.yellow : C.cyan}
                strokeWidth={14} strokeLinecap="round"
                strokeDasharray={`${pctSpent * CIRC} ${CIRC}`}
                strokeDashoffset={CIRC * 0.25}
                transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dasharray 0.6s ease" }}
              />
              <text x={CX} y={CY - 8} textAnchor="middle" fill={C.text} fontSize={22} fontWeight={800} fontFamily="-apple-system,sans-serif">
                {Math.round(pctSpent * 100)}%
              </text>
              <text x={CX} y={CY + 12} textAnchor="middle" fill={C.textMuted} fontSize={10} fontFamily="-apple-system,sans-serif">
                OF BUDGET
              </text>
              {totalBudgetInBase > 0 && (
                <text x={CX} y={CY + 28} textAnchor="middle" fill={C.textSub} fontSize={9} fontFamily="-apple-system,sans-serif">
                  {currSym(budgetCurrency)}{fmtAmt(totalBudgetInBase, 0)} total
                </text>
              )}
            </svg>
            <div style={{ flex: 1 }}>
              {totalBudgetInBase === 0 && <div style={{ color: C.textSub, fontSize: 12, fontStyle: "italic" }}>No active budget. Go to <strong style={{ color: C.cyan }}>Group → Manage → Budget</strong> to set one.</div>}
              {totalBudgetInBase > 0 && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>SPENT</div>
                    <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>{currSym(budgetCurrency)}{fmtAmt(totalSpent)}</div>
                  </div>
                  <div>
                    <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>{remaining >= 0 ? 'REMAINING' : 'OVER BUDGET'}</div>
                    <div style={{ fontWeight: 700, fontSize: 18, color: remaining >= 0 ? C.green : C.red }}>{currSym(budgetCurrency)}{fmtAmt(Math.abs(remaining))}</div>
                  </div>
                </>
              )}
            </div>
          </Card>

          {/* ── By Category ── */}
          {catTotals.length > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>By Category</div>
              {catTotals.map(([cat, amt]) => {
                const pct = amt / maxCat;
                const color = CAT_COLORS[cat] || C.textMuted;
                const catLabel = categories.find(c => c.id === cat)?.label || cat.toUpperCase();
                return (
                  <div key={cat} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color }}>{catLabel}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{currSym(budget.baseCurrency)}{fmtAmt(amt)}</span>
                    </div>
                    <div style={{ height: 8, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${pct * 100}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.5s ease" }} />
                    </div>
                    <div style={{ color: C.textSub, fontSize: 10, marginTop: 3 }}>{totalSpent > 0 ? Math.round(amt / totalSpent * 100) : 0}% of total</div>
                  </div>
                );
              })}
            </Card>
          )}

          {/* ── By Source ── */}
          {srcTotals.length > 0 && budget.sources.length > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>By Payment Source</div>
              {srcTotals.map(([srcId, amt]) => {
                const src = sourceMap[srcId];
                if (!src) return null;
                const pct = amt / maxSrc;
                const limitBase = src.limitInBase ?? src.limit;
                const usePct = limitBase > 0 ? Math.min(amt / limitBase, 1) : 0;
                return (
                  <div key={srcId} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: src.color }}>{src.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{currSym(budget.baseCurrency)}{fmtAmt(amt)}{limitBase > 0 ? ` / ${fmtAmt(limitBase, 0)}` : ''}</span>
                    </div>
                    <div style={{ height: 8, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${(limitBase > 0 ? usePct : pct) * 100}%`, height: "100%", background: src.color, borderRadius: 4, transition: "width 0.5s ease" }} />
                    </div>
                    {limitBase > 0 && <div style={{ color: C.textSub, fontSize: 10, marginTop: 3 }}>{Math.round(usePct * 100)}% of limit</div>}
                  </div>
                );
              })}
            </Card>
          )}

          {/* ── 14-day Trend ── */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Daily Spend — 14 days</div>
            <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 16 }}>{currSym(budget.baseCurrency)} per day</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
              {dayData.map((d, i) => {
                const barPct = d.total > 0 ? Math.max(d.total / maxDay, 0.04) : 0;
                const barColor = d.isToday ? C.cyan : d.total > 0 ? "#00b8cc" : C.card3;
                return (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 4, height: "100%" }}>
                    {/* amount label on top of bar */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, justifyContent: "flex-end", width: "100%" }}>
                      {d.total > 0 && (
                        <div style={{ color: d.isToday ? C.cyan : C.textMuted, fontSize: 7, fontWeight: 700, textAlign: "center", marginBottom: 2, whiteSpace: "nowrap" as const }}>
                          {d.total >= 1000 ? `${(d.total / 1000).toFixed(1)}k` : fmtAmt(d.total, 0)}
                        </div>
                      )}
                      <div style={{ width: "100%", height: `${barPct * 100}%`, minHeight: d.total > 0 ? 4 : 0, background: barColor, borderRadius: "4px 4px 0 0" }} />
                    </div>
                    {/* day label */}
                    <div style={{ fontSize: 8, color: d.isToday ? C.cyan : C.textSub, fontWeight: d.isToday ? 700 : 400, whiteSpace: "nowrap" as const }}>
                      {d.showLabel ? d.label : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── Burndown Chart ── */}
          {burndownDays.length > 1 && totalBudgetInBase > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>Budget Burndown</div>
              <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 10, display: "flex", gap: 14 }}>
                <span><span style={{ color: C.textSub }}>— </span>Ideal</span>
                <span><span style={{ color: C.cyan }}>— </span>Actual</span>
              </div>
              <svg viewBox="0 0 310 130" style={{ width: "100%", overflow: "visible" }}>
                {/* Y grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                  const y = BD_Y1 - frac * bdH;
                  return (
                    <g key={frac}>
                      <line x1={BD_X0} y1={y} x2={BD_X1} y2={y} stroke={C.card3} strokeWidth={1} />
                      <text x={BD_X0 - 4} y={y + 4} textAnchor="end" fill={C.textSub} fontSize={7} fontFamily="-apple-system,sans-serif">
                        {frac === 0 ? '0' : frac === 1 ? (totalBudgetInBase >= 1000 ? `${(totalBudgetInBase / 1000).toFixed(0)}k` : fmtAmt(totalBudgetInBase, 0)) : ''}
                      </text>
                    </g>
                  );
                })}
                {/* Ideal line */}
                {idealPoints && <polyline points={idealPoints} fill="none" stroke={C.textSub} strokeWidth={1.5} strokeDasharray="4 3" />}
                {/* Actual line */}
                {actualPoints.length > 1 && (
                  <polyline points={actualPoints.join(' ')} fill="none" stroke={C.cyan} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                )}
                {/* Actual dot (last point) */}
                {actualPoints.length > 0 && (() => {
                  const last = actualPoints[actualPoints.length - 1].split(',');
                  return <circle cx={last[0]} cy={last[1]} r={3.5} fill={C.cyan} />;
                })()}
                {/* Today marker */}
                {todayX >= 0 && (
                  <line x1={todayX} y1={BD_Y0} x2={todayX} y2={BD_Y1} stroke={C.yellow} strokeWidth={1} strokeDasharray="3 2" />
                )}
                {/* X axis labels */}
                <text x={BD_X0} y={BD_Y1 + 14} textAnchor="middle" fill={C.textSub} fontSize={7} fontFamily="-apple-system,sans-serif">
                  {new Date(activeTrip!.startDate + 'T12:00:00').toLocaleDateString("en", { month: "short", day: "numeric" })}
                </text>
                <text x={BD_X1} y={BD_Y1 + 14} textAnchor="middle" fill={C.textSub} fontSize={7} fontFamily="-apple-system,sans-serif">
                  {new Date(activeTrip!.endDate + 'T12:00:00').toLocaleDateString("en", { month: "short", day: "numeric" })}
                </text>
                {todayX >= 0 && todayX > BD_X0 + 20 && todayX < BD_X1 - 20 && (
                  <text x={todayX} y={BD_Y1 + 14} textAnchor="middle" fill={C.yellow} fontSize={7} fontFamily="-apple-system,sans-serif">Today</text>
                )}
              </svg>
              {/* Over budget warning */}
              {cumulativeSpent > totalBudgetInBase && (
                <div style={{ color: C.red, fontSize: 11, marginTop: 6, fontWeight: 600 }}>
                  ⚠ Over budget by {currSym(budgetCurrency)}{fmtAmt(cumulativeSpent - totalBudgetInBase)}
                </div>
              )}
            </Card>
          )}

          {/* ── Balances ── */}
          {balanceRows.length > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Balances</div>
              {balanceRows.map((row, i) => {
                const isReceive = row.amount > 0;
                const sym = CURRENCY_SYMBOLS[row.currency as Currency] ?? row.currency;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 15 }}>
                      {row.person.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {isReceive ? `${row.person} owes you` : `You owe ${row.person}`}
                      </div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>{row.currency}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: isReceive ? C.green : C.yellow }}>
                        {isReceive ? '+' : '-'}{sym}{fmtAmt(Math.abs(row.amount))}
                      </div>
                      <div style={{ fontSize: 10, color: C.textSub }}>{isReceive ? 'RECEIVE' : 'PAY'}</div>
                    </div>
                  </div>
                );
              })}
              {(() => {
                const totalOwed = balanceRows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
                const totalOwing = balanceRows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
                if (totalOwed === 0 && totalOwing === 0) return null;
                return (
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
                    {totalOwed > 0 && <div style={{ color: C.green, fontSize: 12 }}>To receive: {fmtAmt(totalOwed)}</div>}
                    {totalOwing < 0 && <div style={{ color: C.yellow, fontSize: 12 }}>To pay: {fmtAmt(Math.abs(totalOwing))}</div>}
                  </div>
                );
              })()}
            </Card>
          )}

          {expenses.length === 0 && (
            <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "20px 0" }}>No expenses yet — analytics will appear here.</div>
          )}
        </>
      ) : (
        <>
          {/* Wallet / Settings tab content */}
          <SectionLabel icon="wallet">BUDGETS</SectionLabel>
          <button onClick={() => setShowAddBudget(p => !p)} style={{ display: "flex", alignItems: "center", gap: 6, background: C.cyan, color: "#000", border: "none", borderRadius: 12, padding: "10px 16px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, marginBottom: 16 }}>
            <Icon d={icons.plus} size={14} stroke="#000" strokeWidth={2.5} /> New Budget
          </button>

          {showAddBudget && (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.cyan}30` }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>New Budget</div>
              <Input placeholder="Name (e.g. Europe Trip 2026)" value={budgetName} onChange={setBudgetName} style={{ marginBottom: 10 }} />
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CURRENCY</div>
                  <Card style={{ padding: 10 }}>
                    <input value={formBudgetCurrency} onChange={e => setFormBudgetCurrency(e.target.value.toUpperCase().slice(0, 3) as Currency)} maxLength={3} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", width: "100%", textTransform: "uppercase" as const }} placeholder="USD" />
                  </Card>
                </div>
                <div style={{ flex: 2 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TOTAL AMOUNT</div>
                  <Card style={{ padding: 10 }}>
                    <input type="number" value={budgetAmount} onChange={e => setBudgetAmount(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", width: "100%" }} placeholder="0.00" />
                  </Card>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="ghost" style={{ flex: 1 }} onClick={() => { setShowAddBudget(false); setBudgetName(''); setBudgetAmount(''); setFormBudgetCurrency('USD'); }}>Cancel</Btn>
                <Btn style={{ flex: 1 }} onClick={handleAddBudget}>Save</Btn>
              </div>
            </Card>
          )}

          {savedBudgets.length === 0 && !showAddBudget && (
            <div style={{ textAlign: "center", color: C.textSub, fontSize: 13, padding: "40px 0", marginBottom: 16 }}>No budgets yet. Create one above.</div>
          )}

          {savedBudgets.map(b => {
            const isActive = b.id === activeSavedBudget?.id && activeSavedBudget?.activeTripId === activeTripId;
            return (
              <Card key={b.id} style={{ marginBottom: 10, border: isActive ? `1px solid ${C.cyan}` : `1px solid ${C.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{b.name}</div>
                    <div style={{ color: C.textMuted, fontSize: 12 }}>{b.currency} {b.amount.toLocaleString()}</div>
                  </div>
                  {isActive && <Badge color={C.cyan} bg="#003d45">ACTIVE</Badge>}
                  <button onClick={() => activateBudget(isActive ? null : b.id)} style={{ background: isActive ? C.card3 : C.cyan, color: isActive ? C.textMuted : "#000", border: "none", borderRadius: 10, padding: "7px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
                    {isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button onClick={() => handleDeleteBudget(b.id)} style={{ background: C.redDim, border: "none", borderRadius: 10, padding: "7px 10px", cursor: "pointer" }}>
                    <Icon d={icons.trash} size={13} stroke={C.red} />
                  </button>
                </div>
              </Card>
            );
          })}

          <SectionLabel action={
            <button onClick={() => setShowAddSource(p => !p)} style={{ background: C.cyan, color: "#000", borderRadius: 20, padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
              <Icon d={icons.plus} size={11} stroke="#000" strokeWidth={2.5} /> ADD
            </button>
          }>PAYMENT SOURCES</SectionLabel>

          {budget.sources.length === 0 && !showAddSource && (
            <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", marginBottom: 16, padding: "8px 0" }}>No custom sources. Default will be used.</div>
          )}

          {budget.sources.map(src => {
            const spent = expenses.filter(e => e.sourceId === src.id).reduce((s, e) => s + e.localAmount, 0);
            const usePct = src.limit > 0 ? Math.min(spent / src.limit, 1) : 0;
            return (
              <Card key={src.id} style={{ marginBottom: 8, padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: src.color, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{src.name}</span>
                      <Badge color={src.type === "credit" ? C.yellow : C.cyan} bg={src.type === "credit" ? "#2a2000" : "#003d45"}>{src.type === "credit" ? "CRÉDITO" : "SALDO"}</Badge>
                    </div>
                    <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{currSym(src.currency as Currency)}{fmtAmt(src.limit)} {src.currency !== budget.baseCurrency && src.limitInBase ? `≈ ${currSym(budget.baseCurrency as Currency)}${fmtAmt(src.limitInBase)}` : ""}</div>
                    <div style={{ height: 3, background: C.card3, borderRadius: 2, overflow: "hidden", marginTop: 6 }}>
                      <div style={{ width: `${usePct * 100}%`, height: "100%", background: src.color, borderRadius: 2 }} />
                    </div>
                  </div>
                  <button onClick={() => removeSource(src.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 4 }}><Icon d={icons.trash} size={16} stroke={C.red} /></button>
                </div>
              </Card>
            );
          })}

          {showAddSource && (
            <Card style={{ marginBottom: 12, border: `1px solid ${C.cyan}30` }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>New Payment Source</div>
              <Input placeholder="Name (e.g. Nubank, Cash)" value={srcName} onChange={setSrcName} style={{ marginBottom: 10 }} />
              <div style={{ background: C.card3, borderRadius: 12, padding: 4, display: "flex", marginBottom: 10 }}>
                {(["balance", "credit"] as SourceType[]).map(t => (
                  <button key={t} onClick={() => setSrcType(t)} style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", cursor: "pointer", background: srcType === t ? C.cyan : "transparent", color: srcType === t ? "#000" : C.textMuted, fontWeight: srcType === t ? 700 : 400, fontSize: 13, fontFamily: "inherit", transition: "all 0.2s" }}>
                    {t === "balance" ? "Saldo" : "Crédito"}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CURRENCY</div>
                  <select value={srcCurrency} onChange={(e: any) => setSrcCurrency(e.target.value as Currency)} style={{ width: "100%", padding: "12px", borderRadius: 10, background: C.card3, border: `1.5px solid ${C.border}`, color: C.text, fontFamily: "inherit", fontSize: 14 }}>
                    {(["EUR", "USD", "BRL", "GBP", "COP"] as Currency[]).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>LIMIT</div>
                  <Input placeholder="0.00" value={srcAmount} onChange={setSrcAmount} />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>COLOR</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {srcColors.map(c => (
                    <button key={c} onClick={() => setSrcColor(c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: srcColor === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {srcColor === c && <Icon d={icons.check} size={12} stroke="#fff" strokeWidth={3} />}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn style={{ flex: 1 }} onClick={addSource} variant="primary">{srcSaving ? "Saving..." : "Add Source"}</Btn>
                <Btn style={{ flex: 1 }} onClick={() => setShowAddSource(false)} variant="ghost">Cancel</Btn>
              </div>
            </Card>
          )}

          <SectionLabel icon="book">PREFERENCES</SectionLabel>
          <Card style={{ marginBottom: 20, padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>BASE CURRENCY</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["EUR", "USD", "BRL", "GBP", "COP"] as Currency[]).map(c => (
                    <button key={c} onClick={() => saveBudgetSettings({ ...budget, baseCurrency: c })} style={{ background: budget.baseCurrency === c ? C.cyan : C.card3, color: budget.baseCurrency === c ? "#000" : C.textMuted, border: "none", borderRadius: 8, padding: "5px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{c}</button>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DAILY MAX (ALL BUDGETS)</div>
                <input
                  type="number"
                  value={budget.dailyLimit}
                  onChange={(e: any) => saveBudgetSettings({ ...budget, dailyLimit: parseFloat(e.target.value) || 0 })}
                  style={{ background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 18, fontWeight: 700, fontFamily: "inherit", width: "100%" }}
                />
              </div>
              <span style={{ color: C.textMuted, fontSize: 14 }}>{currSym(budget.baseCurrency as Currency)}/day</span>
            </div>
          </Card>
        </>
      )}

      <div style={{ position: "fixed", bottom: 90, right: "calc(50% - 200px)", width: 56, height: 56, borderRadius: "50%", background: C.cyan, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: `0 4px 20px ${C.cyan}50` }} onClick={onAddExpense}>
        <Icon d={icons.plus} size={24} stroke="#000" strokeWidth={2.5} />
      </div>
      {selectedExpenseId && (() => {
        const exp = expenses.find(e => e.id === selectedExpenseId)!;
        if (!exp) return null;
        return (
          <>
            <div onClick={() => { setSelectedExpenseId(null); setEditMode(false); setConfirmDelete(false); }}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200 }} />
            <div style={{
              position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
              width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0",
              padding: "20px 20px 40px", zIndex: 201, maxHeight: "80vh", overflowY: "auto"
            }}>
              <div style={{ width: 40, height: 4, background: C.border, borderRadius: 2, margin: "0 auto 16px" }} />
              {!editMode && !confirmDelete ? (
                <>
                  {exp.receiptDataUrl && <img src={exp.receiptDataUrl} style={{ width: "100%", borderRadius: 12, marginBottom: 16, maxHeight: 180, objectFit: "cover" }} />}
                  <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 2 }}>{exp.description}</div>
                  {exp.city && <div style={{ color: C.cyan, fontSize: 12, marginBottom: 4 }}>📍 {exp.city}</div>}
                  <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>
                    {new Date(exp.date).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })} · {new Date(exp.date).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>AMOUNT</div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)}</div>
                    </div>
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1 }}>SOURCE</div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{sourceMap[exp.sourceId]?.name || "—"}</div>
                    </div>
                  </div>
                  {exp.editHistory && exp.editHistory.length > 0 && (
                    <div style={{ background: C.card3, borderRadius: 12, padding: 12, marginBottom: 16 }}>
                      <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>EDIT HISTORY</div>
                      {exp.editHistory.map((h, i) => (
                        <div key={i} style={{ color: C.textSub, fontSize: 11, marginBottom: 4 }}>
                          {new Date(h.at).toLocaleString("en")} — was "{h.snapshot.description}" {currSym(h.snapshot.localCurrency)}{fmtAmt(h.snapshot.localAmount)}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="secondary" icon={<Icon d={icons.edit} size={16} />}
                      onClick={() => { setEditDesc(exp.description); setEditAmount(String(exp.localAmount)); setEditCat(exp.category); setEditDate(exp.date.slice(0, 10)); setEditSourceId(exp.sourceId); setEditCurrency(exp.localCurrency); setEditCity(exp.city || ""); setEditMode(true); }}>
                      Edit
                    </Btn>
                    <Btn style={{ flex: 1 }} variant="danger" icon={<Icon d={icons.trash} size={16} stroke={C.red} />}
                      onClick={() => setConfirmDelete(true)}>
                      Delete
                    </Btn>
                  </div>
                </>
              ) : confirmDelete ? (
                <>
                  <div style={{ textAlign: "center", marginBottom: 20 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.red, marginBottom: 8 }}>Delete transaction?</div>
                    <div style={{ color: C.textMuted, fontSize: 13 }}>It will be moved to history and cannot be undone.</div>
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
                    <Btn style={{ flex: 1 }} variant="danger" onClick={() => handleDelete(selectedExpenseId)}>Delete</Btn>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 16 }}>Edit Transaction</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DESCRIPTION</div>
                    <Input value={editDesc} onChange={setEditDesc} placeholder="Description" />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>AMOUNT</div>
                    <Input value={editAmount} onChange={setEditAmount} placeholder="0.00" />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DATE</div>
                    <Card style={{ display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
                      <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                        style={{ background: "transparent", border: "none", color: C.text, flex: 1, outline: "none", fontFamily: "inherit", colorScheme: "dark" }} />
                    </Card>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>LOCATION</div>
                    <Card style={{ display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
                      <input value={editCity} onChange={e => setEditCity(e.target.value)} placeholder="City"
                        style={{ background: "transparent", border: "none", color: C.text, flex: 1, outline: "none", fontFamily: "inherit", fontSize: 14 }} />
                    </Card>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CATEGORY</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {categories.map(c => (
                        <button key={c.id} onClick={() => setEditCat(c.id)} style={{ background: editCat === c.id ? "#003d45" : C.card3, border: editCat === c.id ? `2px solid ${C.cyan}` : "2px solid transparent", borderRadius: 10, padding: "8px 12px", cursor: "pointer", color: editCat === c.id ? C.cyan : C.textMuted, fontSize: 12, fontWeight: editCat === c.id ? 700 : 400, fontFamily: "inherit" }}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {budget.sources.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>SOURCE</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {budget.sources.map(s => (
                          <button key={s.id} onClick={() => setEditSourceId(s.id)} style={{ background: editSourceId === s.id ? "#003d45" : C.card3, border: editSourceId === s.id ? `2px solid ${s.color}` : "2px solid transparent", borderRadius: 10, padding: "8px 12px", cursor: "pointer", color: editSourceId === s.id ? C.text : C.textMuted, fontSize: 12, fontFamily: "inherit" }}>
                            {s.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setEditMode(false)}>Cancel</Btn>
                    <Btn style={{ flex: 1 }} onClick={() => handleEdit(selectedExpenseId)}>Save Changes</Btn>
                  </div>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
};

const categories = [
  { id: "food", label: "FOOD", icon: icons.food },
  { id: "transport", label: "TRANSPORT", icon: icons.car },
  { id: "lodging", label: "LODGING", icon: icons.building },
  { id: "activity", label: "ACTIVITY", icon: icons.tag },
  { id: "shopping", label: "SHOPPING", icon: icons.shoppingBag },
  { id: "general", label: "GENERAL", icon: icons.moreH },
];

const members = ["You", "Patrick", "Sarah"];

function compressImage(file: File, maxPx = 800, quality = 0.7): Promise<string> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target!.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const AddExpenseScreen = ({ onBack, activeTripId, user }: any) => {
  const [amount, setAmount] = useState("0");
  const [cat, setCat] = useState("food");
  const [expType, setExpType] = useState("group");
  const [whoPaid, setWhoPaid] = useState("You");
  const [desc, setDesc] = useState("");
  const [shares, setShares] = useState<Record<string, number>>({ You: 1, Patrick: 1, Sarah: 1 });
  const totalShares = Object.values(shares).reduce((a, b) => a + b, 0);
  const total = parseFloat(amount) || 0;

  const [budget] = useState<TripBudget>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) return JSON.parse(s); } catch { }
    return DEFAULT_BUDGET;
  });
  const [localCurrency, setLocalCurrency] = useState<Currency>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) { const b = JSON.parse(s); if (b.sources?.[0]?.currency) return b.sources[0].currency; } } catch { }
    return "EUR" as Currency;
  });
  const [selectedSourceId, setSelectedSourceId] = useState<string>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) { const b = JSON.parse(s); if (b.sources?.[0]?.id) return b.sources[0].id; } } catch { }
    return "";
  });
  const [saving, setSaving] = useState(false);
  const [expDate, setExpDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [expTime, setExpTime] = useState<string>(() => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  });
  const [receiptDataUrl, setReceiptDataUrl] = useState<string | null>(null);
  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [displayRate, setDisplayRate] = useState(1);
  const [city, setCity] = useState("");

  useEffect(() => {
    try {
      const es = localStorage.getItem('tripversal_expenses');
      if (es) setAllExpenses(JSON.parse(es));
    } catch { }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async ({ coords: { latitude, longitude } }) => {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, { headers: { "Accept-Language": "en" } });
          const data = await res.json();
          const addr = data.address || {};
          const name = addr.city || addr.town || addr.village || addr.county || "";
          if (name) setCity(name);
        } catch { }
      });
    }
  }, []);

  useEffect(() => {
    if (localCurrency === budget.baseCurrency) { setDisplayRate(1); return; }
    fetchRate(localCurrency, budget.baseCurrency).then(r => setDisplayRate(r)).catch(() => setDisplayRate(1));
  }, [localCurrency, budget.baseCurrency]);

  // Remaining budget today (with carryover from previous days)
  const todayKey = localDateKey(new Date());
  const pastDates = new Set(allExpenses.filter(e => localDateKey(new Date(e.date)) !== todayKey).map(e => localDateKey(new Date(e.date))));
  const accumulatedDays = pastDates.size + 1;
  const totalSpentAllBase = allExpenses.reduce((s, e) => s + e.baseAmount, 0);
  const remainingBase = accumulatedDays * budget.dailyLimit - totalSpentAllBase;
  const remainingLocal = displayRate > 0 ? remainingBase / displayRate : remainingBase;

  // Credit vs balance distinction
  const selectedSource = budget.sources.find(s => s.id === selectedSourceId);
  const isCredit = selectedSource?.type === "credit";
  const spentOnSource = allExpenses.filter(e => e.sourceId === selectedSourceId).reduce((s, e) => s + e.baseAmount, 0);
  const sourceLimitBase = selectedSource?.limitInBase ?? selectedSource?.limit ?? 0;
  const sourceRemainingBase = sourceLimitBase - spentOnSource;
  const sourceRemainingLocal = displayRate > 0 ? sourceRemainingBase / displayRate : sourceRemainingBase;

  const handleKey = (k: string) => {
    setAmount(prev => {
      if (k === "⌫") return prev.length > 1 ? prev.slice(0, -1) : "0";
      if (k === ".") return prev.includes(".") ? prev : prev + ".";
      if (prev.includes(".") && prev.split(".")[1].length >= 2) return prev;
      if (prev === "0") return k;
      return prev + k;
    });
  };
  return (
    <div style={{ padding: "0 20px 100px", overflowY: "auto" }}>
      <div style={{ textAlign: "center", padding: "24px 0 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ color: C.textMuted, fontSize: 12, letterSpacing: 1.5, marginBottom: 12 }}>AMOUNT</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span style={{ fontSize: 32, color: C.textMuted }}>{currSym(localCurrency)}</span>
          <span style={{ fontSize: amount.length > 6 ? 32 : 44, fontWeight: 800, color: C.text, letterSpacing: -2 }}>{amount}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 16, maxWidth: 280, margin: "16px auto 0" }}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map(k => (
            <button key={k} onClick={() => handleKey(k)} style={{ background: C.card3, border: "none", borderRadius: 10, padding: "14px", fontSize: 18, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit" }}>{k}</button>
          ))}
        </div>
      </div>
      <div style={{ paddingTop: 20 }}>
        <SectionLabel>MOEDA LOCAL</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {(["EUR", "USD", "BRL", "GBP", "COP"] as Currency[]).map(c => {
            const active = localCurrency === c;
            return (
              <button key={c} onClick={() => setLocalCurrency(c)} style={{ flex: 1, background: active ? "#003d45" : C.card3, border: active ? `2px solid ${C.cyan}` : "2px solid transparent", borderRadius: 10, padding: "10px 4px", cursor: "pointer", color: active ? C.cyan : C.textMuted, fontWeight: active ? 700 : 400, fontSize: 12, fontFamily: "inherit" }}>
                {c}
              </button>
            );
          })}
        </div>
        {budget.sources.length > 0 && (
          <>
            <SectionLabel>PAYMENT SOURCE</SectionLabel>
            <div style={{ position: "relative", margin: "0 -20px", padding: "0 20px", marginBottom: 12 }}>
              <div className="no-scrollbar" style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8, scrollbarWidth: "none", msOverflowStyle: "none" as any, scrollSnapType: "x mandatory", WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)", maskImage: "linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)" }}>
                {budget.sources.map(src => {
                  const active = selectedSourceId === src.id;
                  return (
                    <button key={src.id} onClick={() => { setSelectedSourceId(src.id); setLocalCurrency(src.currency); }} style={{ flexShrink: 0, background: active ? "#003d45" : C.card3, border: active ? `2px solid ${src.color}` : "2px solid transparent", borderRadius: 14, padding: "12px 16px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 120, scrollSnapAlign: "start" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: src.color }} />
                        <span style={{ color: active ? C.text : C.textMuted, fontWeight: active ? 700 : 400, fontSize: 13 }}>{src.name}</span>
                      </div>
                      <span style={{ color: C.textSub, fontSize: 11 }}>{src.currency}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        <SectionLabel>CATEGORY</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {categories.map(c => {
            const active = cat === c.id;
            return (
              <button key={c.id} onClick={() => setCat(c.id)} style={{ background: active ? "#003d45" : C.card3, border: active ? `2px solid ${C.cyan}` : "2px solid transparent", borderRadius: 14, padding: "16px 8px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <Icon d={c.icon} size={22} stroke={active ? C.cyan : C.textMuted} />
                <span style={{ color: active ? C.cyan : C.textMuted, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{c.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 20 }}>
        <SectionLabel>DATE & TIME</SectionLabel>
        <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon d={icons.calendar} size={16} stroke={C.textMuted} />
          <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)}
            style={{
              background: "transparent", border: "none", color: C.text, fontSize: 15,
              flex: 1, outline: "none", fontFamily: "inherit", colorScheme: "dark"
            }} />
          <input type="time" value={expTime} onChange={e => setExpTime(e.target.value)}
            style={{
              background: "transparent", border: "none", color: C.textMuted, fontSize: 14,
              outline: "none", fontFamily: "inherit", colorScheme: "dark", width: 80
            }} />
        </Card>
      </div>
      <div style={{ marginTop: 20 }}>
        <SectionLabel>LOCATION</SectionLabel>
        <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z M12 10a2 2 0 100-4 2 2 0 000 4z" size={16} stroke={C.textMuted} />
          <input value={city} onChange={e => setCity(e.target.value)} placeholder="City (auto-detected)"
            style={{ background: "transparent", border: "none", color: C.text, fontSize: 15, flex: 1, outline: "none", fontFamily: "inherit" }} />
        </Card>
      </div>
      <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
        <div style={{ background: C.card3, borderRadius: 14, padding: "12px 16px", flex: 1 }}>
          <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>DAILY BALANCE REMAINING</div>
          <div style={{ color: remainingBase >= 0 ? C.green : C.red, fontSize: 15, fontWeight: 800 }}>
            {currSym(budget.baseCurrency)}{fmtAmt(remainingBase)}
            {localCurrency !== budget.baseCurrency ? ` / ${currSym(localCurrency)}${fmtAmt(remainingLocal)}` : ""}
          </div>
        </div>
        {selectedSource && (
          <div style={{ background: C.card3, borderRadius: 14, padding: "12px 16px", flex: 1 }}>
            <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>
              {isCredit ? "SOURCE CREDIT REMAINING" : "SOURCE BALANCE REMAINING"}
            </div>
            <div style={{ color: sourceRemainingBase >= 0 ? C.green : C.red, fontSize: 15, fontWeight: 800 }}>
              {currSym(budget.baseCurrency)}{fmtAmt(sourceRemainingBase)}
              {!isCredit && localCurrency !== budget.baseCurrency ? ` / ${currSym(localCurrency)}${fmtAmt(sourceRemainingLocal)}` : ""}
            </div>
          </div>
        )}
      </div>
      <div style={{ marginTop: 20 }}>
        <SectionLabel>EXPENSE TYPE</SectionLabel>
        <div style={{ background: C.card3, borderRadius: 14, padding: 4, display: "flex" }}>
          {["personal", "group"].map(t => (
            <button key={t} onClick={() => setExpType(t)} style={{ flex: 1, padding: "12px", borderRadius: 10, border: "none", cursor: "pointer", background: expType === t ? C.cyan : "transparent", color: expType === t ? "#000" : C.textMuted, fontWeight: expType === t ? 700 : 400, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: "inherit", transition: "all 0.2s" }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {expType === "group" && (
        <div style={{ marginTop: 20 }}>
          <div style={{ marginBottom: 10 }}>
            <span style={{ color: C.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>SPLIT</span>
          </div>
          {members.map(m => {
            const toPay = totalShares > 0 ? (total * shares[m] / totalShares).toFixed(2) : "0.00";
            return (
              <Card key={m} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <Avatar name={m} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{m}</div>
                    <div style={{ color: C.cyan, fontSize: 12 }}>{currSym(localCurrency)}{toPay}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 1, background: C.card3, borderRadius: 10, padding: 12 }}>
                    <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>SHARES</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button onClick={() => setShares((s: any) => ({ ...s, [m]: Math.max(0, s[m] - 1) }))} style={{ width: 30, height: 30, borderRadius: "50%", background: C.card, border: "none", cursor: "pointer", color: C.text, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{shares[m]}</span>
                      <button onClick={() => setShares((s: any) => ({ ...s, [m]: s[m] + 1 }))} style={{ width: 30, height: 30, borderRadius: "50%", background: C.card, border: "none", cursor: "pointer", color: C.text, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                    </div>
                  </div>
                  <div style={{ flex: 1, background: C.card3, borderRadius: 10, padding: 12 }}>
                    <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>FIXED {currSym(localCurrency)}</div>
                    <input placeholder="0.00" style={{ background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 15, fontFamily: "inherit", width: "100%" }} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        <SectionLabel>DESCRIPTION</SectionLabel>
        <Input placeholder="e.g. Dinner" value={desc} onChange={setDesc} />
      </div>
      <div style={{ marginTop: 20 }}>
        <SectionLabel>WHO PAID?</SectionLabel>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
          {members.map(m => (
            <button key={m} onClick={() => setWhoPaid(m)} style={{ background: whoPaid === m ? "#fff" : C.card3, color: whoPaid === m ? "#000" : C.text, border: "none", borderRadius: 20, padding: "10px 18px", fontWeight: whoPaid === m ? 700 : 400, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>{m}</button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 20, marginBottom: 20 }}>
        <SectionLabel>RECEIPT</SectionLabel>
        <input type="file" accept="image/*" id="receiptInput" style={{ display: "none" }}
          onChange={async e => {
            const f = e.target.files?.[0];
            if (!f) return;
            const compressed = await compressImage(f);
            setReceiptDataUrl(compressed);
          }} />
        {receiptDataUrl ? (
          <div style={{ position: "relative" }}>
            <img src={receiptDataUrl} style={{ width: "100%", borderRadius: 14, maxHeight: 180, objectFit: "cover" }} />
            <button onClick={() => setReceiptDataUrl(null)} style={{
              position: "absolute", top: 8, right: 8,
              background: C.redDim, border: "none", borderRadius: "50%", width: 28, height: 28,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
            }}>
              <Icon d={icons.x} size={14} stroke={C.red} />
            </button>
          </div>
        ) : (
          <label htmlFor="receiptInput" style={{
            border: `2px dashed ${C.border}`, borderRadius: 14, padding: 20,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer"
          }}>
            <Icon d={icons.receipt} size={20} stroke={C.textMuted} />
            <span style={{ color: C.textMuted, fontSize: 14 }}>Add Receipt</span>
          </label>
        )}
      </div>
      <Btn style={{ width: "100%" }} onClick={async () => {
        if (saving) return;
        setSaving(true);
        const localAmount = parseFloat(amount) || 0;
        let localToBaseRate = 1;
        try {
          if (localCurrency !== budget.baseCurrency)
            localToBaseRate = await fetchRate(localCurrency, budget.baseCurrency);
        } catch { }
        const expense: Expense = {
          id: crypto.randomUUID(),
          description: desc || categories.find(c => c.id === cat)?.label || cat,
          category: cat,
          date: new Date(`${expDate || localDateKey(new Date())}T${expTime || '12:00'}:00`).toISOString(),
          sourceId: selectedSourceId,
          type: expType as "personal" | "group",
          localAmount,
          localCurrency,
          baseAmount: localAmount * localToBaseRate,
          baseCurrency: budget.baseCurrency,
          localToBaseRate,
          whoPaid: expType === "group" ? whoPaid : undefined,
          splits: expType === "group" ? shares : undefined,
          receiptDataUrl: receiptDataUrl || undefined,
          city: city.trim() || undefined,
          tripId: activeTripId ?? undefined,
        };
        try {
          const prev = localStorage.getItem('tripversal_expenses');
          const arr: Expense[] = prev ? JSON.parse(prev) : [];
          const merged = [expense, ...arr].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
        } catch { }
        setSaving(false);
        onBack();
        // Background write to server (fire-and-forget)
        if (activeTripId && user?.sub) {
          fetch(`/api/trips/${activeTripId}/expenses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callerSub: user.sub, ...expenseToRow(expense) }),
          }).catch(() => { });
        }
      }}>{saving ? "Saving..." : "Save Expense"}</Btn>
    </div>
  );
};

const PhotosScreen = () => (
  <div style={{ padding: "16px 20px 100px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 4 }}>
      <div>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>SOCIAL STREAM</div>
        <div style={{ color: C.textMuted, fontSize: 12, letterSpacing: 1 }}>SHARED MEMORIES</div>
      </div>
      <div style={{ background: "#1a2a1a", borderRadius: 20, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.green }} />
        <span style={{ color: C.green }}>LIVE FEED</span>
      </div>
    </div>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400, gap: 16 }}>
      <div style={{ width: 80, height: 80, borderRadius: "50%", background: C.card3, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon d={icons.camera} size={36} stroke={C.textMuted} />
      </div>
      <div style={{ color: C.textMuted, fontSize: 15, fontStyle: "italic" }}>No memories shared yet. Be the first!</div>
      <button style={{ background: "transparent", border: `1.5px solid ${C.cyan}`, borderRadius: 20, padding: "12px 24px", color: C.cyan, fontSize: 13, fontWeight: 700, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>POST MEMORY</button>
    </div>
    <div style={{ position: "fixed", bottom: 90, right: "calc(50% - 200px)", width: 56, height: 56, borderRadius: "50%", background: C.cyan, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: `0 4px 20px ${C.cyan}50` }}>
      <Icon d={icons.camera} size={24} stroke="#000" />
    </div>
  </div>
);

const SOSScreen = ({ user }: { user?: any }) => {
  const [medical, setMedical] = useState<MedicalId>(() => { try { const s = localStorage.getItem('tripversal_medical_id'); return s ? JSON.parse(s) : DEFAULT_MEDICAL; } catch { return DEFAULT_MEDICAL; } });
  const [editMedical, setEditMedical] = useState(false);
  const [medDraft, setMedDraft] = useState<MedicalId>(medical);

  const [insurance, setInsurance] = useState<Insurance>(() => { try { const s = localStorage.getItem('tripversal_insurance'); return s ? JSON.parse(s) : DEFAULT_INSURANCE; } catch { return DEFAULT_INSURANCE; } });
  const [editInsurance, setEditInsurance] = useState(false);
  const [insDraft, setInsDraft] = useState<Insurance>(insurance);

  const [documents, setDocuments] = useState<TravelDocument[]>(() => { try { const s = localStorage.getItem('tripversal_documents'); return s ? JSON.parse(s) : []; } catch { return []; } });
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [docName, setDocName] = useState('');
  const [docType, setDocType] = useState('Passport');
  const [docDataUrl, setDocDataUrl] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<TravelDocument | null>(null);

  // Hydrate from Supabase on mount
  useEffect(() => {
    if (!user?.sub) return;
    fetch(`/api/users/${user.sub}/medical`).then(r => r.ok ? r.json() : null).then(row => {
      if (!row) return;
      const m: MedicalId = { bloodType: row.blood_type || '', contactName: row.contact_name || '', contactPhone: row.contact_phone || '', allergies: row.allergies || '', medications: row.medications || '', notes: row.notes || '', sharing: row.sharing ?? true };
      setMedical(m); setMedDraft(m); localStorage.setItem('tripversal_medical_id', JSON.stringify(m));
    }).catch(() => { });
    fetch(`/api/users/${user.sub}/insurance`).then(r => r.ok ? r.json() : null).then(row => {
      if (!row) return;
      const i: Insurance = { provider: row.provider || '', policyNumber: row.policy_number || '', emergencyPhone: row.emergency_phone || '', coverageStart: row.coverage_start || '', coverageEnd: row.coverage_end || '', notes: row.notes || '' };
      setInsurance(i); setInsDraft(i); localStorage.setItem('tripversal_insurance', JSON.stringify(i));
    }).catch(() => { });
    fetch(`/api/users/${user.sub}/documents`).then(r => r.ok ? r.json() : null).then((rows: any[]) => {
      if (!rows || rows.length === 0) return;
      const docs: TravelDocument[] = rows.map(r => ({ id: r.id, name: r.name, docType: r.doc_type, dataUrl: r.file_data, createdAt: r.created_at }));
      setDocuments(docs); localStorage.setItem('tripversal_documents', JSON.stringify(docs));
    }).catch(() => { });
  }, [user?.sub]);

  const saveMedical = (m: MedicalId) => {
    setMedical(m); localStorage.setItem('tripversal_medical_id', JSON.stringify(m));
    if (user?.sub) fetch(`/api/users/${user.sub}/medical`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) }).catch(() => { });
  };
  const saveInsurance = (i: Insurance) => {
    setInsurance(i); localStorage.setItem('tripversal_insurance', JSON.stringify(i));
    if (user?.sub) fetch(`/api/users/${user.sub}/insurance`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(i) }).catch(() => { });
  };
  const saveDocs = (d: TravelDocument[]) => { setDocuments(d); localStorage.setItem('tripversal_documents', JSON.stringify(d)); };
  const addDoc = (doc: TravelDocument) => {
    const next = [doc, ...documents];
    setDocuments(next); localStorage.setItem('tripversal_documents', JSON.stringify(next));
    if (user?.sub) fetch(`/api/users/${user.sub}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: doc.id, name: doc.name, docType: doc.docType, fileData: doc.dataUrl }) }).catch(() => { });
  };
  const deleteDoc = (id: string) => {
    const next = documents.filter(d => d.id !== id);
    setDocuments(next); localStorage.setItem('tripversal_documents', JSON.stringify(next));
    if (user?.sub) fetch(`/api/users/${user.sub}/documents/${id}`, { method: 'DELETE' }).catch(() => { });
  };

  const textareaStyle: any = { background: C.card3, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", color: C.text, fontSize: 14, width: "100%", outline: "none", fontFamily: "inherit", resize: "none", boxSizing: "border-box" };

  return (
    <div style={{ padding: "16px 20px 100px" }}>
      {/* ── Medical ID ── */}
      <Card style={{ marginBottom: 16, border: `1px solid ${C.red}20` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon d={icons.heart} size={18} stroke={C.red} fill={`${C.red}30`} />
            <span style={{ fontWeight: 700, fontSize: 16 }}>My Medical ID</span>
          </div>
          {!editMedical ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Toggle value={medical.sharing} onChange={(v: boolean) => saveMedical({ ...medical, sharing: v })} />
              <span style={{ color: C.cyan, fontSize: 11, fontWeight: 700 }}>SHARING</span>
              <button onClick={() => { setMedDraft(medical); setEditMedical(true); }} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}><Icon d={icons.edit} size={15} stroke={C.textMuted} /></button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => setEditMedical(false)}>Cancel</Btn>
              <Btn style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { saveMedical(medDraft); setEditMedical(false); }}>Save</Btn>
            </div>
          )}
        </div>
        {editMedical ? (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>BLOOD TYPE</div>
              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
                {BLOOD_TYPES.map(bt => <button key={bt} onClick={() => setMedDraft(d => ({ ...d, bloodType: bt }))} style={{ background: medDraft.bloodType === bt ? C.red : C.card3, color: medDraft.bloodType === bt ? "#fff" : C.textMuted, border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{bt}</button>)}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CONTACT NAME</div><Input placeholder="e.g. Mom" value={medDraft.contactName} onChange={(v: string) => setMedDraft(d => ({ ...d, contactName: v }))} /></div>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CONTACT PHONE</div><Input placeholder="+55 11 9…" value={medDraft.contactPhone} onChange={(v: string) => setMedDraft(d => ({ ...d, contactPhone: v }))} /></div>
            </div>
            <div style={{ marginBottom: 10 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>ALLERGIES</div><textarea rows={2} value={medDraft.allergies} onChange={e => setMedDraft(d => ({ ...d, allergies: e.target.value }))} placeholder="e.g. Penicillin, Peanuts" style={textareaStyle} /></div>
            <div style={{ marginBottom: 10 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>MEDICATIONS</div><textarea rows={2} value={medDraft.medications} onChange={e => setMedDraft(d => ({ ...d, medications: e.target.value }))} placeholder="e.g. Metformin 500mg" style={textareaStyle} /></div>
            <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>MEDICAL NOTES</div><textarea rows={2} value={medDraft.notes} onChange={e => setMedDraft(d => ({ ...d, notes: e.target.value }))} placeholder="Other info for emergency responders" style={textareaStyle} /></div>
          </>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>BLOOD TYPE</div>
                <div style={{ fontWeight: 800, fontSize: 22, color: medical.bloodType ? C.red : C.textSub }}>{medical.bloodType || '—'}</div>
              </div>
              <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>EMERGENCY CONTACT</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{medical.contactName || '—'}</div>
                {medical.contactPhone && <a href={`tel:${medical.contactPhone}`} style={{ color: C.cyan, fontSize: 12, textDecoration: "none" }}>{medical.contactPhone}</a>}
              </div>
            </div>
            {medical.allergies && <div style={{ background: C.card3, borderRadius: 12, padding: 12, marginBottom: 8 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>ALLERGIES</div><div style={{ fontSize: 13 }}>{medical.allergies}</div></div>}
            {medical.medications && <div style={{ background: C.card3, borderRadius: 12, padding: 12, marginBottom: 8 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>MEDICATIONS</div><div style={{ fontSize: 13 }}>{medical.medications}</div></div>}
            {medical.notes && <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>MEDICAL NOTES</div><div style={{ fontSize: 13 }}>{medical.notes}</div></div>}
            {!medical.bloodType && !medical.contactName && <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "8px 0" }}>Tap edit to fill in your Medical ID</div>}
          </>
        )}
      </Card>

      {/* ── Travel Insurance ── */}
      <SectionLabel>TRAVEL INSURANCE</SectionLabel>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: editInsurance ? 14 : 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Insurance</span>
          {!editInsurance ? (
            <button onClick={() => { setInsDraft(insurance); setEditInsurance(true); }} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}><Icon d={icons.edit} size={15} stroke={C.textMuted} /></button>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => setEditInsurance(false)}>Cancel</Btn>
              <Btn style={{ padding: "6px 14px", fontSize: 13 }} onClick={() => { saveInsurance(insDraft); setEditInsurance(false); }}>Save</Btn>
            </div>
          )}
        </div>
        {editInsurance ? (
          <>
            <Input placeholder="Provider (e.g. Allianz)" value={insDraft.provider} onChange={(v: string) => setInsDraft(d => ({ ...d, provider: v }))} style={{ marginBottom: 10 }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>POLICY NUMBER</div><Input placeholder="e.g. AZ-9920" value={insDraft.policyNumber} onChange={(v: string) => setInsDraft(d => ({ ...d, policyNumber: v }))} /></div>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>EMERGENCY PHONE</div><Input placeholder="+1 800…" value={insDraft.emergencyPhone} onChange={(v: string) => setInsDraft(d => ({ ...d, emergencyPhone: v }))} /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>COVERAGE START</div><Card style={{ padding: 10 }}><input type="date" value={insDraft.coverageStart} onChange={e => setInsDraft(d => ({ ...d, coverageStart: e.target.value }))} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} /></Card></div>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>COVERAGE END</div><Card style={{ padding: 10 }}><input type="date" value={insDraft.coverageEnd} onChange={e => setInsDraft(d => ({ ...d, coverageEnd: e.target.value }))} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} /></Card></div>
            </div>
            <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>NOTES</div><textarea rows={2} value={insDraft.notes} onChange={e => setInsDraft(d => ({ ...d, notes: e.target.value }))} placeholder="Coverage limits, exclusions…" style={textareaStyle} /></div>
          </>
        ) : insurance.provider ? (
          <>
            <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4, marginTop: 12 }}>PROVIDER</div>
            <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 14 }}>{insurance.provider}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>POLICY NUMBER</div><Badge color={C.textMuted} bg={C.card3}>{insurance.policyNumber || '—'}</Badge></div>
              <div><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>EMERGENCY PHONE</div>
                {insurance.emergencyPhone ? <a href={`tel:${insurance.emergencyPhone}`} style={{ color: C.cyan, fontWeight: 700, textDecoration: "none" }}>{insurance.emergencyPhone}</a> : <span style={{ color: C.textSub }}>—</span>}
              </div>
            </div>
            {(insurance.coverageStart || insurance.coverageEnd) && <div style={{ background: C.card3, borderRadius: 12, padding: "10px 12px", marginBottom: 12, fontSize: 12, color: C.textMuted }}>Coverage: {insurance.coverageStart || '?'} → {insurance.coverageEnd || '?'}</div>}
            {insurance.notes && <div style={{ background: C.card3, borderRadius: 12, padding: "10px 12px", marginBottom: 12, fontSize: 13, color: C.textSub }}>{insurance.notes}</div>}
            {insurance.emergencyPhone && <Btn style={{ width: "100%", background: C.cyan, color: "#000" }} onClick={() => window.open(`tel:${insurance.emergencyPhone}`)} icon={<Icon d={icons.phone} size={16} stroke="#000" />}>CALL EMERGENCY ASSIST</Btn>}
          </>
        ) : (
          <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "16px 0" }}>Tap edit to add your travel insurance</div>
        )}
      </Card>

      {/* ── Critical Documents ── */}
      <SectionLabel icon="fileText" action={
        <button onClick={() => { setShowAddDoc(true); setDocName(''); setDocType('Passport'); setDocDataUrl(null); }} style={{ width: 32, height: 32, borderRadius: 10, background: C.card3, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon d={icons.plus} size={16} /></button>
      }>CRITICAL DOCUMENTS</SectionLabel>

      {showAddDoc && (
        <Card style={{ marginBottom: 12, border: `1px solid ${C.cyan}30` }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>Add Document</div>
          <Input placeholder="Document name (e.g. Passport)" value={docName} onChange={setDocName} style={{ marginBottom: 10 }} />
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TYPE</div>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
              {DOC_TYPES.map(t => <button key={t} onClick={() => setDocType(t)} style={{ background: docType === t ? C.cyan : C.card3, color: docType === t ? "#000" : C.textMuted, border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t}</button>)}
            </div>
          </div>
          <input type="file" accept="image/*" id="docInput" style={{ display: "none" }} onChange={async e => { const f = e.target.files?.[0]; if (f) { const c = await compressImage(f); setDocDataUrl(c); } }} />
          {docDataUrl ? (
            <div style={{ position: "relative", marginBottom: 12 }}>
              <img src={docDataUrl} style={{ width: "100%", borderRadius: 12, maxHeight: 160, objectFit: "cover" }} />
              <button onClick={() => setDocDataUrl(null)} style={{ position: "absolute", top: 8, right: 8, background: C.redDim, border: "none", borderRadius: "50%", width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon d={icons.x} size={14} stroke={C.red} /></button>
            </div>
          ) : (
            <label htmlFor="docInput" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: `2px dashed ${C.border}`, borderRadius: 12, padding: 16, cursor: "pointer", marginBottom: 12, color: C.textMuted, fontSize: 13 }}>
              <Icon d={icons.camera} size={18} stroke={C.textMuted} /> Capture or upload
            </label>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setShowAddDoc(false)}>Cancel</Btn>
            <Btn style={{ flex: 1 }} onClick={() => { if (!docName.trim() || !docDataUrl) return; const doc: TravelDocument = { id: crypto.randomUUID(), name: docName.trim(), docType, dataUrl: docDataUrl, createdAt: new Date().toISOString() }; addDoc(doc); setShowAddDoc(false); }}>Add</Btn>
          </div>
        </Card>
      )}

      {documents.length === 0 && !showAddDoc ? (
        <Card style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", padding: 40, gap: 12 }}>
          <div style={{ width: 60, height: 60, borderRadius: "50%", background: C.card3, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon d={icons.fileText} size={28} stroke={C.textMuted} /></div>
          <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center" }}>Store copies of passports, visas, and insurance cards for offline access.</div>
        </Card>
      ) : documents.map(doc => (
        <Card key={doc.id} style={{ marginBottom: 8, cursor: "pointer" }} onClick={() => setViewDoc(doc)}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 52, height: 52, borderRadius: 10, overflow: "hidden", flexShrink: 0 }}><img src={doc.dataUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{doc.name}</div>
              <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{doc.docType} · {new Date(doc.createdAt).toLocaleDateString()}</div>
            </div>
            <button onClick={e => { e.stopPropagation(); deleteDoc(doc.id); }} style={{ background: C.redDim, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}><Icon d={icons.trash} size={14} stroke={C.red} /></button>
          </div>
        </Card>
      ))}

      {viewDoc && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 400, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 400 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div><div style={{ fontWeight: 700, fontSize: 16 }}>{viewDoc.name}</div><div style={{ color: C.textMuted, fontSize: 12 }}>{viewDoc.docType}</div></div>
              <button onClick={() => setViewDoc(null)} style={{ background: C.card3, border: "none", borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><Icon d={icons.x} size={18} stroke={C.text} /></button>
            </div>
            <img src={viewDoc.dataUrl} style={{ width: "100%", borderRadius: 16, maxHeight: "70vh", objectFit: "contain" }} />
          </div>
        </div>
      )}
    </div>
  );
};

const SettingsScreen = ({ onManageCrew, user, onLogout, onHistory, trips = [], activeTripId, onSwitchTrip, onTripCreate, onTripUpdate, onTripDelete, offlineSim = false, setOfflineSim, isSyncing = false }: any) => {
  const [forcePending, setForcePending] = useState(false);
  // Profile / language / budget states
  const [language, setLanguage] = useState("en");
  const [avatarFile, setAvatarFile] = useState<any>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const saveProfile = () => {
    localStorage.setItem('tripversal_profile', JSON.stringify({ username, email, phone, avatarUrl }));
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setSavedAt(time);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  useEffect(() => {
    const stored = localStorage.getItem('tripversal_profile');
    if (stored) {
      try {
        const p = JSON.parse(stored);
        setUsername(p.username || user?.name || "");
        setEmail(p.email || user?.email || "");
        setPhone(p.phone || "");
        setAvatarUrl(p.avatarUrl || user?.picture || null);
      } catch { }
    } else {
      setUsername(user?.name || "");
      setEmail(user?.email || "");
      setAvatarUrl(user?.picture || null);
    }
  }, []);
  // Budget states moved to WalletScreen

  const activeTrip: Trip | null = trips.find((t: Trip) => t.id === activeTripId) ?? null;

  const onAvatarChange = (e: any) => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      setAvatarFile(f);
      const reader = new FileReader();
      reader.onloadend = () => setAvatarUrl(reader.result as string);
      reader.readAsDataURL(f);
    }
  };

  return (
    <div style={{ padding: "16px 20px 100px", overflowY: "auto" }}>
      <SectionLabel>GENERAL</SectionLabel>
      <Card style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "#1a1a4a", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon d={icons.globe} size={18} stroke="#6464e0" />
          </div>
          <span style={{ flex: 1, fontWeight: 500 }}>Language</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => setLanguage("pt")} style={{ background: language === "pt" ? C.cyan : C.card3, color: language === "pt" ? "#000" : C.text, border: "none", borderRadius: 10, padding: "8px 10px", cursor: "pointer" }}>Português</button>
            <button onClick={() => setLanguage("en")} style={{ background: language === "en" ? C.cyan : C.card3, color: language === "en" ? "#000" : C.text, border: "none", borderRadius: 10, padding: "8px 10px", cursor: "pointer" }}>English</button>
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1 }}>
            <div style={{ width: 72, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {avatarUrl ? <img src={avatarUrl} alt="avatar" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Avatar name={username || "?"} size={72} color="#aaa" />}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input type="file" accept="image/*" onChange={onAvatarChange} style={{ display: "none" }} id="avatarInput" />
                <label htmlFor="avatarInput" style={{ background: C.card3, padding: "8px 12px", borderRadius: 10, cursor: "pointer", color: C.text, fontWeight: 700 }}>Change Avatar</label>
                <button onClick={() => { setAvatarFile(null); setAvatarUrl(null); }} style={{ background: C.card3, padding: "8px 12px", borderRadius: 10, border: "none", cursor: "pointer", color: C.text }}>Remove</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                <Input placeholder="Username" value={username} onChange={setUsername} />
                <Input placeholder="Email" value={email} onChange={setEmail} />
                <Input placeholder="Phone" value={phone} onChange={setPhone} />
              </div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <Btn
            onClick={saveProfile}
            variant="primary"
            icon={profileSaved ? <Icon d={icons.check} size={16} stroke="#000" /> : undefined}
            style={profileSaved ? { background: C.green, transition: "background 0.2s" } : { transition: "background 0.2s" }}
          >
            {profileSaved ? "Saved!" : "Save Profile"}
          </Btn>
          <Btn onClick={() => { setUsername(user?.name || ""); setEmail(user?.email || ""); setPhone(""); setAvatarUrl(user?.picture || null); }} variant="ghost">Reset</Btn>
          {savedAt && (
            <span style={{ color: C.textSub, fontSize: 11, marginLeft: 4 }}>
              <Icon d={icons.check} size={11} stroke={C.green} style={{ display: "inline", verticalAlign: "middle", marginRight: 3 }} />
              Synced {savedAt}
            </span>
          )}
        </div>
      </Card>

      <SectionLabel icon="clock">TRANSACTION HISTORY</SectionLabel>
      <Btn style={{ width: "100%", marginBottom: 20 }} variant="secondary"
        icon={<Icon d={icons.receipt} size={16} stroke={C.textMuted} />}
        onClick={onHistory}>View History</Btn>
      <SectionLabel icon="bug">DEV CONTROLS</SectionLabel>
      <Card>
        {[
          { label: "Offline Simulation", sub: offlineSim ? "SIMULATING OFFLINE" : isSyncing ? "SYNCING…" : "NETWORK ONLINE", icon: icons.wifi, val: offlineSim, set: setOfflineSim, iconBg: offlineSim ? "#2a1400" : "#003d10", iconColor: offlineSim ? C.yellow : C.green },
          { label: "Force Pending State", sub: "Simulate data waiting to sync.", icon: icons.refreshCw, val: forcePending, set: setForcePending, iconBg: "#1a1a00", iconColor: C.yellow },
        ].map(item => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: item.iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon d={item.icon} size={20} stroke={item.iconColor} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{item.label}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{item.sub}</div>
            </div>
            <Toggle value={item.val} onChange={item.set} />
          </div>
        ))}
      </Card>
      <div style={{ color: C.textSub, fontSize: 11, textAlign: "center", marginTop: 20 }}>FamilyVoyage v1.1.0 latam • UUID: HW1DC1</div>
      <div style={{ marginTop: 16, marginBottom: 8 }}>
        <Btn variant="danger" style={{ width: "100%" }} onClick={onLogout} icon={<Icon d={icons.login} size={16} stroke={C.red} />}>Sign Out</Btn>
      </div>
    </div>
  );
};

const TransactionHistoryScreen = ({ onBack }: any) => {
  const [histTab, setHistTab] = useState<"edits" | "deleted">("edits");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [deletedExpenses, setDeletedExpenses] = useState<any[]>([]);

  useEffect(() => {
    try {
      const es = localStorage.getItem('tripversal_expenses');
      if (es) setExpenses(JSON.parse(es));
      const ds = localStorage.getItem('tripversal_deleted_expenses');
      if (ds) setDeletedExpenses(JSON.parse(ds));
    } catch { }
  }, []);

  const editedExpenses = expenses.filter(e => e.editHistory && e.editHistory.length > 0);

  return (
    <div style={{ padding: "16px 20px 100px", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.card3, border: "none", borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.text, fontSize: 18 }}>←</button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Transaction History</span>
      </div>
      <div style={{ background: C.card3, borderRadius: 14, padding: 4, display: "flex", marginBottom: 20 }}>
        {(["edits", "deleted"] as const).map(t => (
          <button key={t} onClick={() => setHistTab(t)} style={{ flex: 1, padding: "12px", borderRadius: 10, border: "none", cursor: "pointer", background: histTab === t ? C.cyan : "transparent", color: histTab === t ? "#000" : C.textMuted, fontWeight: histTab === t ? 700 : 400, fontSize: 13, fontFamily: "inherit", transition: "all 0.2s", letterSpacing: 1 }}>
            {t === "edits" ? "EDITS" : "DELETED"}
          </button>
        ))}
      </div>
      {histTab === "edits" ? (
        editedExpenses.length === 0 ? (
          <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>No edited transactions yet.</div>
        ) : (
          editedExpenses.map(exp => (
            <Card key={exp.id} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{exp.description}</div>
              <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 10 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)} • Current</div>
              {exp.editHistory!.map((h, i) => (
                <div key={i} style={{ background: C.card3, borderRadius: 10, padding: 10, marginBottom: 6 }}>
                  <div style={{ color: C.textSub, fontSize: 11, marginBottom: 2 }}>{new Date(h.at).toLocaleString("en")}</div>
                  <div style={{ color: C.textMuted, fontSize: 12 }}>Was: "{h.snapshot.description}" {currSym(h.snapshot.localCurrency)}{fmtAmt(h.snapshot.localAmount)}</div>
                </div>
              ))}
            </Card>
          ))
        )
      ) : (
        deletedExpenses.length === 0 ? (
          <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>No deleted transactions.</div>
        ) : (
          deletedExpenses.map((exp, i) => (
            <Card key={i} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{exp.description}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{currSym(exp.localCurrency)}{fmtAmt(exp.localAmount)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <Badge color={C.red} bg={C.redDim}>DELETED</Badge>
                  <div style={{ color: C.textSub, fontSize: 10, marginTop: 4 }}>{new Date(exp.deletedAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}</div>
                </div>
              </div>
            </Card>
          ))
        )
      )}
    </div>
  );
};

const InviteAcceptScreen = ({ token, user, onDone, onDecline }: any) => {
  const [state, setState] = useState<'loading' | 'valid' | 'invalid' | 'accepting'>('loading');
  const [inviteInfo, setInviteInfo] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/invites/${token}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => { setInviteInfo(data); setState('valid'); })
      .catch(() => setState('invalid'));
  }, [token]);

  const handleAccept = async () => {
    setState('accepting');
    try {
      const res = await fetch(`/api/invites/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleSub: user.sub, name: user.name, avatarUrl: user.picture }),
      });
      if (!res.ok) throw new Error();
      const tripRow = await res.json();
      const trip = rowToTrip(tripRow);
      pushInviteEvent({ id: crypto.randomUUID(), type: 'accepted', email: user.email, name: user.name, tripName: trip.name, at: new Date().toISOString() });
      onDone(trip);
    } catch { setState('valid'); }
  };

  if (state === 'loading' || state === 'accepting') return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16 }}>
      <div style={{ width: 48, height: 48, border: `3px solid ${C.card3}`, borderTopColor: C.cyan, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <div style={{ color: C.textMuted, fontSize: 14 }}>{state === 'accepting' ? 'Joining crew…' : 'Loading invite…'}</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (state === 'invalid') return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 20, padding: "0 40px" }}>
      <div style={{ fontSize: 48 }}>🔗</div>
      <div style={{ fontWeight: 800, fontSize: 20, color: C.text, textAlign: "center" }}>Invite no longer valid</div>
      <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center" }}>This link has expired, already been used, or doesn't exist.</div>
      <Btn onClick={onDecline} variant="secondary" style={{ width: "100%", maxWidth: 280 }}>Go to App</Btn>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 20, padding: "0 28px" }}>
      <div style={{ background: `${C.cyan}20`, border: `1px solid ${C.cyan}40`, borderRadius: 20, padding: 28, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✈️</div>
        <div style={{ fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 6 }}>{inviteInfo?.tripName}</div>
        {inviteInfo?.tripDestination && <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 4 }}>{inviteInfo.tripDestination}</div>}
        {inviteInfo?.startDate && inviteInfo?.endDate && (
          <div style={{ color: C.textSub, fontSize: 13 }}>{formatDateRange(inviteInfo.startDate, inviteInfo.endDate)}</div>
        )}
      </div>
      <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center" }}>
        You've been invited to join this trip's Travel Crew.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <Btn onClick={handleAccept} style={{ width: "100%" }}>Join Travel Crew</Btn>
        <Btn onClick={onDecline} variant="ghost" style={{ width: "100%" }}>Decline</Btn>
      </div>
    </div>
  );
};

const ManageCrewScreen = ({ trip, user, onBack, onTripUpdate }: any) => {
  const [crewTab, setCrewTab] = useState<'crew' | 'segments' | 'budget'>('crew');
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteToast, setInviteToast] = useState<string | null>(null);
  const [menuMemberId, setMenuMemberId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Budget tab moved to WalletScreen
  // Segment form
  const [showAddSeg, setShowAddSeg] = useState(false);
  const [segName, setSegName] = useState("");
  const [segOrigin, setSegOrigin] = useState("");
  const [segDest, setSegDest] = useState("");
  const [segStart, setSegStart] = useState("");
  const [segEnd, setSegEnd] = useState("");
  const [segColor, setSegColor] = useState("#00e5ff");
  const [segAssigned, setSegAssigned] = useState<string[]>([]);
  const [segSaving, setSegSaving] = useState(false);
  const segColors = ["#00e5ff", "#30d158", "#ffd60a", "#ff3b30", "#f57c00", "#6a1b9a", "#1565c0", "#e91e8c"];
  // Segment attachments
  const [segAttachments, setSegAttachments] = useState<SegmentAttachment[]>(() => {
    try { const s = localStorage.getItem(`tripversal_seg_att_${trip?.id}`); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [segIconTab, setSegIconTab] = useState<'colors' | 'flags' | 'emojis'>('colors');
  const [segError, setSegError] = useState<string | null>(null);
  const [attError, setAttError] = useState<string | null>(null);
  // Edit segment
  const [editSegId, setEditSegId] = useState<string | null>(null);
  const [editSegName, setEditSegName] = useState('');
  const [editSegOrigin, setEditSegOrigin] = useState('');
  const [editSegDest, setEditSegDest] = useState('');
  const [editSegStart, setEditSegStart] = useState('');
  const [editSegEnd, setEditSegEnd] = useState('');
  const [editSegColor, setEditSegColor] = useState('#00e5ff');
  const [editSegAssigned, setEditSegAssigned] = useState<string[]>([]);
  const [editSegIconTab, setEditSegIconTab] = useState<'colors' | 'flags' | 'emojis'>('colors');
  const [editSegSaving, setEditSegSaving] = useState(false);
  const [expandedSegId, setExpandedSegId] = useState<string | null>(null);
  const [addAttSegId, setAddAttSegId] = useState<string | null>(null);
  const [attName, setAttName] = useState('');
  const [attDataUrl, setAttDataUrl] = useState<string | null>(null);
  const [viewAtt, setViewAtt] = useState<SegmentAttachment | null>(null);

  const saveSegAttachments = (atts: SegmentAttachment[]) => {
    setSegAttachments(atts);
    localStorage.setItem(`tripversal_seg_att_${trip?.id}`, JSON.stringify(atts));
  };
  const addSegAttachment = (att: SegmentAttachment) => {
    const next = [att, ...segAttachments];
    saveSegAttachments(next);
    if (user?.sub) {
      fetch(`/api/trips/${trip.id}/segments/${att.segmentId}/attachments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, id: att.id, name: att.name, fileData: att.fileData }),
      }).catch(() => { });
    }
  };
  const deleteSegAttachment = (attId: string, segId: string) => {
    const next = segAttachments.filter(a => a.id !== attId);
    saveSegAttachments(next);
    if (user?.sub) {
      fetch(`/api/trips/${trip.id}/segments/${segId}/attachments/${attId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      }).catch(() => { });
    }
  };

  if (!trip) return (
    <div style={{ padding: "40px 20px", textAlign: "center", color: C.textMuted }}>No active trip selected.</div>
  );

  const crew: TripMember[] = trip.crew || [];
  const segments: TripSegment[] = trip.segments || [];
  const accepted = crew.filter((m: TripMember) => m.status === 'accepted');
  const pending = crew.filter((m: TripMember) => m.status === 'pending');
  const myMember = crew.find((m: TripMember) => m.googleSub === user?.sub);
  const myMemberId = myMember?.id || '';
  const isAdmin = myMember?.role === 'admin';

  const showToast = (msg: string) => { setInviteToast(msg); setTimeout(() => setInviteToast(null), 3000); };

  const handleSegmentMembership = async (segId: string, action: 'accept_invite' | 'decline_invite' | 'leave_segment') => {
    try {
      const res = await fetch(`/api/trips/${trip.id}/segments/${segId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, action })
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      const base = segments.find((s: TripSegment) => s.id === segId)!;
      const updatedSeg: TripSegment = { ...base, visibility: updated.visibility, assignedMemberIds: updated.assigned_member_ids || [], invitedMemberIds: updated.invited_member_ids || [] };
      onTripUpdate({ ...trip, segments: segments.map((s: TripSegment) => s.id === segId ? updatedSeg : s) });
    } catch { showToast("Failed to update status"); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !inviteEmail.includes('@')) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviterSub: user.sub, inviterName: user.name, email: inviteEmail.trim() }),
      });
      if (!res.ok) throw new Error();
      const { member } = await res.json();
      pushInviteEvent({ id: crypto.randomUUID(), type: 'invited', email: inviteEmail.trim(), tripName: trip.name, at: new Date().toISOString() });
      onTripUpdate({ ...trip, crew: [...crew.filter((m: TripMember) => m.email !== member.email), { id: member.id, email: member.email, role: 'member', status: 'pending', invitedAt: member.invited_at }] });
      setInviteEmail("");
      showToast("Invite sent!");
    } catch { showToast("Failed to send invite."); }
    setInviting(false);
  };

  const handleRoleChange = async (memberId: string, role: 'admin' | 'member') => {
    setMenuMemberId(null);
    try {
      await fetch(`/api/trips/${trip.id}/members/${memberId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, role }),
      });
      onTripUpdate({ ...trip, crew: crew.map((m: TripMember) => m.id === memberId ? { ...m, role } : m) });
    } catch { showToast("Failed to update role."); }
  };

  const handleRemoveMember = async (memberId: string) => {
    setConfirmRemoveId(null);
    try {
      await fetch(`/api/trips/${trip.id}/members/${memberId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      });
      onTripUpdate({ ...trip, crew: crew.filter((m: TripMember) => m.id !== memberId) });
    } catch { showToast("Failed to remove member."); }
  };

  const handleLeaveGroup = async () => {
    setConfirmLeave(false);
    try {
      const res = await fetch(`/api/trips/${trip.id}/members/leave`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      });
      if (!res.ok) { const d = await res.json(); showToast(d.error || "Failed to leave group."); return; }
      onBack();
    } catch { showToast("Failed to leave group."); }
  };



  const handleAddSegment = async () => {
    if (!segName.trim()) { setSegError("Segment name is required."); return; }
    setSegError(null);
    setSegSaving(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, name: segName.trim(), origin: segOrigin, destination: segDest, startDate: segStart || undefined, endDate: segEnd || undefined, color: segColor, assignedMemberIds: segAssigned }),
      });
      if (!res.ok) throw new Error();
      const seg = await res.json();
      const newSeg: TripSegment = { id: seg.id, name: seg.name, startDate: seg.start_date, endDate: seg.end_date, origin: seg.origin, destination: seg.destination, color: seg.color, visibility: seg.visibility, assignedMemberIds: seg.assigned_member_ids || [], invitedMemberIds: seg.invited_member_ids || [] };
      onTripUpdate({ ...trip, segments: [...segments, newSeg] });
      setSegName(""); setSegOrigin(""); setSegDest(""); setSegStart(""); setSegEnd(""); setSegColor("#00e5ff"); setSegAssigned([]); setSegIconTab('colors'); setShowAddSeg(false);
    } catch { showToast("Failed to add segment."); }
    setSegSaving(false);
  };

  const openEditSeg = (seg: TripSegment) => {
    setEditSegId(seg.id);
    setEditSegName(seg.name);
    setEditSegOrigin(seg.origin || '');
    setEditSegDest(seg.destination || '');
    setEditSegStart(seg.startDate || '');
    setEditSegEnd(seg.endDate || '');
    setEditSegColor(seg.color);
    setEditSegAssigned(seg.assignedMemberIds || []);
    const c = seg.color;
    setEditSegIconTab(c.startsWith('#') ? 'colors' : SEG_FLAGS.includes(c) ? 'flags' : 'emojis');
  };

  const handleEditSegment = async () => {
    if (!editSegName.trim()) { showToast("Segment name is required."); return; }
    setEditSegSaving(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/segments/${editSegId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, name: editSegName.trim(), origin: editSegOrigin || null, destination: editSegDest || null, startDate: editSegStart || null, endDate: editSegEnd || null, color: editSegColor, assignedMemberIds: editSegAssigned }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      const updatedSeg: TripSegment = { id: updated.id, name: updated.name, startDate: updated.start_date, endDate: updated.end_date, origin: updated.origin, destination: updated.destination, color: updated.color, visibility: updated.visibility, assignedMemberIds: updated.assigned_member_ids || [], invitedMemberIds: updated.invited_member_ids || [] };
      onTripUpdate({ ...trip, segments: segments.map((s: TripSegment) => s.id === editSegId ? updatedSeg : s) });
      setEditSegId(null);
    } catch { showToast("Failed to update segment."); }
    setEditSegSaving(false);
  };

  const handleDeleteSegment = async (segId: string) => {
    try {
      await fetch(`/api/trips/${trip.id}/segments/${segId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      });
      onTripUpdate({ ...trip, segments: segments.filter((s: TripSegment) => s.id !== segId) });
    } catch { showToast("Failed to delete segment."); }
  };

  return (
    <div style={{ padding: "16px 20px 100px", overflowY: "auto" }}>
      {inviteToast && (
        <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: C.card3, color: C.text, borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 600, zIndex: 300, border: `1px solid ${C.border}` }}>
          {inviteToast}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.card3, border: "none", borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.text, fontSize: 18 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Manage</div>
          <div style={{ color: C.textMuted, fontSize: 12 }}>{trip.name}</div>
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ background: C.card3, borderRadius: 14, padding: 4, display: "flex", marginBottom: 20 }}>
        {(['crew', 'segments'] as const).map(t => (
          <button key={t} onClick={() => setCrewTab(t as any)} style={{ flex: 1, padding: "10px 4px", borderRadius: 10, border: "none", cursor: "pointer", background: crewTab === t ? C.cyan : "transparent", color: crewTab === t ? "#000" : C.textMuted, fontWeight: crewTab === t ? 700 : 400, fontSize: 12, fontFamily: "inherit", transition: "all 0.2s", letterSpacing: 0.5 }}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {crewTab === 'crew' ? (
        <>
          {/* Accepted members */}
          {accepted.length > 0 && (
            <>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>ACCEPTED ({accepted.length})</div>
              {accepted.map((m: TripMember) => (
                <Card key={m.id} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={m.name || m.email} src={m.avatarUrl} size={42} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{m.name || m.email}</div>
                      <div style={{ color: C.textMuted, fontSize: 11 }}>{m.email}</div>
                    </div>
                    <Badge color={m.role === 'admin' ? C.cyan : C.textMuted} bg={m.role === 'admin' ? "#003d45" : C.card3}>{m.role.toUpperCase()}</Badge>
                    {isAdmin && m.googleSub !== user?.sub && (
                      <div style={{ position: "relative" }}>
                        <button onClick={() => setMenuMemberId(menuMemberId === m.id ? null : m.id)} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", color: C.textMuted }}>
                          <Icon d={icons.moreH} size={16} stroke={C.textMuted} />
                        </button>
                        {menuMemberId === m.id && (
                          <>
                            <div onClick={() => setMenuMemberId(null)} style={{ position: "fixed", inset: 0, zIndex: 10 }} />
                            <div style={{ position: "absolute", right: 0, top: 36, background: C.card2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 8, zIndex: 20, minWidth: 160 }}>
                              <button onClick={() => handleRoleChange(m.id, m.role === 'admin' ? 'member' : 'admin')} style={{ display: "block", width: "100%", background: "none", border: "none", cursor: "pointer", color: C.text, textAlign: "left", padding: "10px 12px", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}>
                                {m.role === 'admin' ? 'Demote to Member' : 'Promote to Admin'}
                              </button>
                              <button onClick={() => { setMenuMemberId(null); setConfirmRemoveId(m.id); }} style={{ display: "block", width: "100%", background: "none", border: "none", cursor: "pointer", color: C.red, textAlign: "left", padding: "10px 12px", borderRadius: 8, fontSize: 14, fontFamily: "inherit" }}>
                                Remove from Crew
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </>
          )}

          {/* Pending members */}
          {pending.length > 0 && (
            <>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8, marginTop: 16 }}>PENDING ({pending.length})</div>
              {pending.map((m: TripMember) => (
                <Card key={m.id} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: "50%", background: C.card3, border: `2px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>✉️</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{m.email}</div>
                      <div style={{ color: C.yellow, fontSize: 11 }}>Pending invite</div>
                    </div>
                    {isAdmin && (
                      <button onClick={() => setConfirmRemoveId(m.id)} style={{ background: C.redDim, border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: C.red, fontSize: 12, fontFamily: "inherit" }}>Revoke</button>
                    )}
                  </div>
                </Card>
              ))}
            </>
          )}

          {/* Invite form */}
          {isAdmin && (
            <div style={{ marginTop: 20 }}>
              <SectionLabel icon="users">INVITE VIA EMAIL</SectionLabel>
              <Card>
                <div style={{ display: "flex", gap: 10 }}>
                  <input
                    placeholder="email@example.com"
                    value={inviteEmail}
                    onChange={(e: any) => setInviteEmail(e.target.value)}
                    onKeyDown={(e: any) => e.key === 'Enter' && handleInvite()}
                    style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 15, fontFamily: "inherit" }}
                  />
                  <button onClick={handleInvite} disabled={inviting} style={{ background: C.cyan, color: "#000", border: "none", borderRadius: 10, padding: "8px 16px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
                    {inviting ? "…" : "Invite"}
                  </button>
                </div>
              </Card>
              <Card style={{ marginTop: 10, opacity: 0.5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20 }}>📱</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.textMuted }}>WhatsApp</div>
                    <div style={{ color: C.textSub, fontSize: 12 }}>Coming soon</div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {confirmRemoveId && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px" }}>
                <div style={{ textAlign: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.red, marginBottom: 8 }}>Remove from Crew?</div>
                  <div style={{ color: C.textMuted, fontSize: 13 }}>This will revoke their access to the trip.</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmRemoveId(null)}>Cancel</Btn>
                  <Btn style={{ flex: 1 }} variant="danger" onClick={() => handleRemoveMember(confirmRemoveId)}>Remove</Btn>
                </div>
              </div>
            </div>
          )}

          {/* Leave Group */}
          <div style={{ marginTop: 32, paddingTop: 20, borderTop: `1px solid ${C.border}` }}>
            <button onClick={() => setConfirmLeave(true)} style={{ width: "100%", background: "transparent", border: `1px solid ${C.red}40`, borderRadius: 12, padding: "12px", cursor: "pointer", color: C.red, fontSize: 14, fontWeight: 600, fontFamily: "inherit" }}>
              Leave Group
            </button>
          </div>

          {confirmLeave && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px" }}>
                <div style={{ textAlign: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.red, marginBottom: 8 }}>Leave Group?</div>
                  <div style={{ color: C.textMuted, fontSize: 13 }}>You will lose access to this trip. If you are the only admin, another member will be promoted automatically.</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmLeave(false)}>Cancel</Btn>
                  <Btn style={{ flex: 1 }} variant="danger" onClick={handleLeaveGroup}>Leave</Btn>
                </div>
              </div>
            </div>
          )}
        </>
      ) : crewTab === 'segments' ? (
        <>
          {/* Segments tab */}
          {isAdmin && (
            <button onClick={() => setShowAddSeg(p => !p)} style={{ display: "flex", alignItems: "center", gap: 6, background: C.cyan, color: "#000", border: "none", borderRadius: 12, padding: "10px 16px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, marginBottom: 16 }}>
              <Icon d={icons.plus} size={14} stroke="#000" strokeWidth={2.5} /> Add Segment
            </button>
          )}

          {showAddSeg && (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.cyan}30` }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>New Segment</div>
              <Input placeholder="Segment name" value={segName} onChange={setSegName} style={{ marginBottom: 10 }} />
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>FROM</div>
                  <Input placeholder="Origin" value={segOrigin} onChange={setSegOrigin} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TO</div>
                  <Input placeholder="Destination" value={segDest} onChange={setSegDest} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START</div>
                  <Card style={{ padding: 10 }}>
                    <input type="date" value={segStart} onChange={e => setSegStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
                  </Card>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END</div>
                  <Card style={{ padding: 10 }}>
                    <input type="date" value={segEnd} onChange={e => setSegEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
                  </Card>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>ICON</div>
                {/* Preview */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <SegmentIcon color={segColor} size={18} />
                  </div>
                  <span style={{ color: C.textSub, fontSize: 12 }}>Selected</span>
                </div>
                {/* Tab switcher */}
                <div style={{ background: C.card3, borderRadius: 10, padding: 3, display: "flex", marginBottom: 10 }}>
                  {(['colors', 'flags', 'emojis'] as const).map(t => (
                    <button key={t} onClick={() => setSegIconTab(t)} style={{ flex: 1, padding: "7px", borderRadius: 8, border: "none", cursor: "pointer", background: segIconTab === t ? C.card : "transparent", color: segIconTab === t ? C.text : C.textMuted, fontWeight: segIconTab === t ? 700 : 400, fontSize: 11, fontFamily: "inherit", letterSpacing: 0.8 }}>
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
                {segIconTab === 'colors' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                    {segColors.map(c => (
                      <button key={c} onClick={() => setSegColor(c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: segColor === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {segColor === c && <Icon d={icons.check} size={12} stroke="#fff" strokeWidth={3} />}
                      </button>
                    ))}
                  </div>
                )}
                {segIconTab === 'flags' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, maxHeight: 120, overflowY: "auto" }}>
                    {SEG_FLAGS.map(f => (
                      <button key={f} onClick={() => setSegColor(f)} style={{ width: 36, height: 36, borderRadius: 8, background: segColor === f ? C.card2 : "transparent", border: segColor === f ? `2px solid ${C.cyan}` : "2px solid transparent", cursor: "pointer", fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {f}
                      </button>
                    ))}
                  </div>
                )}
                {segIconTab === 'emojis' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, maxHeight: 120, overflowY: "auto" }}>
                    {SEG_EMOJIS.map(e => (
                      <button key={e} onClick={() => setSegColor(e)} style={{ width: 36, height: 36, borderRadius: 8, background: segColor === e ? C.card2 : "transparent", border: segColor === e ? `2px solid ${C.cyan}` : "2px solid transparent", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {accepted.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>INVITE MEMBERS</div>
                  {accepted.filter(m => m.id !== myMemberId).map((m: TripMember) => (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
                      <input type="checkbox" checked={segAssigned.includes(m.id)} onChange={e => setSegAssigned(prev => e.target.checked ? [...prev, m.id] : prev.filter(id => id !== m.id))} />
                      <Avatar name={m.name || m.email} src={m.avatarUrl} size={28} />
                      <span style={{ fontSize: 13 }}>{m.name || m.email}</span>
                    </label>
                  ))}
                  {accepted.filter(m => m.id !== myMemberId).length === 0 && (
                    <div style={{ color: C.textSub, fontSize: 12, fontStyle: "italic" }}>No other members to invite.</div>
                  )}
                </div>
              )}
              {segError && <div style={{ color: C.red, fontSize: 13, marginBottom: 8 }}>{segError}</div>}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn style={{ flex: 1 }} variant="ghost" onClick={() => { setShowAddSeg(false); setSegError(null); }}>Cancel</Btn>
                <Btn style={{ flex: 1 }} onClick={handleAddSegment}>{segSaving ? "Saving…" : "Create"}</Btn>
              </div>
            </Card>
          )}

          {/* Edit Segment form */}
          {editSegId && (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.yellow}30` }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>Edit Segment</div>
              <Input placeholder="Segment name *" value={editSegName} onChange={setEditSegName} style={{ marginBottom: 10 }} />
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>FROM</div><Input placeholder="Origin" value={editSegOrigin} onChange={setEditSegOrigin} /></div>
                <div style={{ flex: 1 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>TO</div><Input placeholder="Destination" value={editSegDest} onChange={setEditSegDest} /></div>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START</div><Card style={{ padding: 10 }}><input type="date" value={editSegStart} onChange={e => setEditSegStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card></div>
                <div style={{ flex: 1 }}><div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END</div><Card style={{ padding: 10 }}><input type="date" value={editSegEnd} onChange={e => setEditSegEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card></div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>ICON</div>
                <div style={{ background: C.card3, borderRadius: 10, padding: 3, display: "flex", marginBottom: 8 }}>
                  {(['colors', 'flags', 'emojis'] as const).map(t => (
                    <button key={t} onClick={() => setEditSegIconTab(t)} style={{ flex: 1, padding: "6px", borderRadius: 8, border: "none", cursor: "pointer", background: editSegIconTab === t ? C.card : "transparent", color: editSegIconTab === t ? C.text : C.textMuted, fontWeight: editSegIconTab === t ? 700 : 400, fontSize: 11, fontFamily: "inherit" }}>{t.toUpperCase()}</button>
                  ))}
                </div>
                {editSegIconTab === 'colors' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8 }}>
                    {segColors.map(c => <button key={c} onClick={() => setEditSegColor(c)} style={{ width: 26, height: 26, borderRadius: "50%", background: c, border: editSegColor === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{editSegColor === c && <Icon d={icons.check} size={11} stroke="#fff" strokeWidth={3} />}</button>)}
                  </div>
                )}
                {editSegIconTab === 'flags' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, maxHeight: 100, overflowY: "auto" }}>
                    {SEG_FLAGS.map(f => <button key={f} onClick={() => setEditSegColor(f)} style={{ width: 34, height: 34, borderRadius: 8, background: editSegColor === f ? C.card2 : "transparent", border: editSegColor === f ? `2px solid ${C.cyan}` : "2px solid transparent", cursor: "pointer", fontSize: 20 }}>{f}</button>)}
                  </div>
                )}
                {editSegIconTab === 'emojis' && (
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, maxHeight: 100, overflowY: "auto" }}>
                    {SEG_EMOJIS.map(e => <button key={e} onClick={() => setEditSegColor(e)} style={{ width: 34, height: 34, borderRadius: 8, background: editSegColor === e ? C.card2 : "transparent", border: editSegColor === e ? `2px solid ${C.cyan}` : "2px solid transparent", cursor: "pointer", fontSize: 18 }}>{e}</button>)}
                  </div>
                )}
              </div>
              {accepted.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>ASSIGN MEMBERS</div>
                  {accepted.map((m: TripMember) => (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
                      <input type="checkbox" checked={editSegAssigned.includes(m.id)} onChange={e => setEditSegAssigned(prev => e.target.checked ? [...prev, m.id] : prev.filter(id => id !== m.id))} />
                      <Avatar name={m.name || m.email} src={m.avatarUrl} size={28} />
                      <span style={{ fontSize: 13 }}>{m.name || m.email}</span>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setEditSegId(null)}>Cancel</Btn>
                <Btn style={{ flex: 1 }} onClick={handleEditSegment}>{editSegSaving ? "Saving…" : "Save Changes"}</Btn>
              </div>
            </Card>
          )}

          {segments.length === 0 && !showAddSeg && (
            <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>No segments yet. Add one above.</div>
          )}
          {segments.filter(seg => seg.visibility === 'public' || isAdmin || seg.assignedMemberIds.includes(myMemberId) || seg.invitedMemberIds?.includes(myMemberId) || seg.assignedMemberIds.length === 0).map((seg: TripSegment) => {
            const assignedNames = seg.assignedMemberIds.length === 0 ? 'Everyone'
              : seg.assignedMemberIds.map((id: string) => accepted.find((m: TripMember) => m.id === id)?.name || '?').join(', ');
            const invitedNames = seg.invitedMemberIds?.map((id: string) => accepted.find((m: TripMember) => m.id === id)?.name || '?').join(', ');
            const segAtts = segAttachments.filter(a => a.segmentId === seg.id);
            const isExpanded = expandedSegId === seg.id;
            const isInvited = seg.invitedMemberIds?.includes(myMemberId);
            const isAssigned = seg.assignedMemberIds.includes(myMemberId);
            const isOnlyCreator = seg.assignedMemberIds.length === 1 && seg.assignedMemberIds[0] === myMemberId;

            return (
              <Card key={seg.id} style={{ marginBottom: 10, border: isInvited ? `1px solid ${C.yellow}` : 'none' }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ marginTop: 3, flexShrink: 0 }}><SegmentIcon color={seg.color} size={10} /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
                      {seg.name}
                      {seg.visibility === 'private' && <Icon d={icons.lock} size={12} stroke={C.textMuted} />}
                    </div>
                    {(seg.origin || seg.destination) && (
                      <div style={{ color: C.textMuted, fontSize: 12 }}>{seg.origin} {seg.origin && seg.destination ? '→' : ''} {seg.destination}</div>
                    )}
                    {seg.startDate && seg.endDate && (
                      <div style={{ color: C.textSub, fontSize: 12 }}>{formatDateRange(seg.startDate, seg.endDate)}</div>
                    )}
                    <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>
                      <span style={{ color: C.text }}>{assignedNames}</span>
                      {invitedNames && <span style={{ color: C.textMuted }}> (Invited: {invitedNames})</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setExpandedSegId(isExpanded ? null : seg.id)} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "5px 8px", cursor: "pointer", color: C.textMuted, fontSize: 11, fontFamily: "inherit" }}>
                      <Icon d={icons.ticket} size={14} stroke={segAtts.length > 0 ? C.cyan : C.textMuted} /> {segAtts.length > 0 ? segAtts.length : ''}
                    </button>
                    {(isAdmin || isAssigned) && (
                      <button onClick={() => openEditSeg(seg)} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "5px 7px", cursor: "pointer" }}>
                        <Icon d={icons.edit} size={14} stroke={C.textMuted} />
                      </button>
                    )}
                    {(isAdmin || isOnlyCreator) && (
                      <button onClick={() => handleDeleteSegment(seg.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 4 }}>
                        <Icon d={icons.trash} size={16} stroke={C.red} />
                      </button>
                    )}
                  </div>
                </div>

                {isInvited && (
                  <div style={{ marginTop: 12, background: C.card2, borderRadius: 10, padding: "10px 12px", border: `1px solid ${C.yellow}50` }}>
                    <div style={{ color: C.yellow, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>You're invited to this segment</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn onClick={() => handleSegmentMembership(seg.id, 'accept_invite')} style={{ flex: 1, padding: "6px" }} variant="primary">Accept</Btn>
                      <Btn onClick={() => handleSegmentMembership(seg.id, 'decline_invite')} style={{ flex: 1, padding: "6px" }} variant="ghost">Decline</Btn>
                    </div>
                  </div>
                )}

                {isExpanded && !isInvited && (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1 }}>ATTACHMENTS</div>
                      <button onClick={() => { setAddAttSegId(seg.id); setAttName(''); setAttDataUrl(null); }} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer", color: C.cyan, fontSize: 11, fontFamily: "inherit", fontWeight: 700 }}>+ Add</button>
                    </div>
                    {addAttSegId === seg.id && (
                      <div style={{ background: C.card3, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                        <input placeholder="File name (e.g. Boarding Pass)" value={attName} onChange={e => setAttName(e.target.value)} style={{ background: C.card2, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "10px 12px", color: C.text, fontSize: 13, width: "100%", outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, marginBottom: 10 }} />
                        <input type="file" accept="image/*" id={`attInput_${seg.id}`} style={{ display: "none" }} onChange={async e => { const f = e.target.files?.[0]; if (f) setAttDataUrl(await compressImage(f, 1200, 0.8)); }} />
                        {attDataUrl ? (
                          <div style={{ position: "relative", marginBottom: 10 }}>
                            <img src={attDataUrl} style={{ width: "100%", borderRadius: 10, maxHeight: 140, objectFit: "cover" }} />
                            <button onClick={() => setAttDataUrl(null)} style={{ position: "absolute", top: 6, right: 6, background: C.redDim, border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon d={icons.x} size={12} stroke={C.red} /></button>
                          </div>
                        ) : (
                          <label htmlFor={`attInput_${seg.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: `2px dashed ${C.border}`, borderRadius: 10, padding: 12, cursor: "pointer", marginBottom: 10, color: C.textMuted, fontSize: 12 }}>
                            <Icon d={icons.camera} size={16} stroke={C.textMuted} /> Capture or upload
                          </label>
                        )}
                        {attError && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{attError}</div>}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={() => { setAddAttSegId(null); setAttError(null); }} style={{ flex: 1, background: C.card2, border: "none", borderRadius: 10, padding: "8px", color: C.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>Cancel</button>
                          <button onClick={() => {
                            if (!attName.trim()) { setAttError("File name is required."); return; }
                            if (!attDataUrl) { setAttError("Please capture or upload a file."); return; }
                            setAttError(null);
                            const att: SegmentAttachment = { id: crypto.randomUUID(), segmentId: seg.id, tripId: trip.id, name: attName.trim(), fileData: attDataUrl, createdAt: new Date().toISOString() };
                            addSegAttachment(att); setAddAttSegId(null);
                          }} style={{ flex: 1, background: C.cyan, border: "none", borderRadius: 10, padding: "8px", color: "#000", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>Save</button>
                        </div>
                      </div>
                    )}
                    {segAtts.length === 0 && addAttSegId !== seg.id && (
                      <div style={{ color: C.textSub, fontSize: 12, fontStyle: "italic", marginBottom: 12, padding: "10px 0", textAlign: "center" }}>No attachments.</div>
                    )}
                    {segAtts.map(att => (
                      <div key={att.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, background: C.card2, padding: "8px 12px", borderRadius: 10 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: C.card3, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden" }} onClick={() => setViewAtt(att)}>
                          {att.fileData ? <img src={att.fileData} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon d={icons.camera} size={16} stroke={C.textMuted} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setViewAtt(att)}>
                          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{att.name}</div>
                          <div style={{ fontSize: 10, color: C.textSub }}>{new Date(att.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}</div>
                        </div>
                        <button onClick={async e => { e.stopPropagation(); try { const blob = await (await fetch(att.fileData)).blob(); const file = new File([blob], `${att.name}.jpg`, { type: 'image/jpeg' }); if (navigator.share && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: att.name }); } else { const a = document.createElement('a'); a.href = att.fileData; a.download = `${att.name}.jpg`; a.click(); } } catch { } }} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "5px 7px", cursor: "pointer" }}><Icon d={icons.share} size={13} stroke={C.cyan} /></button>
                        <button onClick={e => { e.stopPropagation(); deleteSegAttachment(att.id, seg.id); }} style={{ background: C.redDim, border: "none", borderRadius: 8, padding: "5px 7px", cursor: "pointer" }}><Icon d={icons.trash} size={13} stroke={C.red} /></button>
                      </div>
                    ))}

                    {/* Add LEAVE SEGMENT option */}
                    {isAssigned && !isOnlyCreator && !isAdmin && (
                      <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
                        <button onClick={() => {
                          if (confirm("Are you sure you want to leave this segment?")) {
                            handleSegmentMembership(seg.id, 'leave_segment');
                          }
                        }} style={{ width: "100%", background: "transparent", border: "none", color: C.red, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                          Leave Segment
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
          {/* Fullscreen attachment viewer */}
          {viewAtt && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.95)", zIndex: 400, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div style={{ width: "100%", maxWidth: 400 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{viewAtt.name}</div>
                  <button onClick={() => setViewAtt(null)} style={{ background: C.card3, border: "none", borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><Icon d={icons.x} size={18} stroke={C.text} /></button>
                </div>
                <img src={viewAtt.fileData} style={{ width: "100%", borderRadius: 16, maxHeight: "75vh", objectFit: "contain" }} />
              </div>
            </div>
          )}
        </>
      ) : (
        <>

        </>
      )}
    </div>
  );
};

const LoginScreen = ({ onLogin }: { onLogin: (user: any) => void }) => {
  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const data = await res.json();
        const u = { name: data.name, email: data.email, picture: data.picture, sub: data.sub };
        localStorage.setItem('tripversal_user', JSON.stringify(u));
        // Sync profile to server (fire-and-forget)
        fetch(`/api/users/${data.sub}/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: data.name, email: data.email, avatarUrl: data.picture }),
        }).catch(() => { });
        onLogin(u);
      } catch (e) {
        console.error('Failed to fetch user info', e);
      }
    },
    onError: () => console.error('Google login failed'),
  });

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 430, minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ color: C.cyan, fontSize: 32, fontWeight: 900, letterSpacing: 5, marginBottom: 8 }}>TRIPVERSAL</div>
        <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 60 }}>Your travel companion</div>
        <button
          onClick={() => login()}
          style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", color: "#000", border: "none", borderRadius: 14, padding: "14px 28px", fontSize: 16, fontWeight: 700, cursor: "pointer", width: "100%", justifyContent: "center", fontFamily: "inherit" }}
        >
          <svg width={20} height={20} viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Continue with Google
        </button>
      </div>
    </div>
  );
};

const GroupScreen = ({ trips, activeTripId, user, onBack, onSwitchTrip, onTripUpdate, onTripCreate, onTripDelete }: any) => {
  const [managingTrip, setManagingTrip] = useState<Trip | null>(null);
  const [showNewTrip, setShowNewTrip] = useState(false);
  const [newTripName, setNewTripName] = useState("");
  const [newTripDest, setNewTripDest] = useState("");
  const [newTripStart, setNewTripStart] = useState("");
  const [newTripEnd, setNewTripEnd] = useState("");
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [tripError, setTripError] = useState("");
  const [editingTripId, setEditingTripId] = useState<string | null>(null);
  const [editTripName, setEditTripName] = useState("");
  const [editTripDest, setEditTripDest] = useState("");
  const [editTripStart, setEditTripStart] = useState("");
  const [editTripEnd, setEditTripEnd] = useState("");
  const [savingTrip, setSavingTrip] = useState(false);
  const [confirmDeleteTripId, setConfirmDeleteTripId] = useState<string | null>(null);
  const [deletingTripId, setDeletingTripId] = useState<string | null>(null);

  const handleCreateTrip = async () => {
    setTripError("");
    if (!newTripName.trim()) { setTripError("Trip name is required."); return; }
    if (!newTripStart) { setTripError("Start date is required."); return; }
    if (!newTripEnd) { setTripError("End date is required."); return; }
    if (newTripStart > newTripEnd) { setTripError("End date must be after start date."); return; }
    setCreatingTrip(true);
    try {
      const res = await fetch('/api/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: user?.sub, ownerName: user?.name, ownerAvatarUrl: user?.picture, email: user?.email, name: newTripName.trim(), destination: newTripDest.trim() || undefined, startDate: newTripStart, endDate: newTripEnd, budget: DEFAULT_BUDGET }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to create trip.");
      onTripCreate?.(rowToTrip(await res.json()));
      setNewTripName(""); setNewTripDest(""); setNewTripStart(""); setNewTripEnd("");
      setShowNewTrip(false); setTripError("");
    } catch (e: any) { setTripError(e.message || "Failed to create trip."); }
    finally { setCreatingTrip(false); }
  };

  const handleSaveTrip = async (tripId: string) => {
    setTripError("");
    if (!editTripName.trim() || !editTripStart || !editTripEnd) { setTripError("Name and dates are required."); return; }
    setSavingTrip(true);
    try {
      const res = await fetch(`/api/trips/${tripId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user?.sub, name: editTripName.trim(), destination: editTripDest.trim() || undefined, startDate: editTripStart, endDate: editTripEnd }),
      });
      if (!res.ok) throw new Error("Failed to save trip.");
      onTripUpdate?.(rowToTrip(await res.json()));
      setEditingTripId(null); setTripError("");
    } catch (e: any) { setTripError(e.message || "Failed."); }
    finally { setSavingTrip(false); }
  };

  const handleDeleteTrip = async (tripId: string) => {
    setDeletingTripId(tripId);
    try {
      await fetch(`/api/trips/${tripId}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user?.sub }),
      });
      onTripDelete?.(tripId);
      setConfirmDeleteTripId(null);
    } catch { setTripError("Failed to delete trip."); setConfirmDeleteTripId(null); }
    finally { setDeletingTripId(null); }
  };

  if (managingTrip) {
    return (
      <ManageCrewScreen
        trip={managingTrip}
        user={user}
        onBack={() => setManagingTrip(null)}
        onTripUpdate={(updated: Trip) => { onTripUpdate(updated); setManagingTrip(updated); }}
      />
    );
  }

  return (
    <div style={{ padding: "0 0 100px" }}>
      <div style={{ padding: "16px 20px 12px", display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={onBack} style={{ background: C.card3, border: "none", borderRadius: 12, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>Group</div>
          <div style={{ color: C.textMuted, fontSize: 12, letterSpacing: 1 }}>{(trips as Trip[]).length} TRIP{(trips as Trip[]).length !== 1 ? 'S' : ''}</div>
        </div>
        <button onClick={() => { setShowNewTrip(p => !p); setTripError(""); }} style={{ background: C.cyan, color: "#000", border: "none", borderRadius: 20, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          + New
        </button>
      </div>

      <div style={{ padding: "0 20px" }}>
        {showNewTrip && (
          <Card style={{ marginBottom: 12, border: `1px solid ${C.cyan}30` }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>New Tripversal</div>
            <Input placeholder="Trip Name (e.g. Europe Summer)" value={newTripName} onChange={setNewTripName} style={{ marginBottom: 10 }} />
            <Input placeholder="Destination (optional)" value={newTripDest} onChange={setNewTripDest} style={{ marginBottom: 10 }} />
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START DATE</div>
                <Card style={{ padding: 10 }}><input type="date" value={newTripStart} onChange={e => setNewTripStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END DATE</div>
                <Card style={{ padding: 10 }}><input type="date" value={newTripEnd} onChange={e => setNewTripEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card>
              </div>
            </div>
            {tripError && <div style={{ color: C.red, fontSize: 12, marginBottom: 10, padding: "8px 12px", background: C.redDim, borderRadius: 10 }}>{tripError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn style={{ flex: 1 }} variant="ghost" onClick={() => { setShowNewTrip(false); setTripError(""); }}>Cancel</Btn>
              <Btn style={{ flex: 1 }} onClick={handleCreateTrip}>{creatingTrip ? "Creating…" : "Create"}</Btn>
            </div>
          </Card>
        )}

        {(trips as Trip[]).length === 0 && !showNewTrip && (
          <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", padding: "40px 0", textAlign: "center" }}>No trips yet. Tap "+ New" to create one.</div>
        )}

        {([...(trips as Trip[])].sort((a, b) => (b.id === activeTripId ? 1 : 0) - (a.id === activeTripId ? 1 : 0))).map((trip: Trip) => {
          const isActive = trip.id === activeTripId;
          const accepted = (trip.crew || []).filter((m: TripMember) => m.status === 'accepted').length;
          const segCount = (trip.segments || []).length;
          const isEditing = editingTripId === trip.id;
          return (
            <Card key={trip.id} style={{ marginBottom: 10, border: isActive ? `1.5px solid ${C.cyan}30` : undefined, position: "relative", overflow: "visible" }}>
              {isActive && <div style={{ position: "absolute", top: -1, right: 0, background: C.cyan, color: "#000", fontSize: 11, fontWeight: 800, padding: "3px 12px", borderRadius: "0 14px 0 12px" }}>Active</div>}
              {isEditing ? (
                <>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Edit Trip</div>
                  <Input placeholder="Trip Name" value={editTripName} onChange={setEditTripName} style={{ marginBottom: 10 }} />
                  <Input placeholder="Destination (optional)" value={editTripDest} onChange={setEditTripDest} style={{ marginBottom: 10 }} />
                  <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START</div>
                      <Card style={{ padding: 10 }}><input type="date" value={editTripStart} onChange={e => setEditTripStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END</div>
                      <Card style={{ padding: 10 }}><input type="date" value={editTripEnd} onChange={e => setEditTripEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark" as const, width: "100%" }} /></Card>
                    </div>
                  </div>
                  {tripError && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{tripError}</div>}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn style={{ flex: 1 }} variant="ghost" onClick={() => { setEditingTripId(null); setTripError(""); }}>Cancel</Btn>
                    <Btn style={{ flex: 1 }} onClick={() => handleSaveTrip(trip.id)}>{savingTrip ? "Saving…" : "Save"}</Btn>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, paddingRight: isActive ? 60 : 0 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>{trip.name}</div>
                      {trip.destination && <div style={{ color: C.textMuted, fontSize: 12 }}>{trip.destination}</div>}
                      <div style={{ color: C.textSub, fontSize: 11, marginTop: 2 }}>{formatDateRange(trip.startDate, trip.endDate)}</div>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <span style={{ background: C.card3, color: C.textMuted, borderRadius: 8, padding: "3px 8px", fontSize: 11, fontWeight: 600 }}>{accepted} member{accepted !== 1 ? 's' : ''}</span>
                        <span style={{ background: C.card3, color: C.textMuted, borderRadius: 8, padding: "3px 8px", fontSize: 11, fontWeight: 600 }}>{segCount} segment{segCount !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button onClick={() => { setEditingTripId(trip.id); setEditTripName(trip.name); setEditTripDest(trip.destination || ""); setEditTripStart(trip.startDate); setEditTripEnd(trip.endDate); setTripError(""); }} style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}>
                        <Icon d={icons.edit} size={15} stroke={C.textMuted} />
                      </button>
                      <button onClick={() => setConfirmDeleteTripId(trip.id)} style={{ background: C.redDim, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}>
                        <Icon d={icons.trash} size={15} stroke={C.red} />
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    {!isActive && <Btn variant="ghost" style={{ flex: 1, padding: "10px" }} onClick={() => onSwitchTrip(trip.id)}>Set Active</Btn>}
                    <Btn variant="secondary" style={{ flex: 1, padding: "10px" }} onClick={() => setManagingTrip(trip)} icon={<Icon d={icons.users} size={15} />}>Manage</Btn>
                  </div>
                </>
              )}
            </Card>
          );
        })}

        {confirmDeleteTripId && (() => {
          const t = (trips as Trip[]).find(tr => tr.id === confirmDeleteTripId);
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div style={{ width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0", padding: "28px 20px 44px" }}>
                <div style={{ textAlign: "center", marginBottom: 24 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 6 }}>Delete "{t?.name}"?</div>
                  <div style={{ color: C.textMuted, fontSize: 13 }}>This will permanently delete the trip and all its data. This cannot be undone.</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmDeleteTripId(null)}>Cancel</Btn>
                  <Btn style={{ flex: 1 }} variant="danger" onClick={() => handleDeleteTrip(confirmDeleteTripId)}>{deletingTripId === confirmDeleteTripId ? "Deleting…" : "Delete Trip"}</Btn>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
};

function AppShell() {
  const [user, setUser] = useState<any>(null);
  const [tab, setTab] = useState("home");
  const [showSettings, setShowSettings] = useState(false);
  const [showManageCrew, setShowManageCrew] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [activeTripId, setActiveTripId] = useState<string | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  // Lifted from SettingsScreen so it actually affects the real isOnline indicator
  const [offlineSim, setOfflineSim] = useState(false);

  const activeTrip = trips.find(t => t.id === activeTripId) ?? null;

  // Re-fetch trips and expenses from Supabase when connectivity is restored
  const handleReconnect = useCallback(async () => {
    if (!user) return;
    const rows = await fetch(`/api/trips?userId=${user.sub}`)
      .then(r => r.ok ? r.json() : [])
      .catch(() => []);
    if (rows.length > 0) setTrips(rows.map(rowToTrip));
    if (!activeTripId) return;
    const expRows = await fetch(`/api/trips/${activeTripId}/expenses?callerSub=${user.sub}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    if (expRows) {
      const stored: Expense[] = (() => { try { const s = localStorage.getItem('tripversal_expenses'); return s ? JSON.parse(s) : []; } catch { return []; } })();
      const merged = mergeServerExpenses(stored, expRows.map(rowToExpense), activeTripId);
      localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
    }
  }, [user, activeTripId]);

  const { isOnline, isSyncing } = useNetworkSync({ onReconnect: handleReconnect, debounceMs: 1500 });

  // offlineSim overlays the real network state (Dev Controls toggle)
  const effectiveIsOnline = isOnline && !offlineSim;

  const switchActiveTrip = (id: string) => {
    setActiveTripId(id);
    localStorage.setItem('tripversal_active_trip_id', id);
    const t = trips.find(tr => tr.id === id);
    if (t?.budget) localStorage.setItem('tripversal_budget', JSON.stringify(t.budget));
  };

  // Restore user from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('tripversal_user');
    if (stored) {
      try { setUser(JSON.parse(stored)); } catch { }
    }
  }, []);

  // On user login: check invite URL param, fetch trips, restore active trip
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (invite) setPendingInviteToken(invite);

    fetch(`/api/trips?userId=${user.sub}`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => {
        const loaded = rows.map(rowToTrip);
        setTrips(loaded);
        const storedId = localStorage.getItem('tripversal_active_trip_id');
        const initial = loaded.find(t => t.id === storedId) ?? loaded[0];
        if (initial) {
          setActiveTripId(initial.id);
          localStorage.setItem('tripversal_budget', JSON.stringify(initial.budget));
        }
      })
      .catch(() => { });
  }, [user]);

  // Sync activeTrip budget to localStorage whenever active trip changes
  useEffect(() => {
    if (activeTrip?.budget) localStorage.setItem('tripversal_budget', JSON.stringify(activeTrip.budget));
  }, [activeTripId]);

  const handleLogout = () => {
    localStorage.removeItem('tripversal_user');
    localStorage.removeItem('tripversal_profile');
    localStorage.removeItem('tripversal_budget');
    localStorage.removeItem('tripversal_expenses');
    localStorage.removeItem('tripversal_active_trip_id');
    setUser(null); setTrips([]); setActiveTripId(null);
  };

  if (!user) return <LoginScreen onLogin={setUser} />;

  const handleNav = (t: string) => {
    setShowSettings(false); setShowManageCrew(false); setShowGroup(false); setShowAddExpense(false); setShowHistory(false); setTab(t);
  };

  let content;
  if (pendingInviteToken) {
    content = (
      <InviteAcceptScreen
        token={pendingInviteToken}
        user={user}
        onDone={(trip: Trip) => {
          setTrips(p => [...p, trip]);
          switchActiveTrip(trip.id);
          setPendingInviteToken(null);
          window.history.replaceState({}, '', '/');
        }}
        onDecline={() => {
          setPendingInviteToken(null);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  } else if (showGroup) {
    content = (
      <GroupScreen
        trips={trips}
        activeTripId={activeTripId}
        user={user}
        onBack={() => setShowGroup(false)}
        onSwitchTrip={(id: string) => { switchActiveTrip(id); }}
        onTripUpdate={(updated: Trip) => setTrips(p => p.map(t => t.id === updated.id ? updated : t))}
        onTripCreate={(trip: Trip) => { setTrips(p => [...p, trip]); switchActiveTrip(trip.id); }}
        onTripDelete={(id: string) => {
          setTrips(p => p.filter(t => t.id !== id));
          if (activeTripId === id) {
            const remaining = trips.filter(t => t.id !== id);
            if (remaining.length > 0) switchActiveTrip(remaining[0].id);
            else { setActiveTripId(null); localStorage.removeItem('tripversal_active_trip_id'); }
          }
        }}
      />
    );
  } else if (showAddExpense) {
    content = <AddExpenseScreen onBack={() => setShowAddExpense(false)} activeTripId={activeTripId} user={user} />;
  } else if (showHistory) {
    content = <TransactionHistoryScreen onBack={() => setShowHistory(false)} />;
  } else if (showManageCrew) {
    content = (
      <ManageCrewScreen
        trip={activeTrip}
        user={user}
        onBack={() => setShowManageCrew(false)}
        onTripUpdate={(updated: Trip) => setTrips(p => p.map(t => t.id === updated.id ? updated : t))}
      />
    );
  } else if (showSettings) {
    content = (
      <SettingsScreen
        user={user}
        onLogout={handleLogout}
        onHistory={() => setShowHistory(true)}
        onManageCrew={() => { setShowSettings(false); setShowManageCrew(true); }}
        trips={trips}
        activeTripId={activeTripId}
        onSwitchTrip={(id: string) => { switchActiveTrip(id); setShowSettings(false); }}
        onTripCreate={(trip: Trip) => { setTrips(p => [...p, trip]); switchActiveTrip(trip.id); }}
        onTripUpdate={(updated: Trip) => setTrips(p => p.map(t => t.id === updated.id ? updated : t))}
        onTripDelete={(id: string) => {
          setTrips(p => p.filter(t => t.id !== id));
          if (activeTripId === id) {
            const remaining = trips.filter(t => t.id !== id);
            if (remaining.length > 0) switchActiveTrip(remaining[0].id);
            else { setActiveTripId(null); localStorage.removeItem('tripversal_active_trip_id'); }
          }
        }}
        offlineSim={offlineSim}
        setOfflineSim={setOfflineSim}
        isSyncing={isSyncing}
      />
    );
  } else {
    switch (tab) {
      case "home": content = <HomeScreen onNav={handleNav} onAddExpense={() => setShowAddExpense(true)} onShowGroup={() => setShowGroup(true)} activeTripId={activeTripId} activeTrip={activeTrip} user={user} />; break;
      case "itinerary": content = <ItineraryScreen activeTripId={activeTripId} activeTrip={activeTrip} userSub={user?.sub} />; break;
      case "wallet": content = <WalletScreen onAddExpense={() => setShowAddExpense(true)} activeTripId={activeTripId} user={user} trips={trips} />; break;
      case "photos": content = <PhotosScreen />; break;
      case "sos": content = <SOSScreen user={user} />; break;
      default: content = null;
    }
  }

  const activeTab = showSettings || showManageCrew || showGroup || showAddExpense || showHistory || pendingInviteToken ? null : tab;

  return (
    <div style={{ background: "#000", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <GlobalStyles />
      <div style={{ width: "100%", maxWidth: 430, minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", position: "relative", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
        <Header onSettings={() => { setShowSettings(true); setShowManageCrew(false); setShowAddExpense(false); }} user={user} isOnline={effectiveIsOnline} isSyncing={isSyncing} />
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {content}
        </div>
        <BottomNav active={activeTab} onNav={handleNav} />
      </div>
    </div>
  );
}

export default function TripversalApp() {
  return (
    <GoogleOAuthProvider clientId="389526326520-u55cak6f7dg9ckondrn97slfqj86f2j9.apps.googleusercontent.com">
      <AppShell />
    </GoogleOAuthProvider>
  );
}
