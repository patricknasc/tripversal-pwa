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

interface TripSegment {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  origin?: string;
  destination?: string;
  color: string;
  assignedMemberIds: string[];
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
}

interface ConflictSegment {
  id: string; trip_id: string; trip_name: string;
  name: string; start_date: string; end_date: string;
}
interface SegmentConflict { a: ConflictSegment; b: ConflictSegment; }

interface InviteEvent {
  id: string;
  type: "invited" | "accepted";
  email: string;
  name?: string;
  tripName: string;
  at: string;
}

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
  EUR: "€", USD: "$", BRL: "R$", GBP: "£", COP: "$",
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
      assignedMemberIds: s.assigned_member_ids || [],
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
    // receiptDataUrl intentionally excluded
  };
}

function mergeServerExpenses(stored: Expense[], server: Expense[], tripId: string): Expense[] {
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
  } catch {}
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

const HomeScreen = ({ onNav, onAddExpense, activeTripId, user }: any) => {
  const [budget, setBudget] = useState<TripBudget>(DEFAULT_BUDGET);
  const [todaySpent, setTodaySpent] = useState(0);
  const [yesterdaySpent, setYesterdaySpent] = useState(0);
  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [inviteEvents, setInviteEvents] = useState<InviteEvent[]>([]);
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
    } catch {}
    // Background hydration from server
    if (activeTripId && user?.sub) {
      fetch(`/api/trips/${activeTripId}/expenses?callerSub=${user.sub}`)
        .then(r => r.ok ? r.json() : null)
        .then((rows: any[] | null) => {
          if (!rows) return;
          const stored: Expense[] = (() => { try { const s = localStorage.getItem('tripversal_expenses'); return s ? JSON.parse(s) : []; } catch { return []; } })();
          const merged = mergeServerExpenses(stored, rows.map(rowToExpense), activeTripId);
          localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
          const forTrip = merged.filter(e => e.tripId === activeTripId);
          const todayKey = localDateKey(new Date());
          const yest = new Date(); yest.setDate(yest.getDate() - 1);
          const yesterdayKey = localDateKey(yest);
          setTodaySpent(forTrip.filter(e => localDateKey(new Date(e.date)) === todayKey).reduce((s, e) => s + e.baseAmount, 0));
          setYesterdaySpent(forTrip.filter(e => localDateKey(new Date(e.date)) === yesterdayKey).reduce((s, e) => s + e.baseAmount, 0));
          setAllExpenses(forTrip);
        })
        .catch(() => {});
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
      } catch {}
    }
    saveHomeExpenses(allExpenses.filter(e => e.id !== id));
    setSelectedActivityExp(null); setHomeConfirmDelete(false);
    // Background soft-delete on server
    if (exp?.tripId && user?.sub) {
      fetch(`/api/trips/${exp.tripId}/expenses/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      }).catch(() => {});
    }
  };
  const handleHomeEdit = (id: string) => {
    const next = allExpenses.map(e => {
      if (e.id !== id) return e;
      const snap = { description: e.description, localAmount: e.localAmount, category: e.category, date: e.date, sourceId: e.sourceId, localCurrency: e.localCurrency };
      return { ...e, description: homeEditDesc, localAmount: parseFloat(homeEditAmount) || e.localAmount,
        category: homeEditCat, date: homeEditDate ? new Date(`${homeEditDate}T12:00:00`).toISOString() : e.date,
        sourceId: homeEditSourceId || e.sourceId, localCurrency: homeEditCurrency, city: homeEditCity || e.city,
        editHistory: [...(e.editHistory || []), { at: new Date().toISOString(), snapshot: snap }] };
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
      }).catch(() => {});
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
      <div style={{ margin: "16px 20px 0", background: "linear-gradient(135deg, #0d2526 0%, #0a1a1a 100%)", borderRadius: 20, padding: 20, border: `1px solid ${C.cyan}20` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ background: "#003d4520", border: `1px solid ${C.cyan}40`, borderRadius: 20, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6, color: C.cyan, fontSize: 12, fontWeight: 700 }}>
            <Icon d={icons.clock} size={12} stroke={C.cyan} /> IN 45M
          </div>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#ffffff15", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon d={icons.plane} size={20} stroke={C.text} />
          </div>
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 4 }}>Flight to Rome</div>
        <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 18 }}>Boarding in 45m</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn style={{ flex: 1, borderRadius: 12 }} variant="white" icon={<Icon d={icons.fileText} size={16} />}>Tickets</Btn>
          <Btn style={{ flex: 1, borderRadius: 12 }} variant="secondary" icon={<Icon d={icons.navigation} size={16} />}>Directions</Btn>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, margin: "16px 20px 0" }}>
        {[
          { label: "EXPENSE", icon: icons.plus, action: onAddExpense },
          { label: "PHOTO", icon: icons.camera, action: () => onNav("photos") },
          { label: "GROUP", icon: icons.users, action: () => onNav("settings") },
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
          ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

          if (activityItems.length === 0) return (
            <Card>
              <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "8px 0" }}>No expenses yet. Tap + to add one.</div>
            </Card>
          );

          return activityItems.slice(0, visibleCount).map(item => {
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
            <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
              width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0",
              padding: "20px 20px 40px", zIndex: 201, maxHeight: "80vh", overflowY: "auto" }}>
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

  // Tick every 60 s to update NOW marker
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch cross-trip conflicts for this user
  useEffect(() => {
    if (!userSub) return;
    fetch(`/api/users/${encodeURIComponent(userSub)}/segment-conflicts`)
      .then(r => r.ok ? r.json() : { conflicts: [] })
      .then(d => setConflicts(d.conflicts ?? []))
      .catch(() => {});
  }, [userSub]);

  // When active trip changes, snap selected day to today (if within trip) or trip start
  useEffect(() => {
    if (!activeTrip) { setSelectedDay(localDateKey(new Date())); return; }
    const today = localDateKey(new Date());
    if (today >= activeTrip.startDate && today <= activeTrip.endDate) setSelectedDay(today);
    else setSelectedDay(activeTrip.startDate);
  }, [activeTripId]);

  const dateRange = activeTrip ? getDatesRange(activeTrip.startDate, activeTrip.endDate) : [todayKey];
  const events: ItineraryEvent[] = activeTrip ? segmentsToEvents(activeTrip.segments) : [];

  const dayEvents = events.filter(e => e.date === selectedDay);

  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // The "NOW" event is the last one that started on today before current time
  const nowEventId: string | null = selectedDay === todayKey
    ? (dayEvents.filter(e => e.time <= nowTime).at(-1)?.id ?? null)
    : null;

  const getStatus = (e: ItineraryEvent): "done" | "now" | "upcoming" => {
    if (e.id === nowEventId) return "now";
    if (e.date < todayKey || (e.date === todayKey && e.time < nowTime)) return "done";
    return "upcoming";
  };

  const daySelectorRef = useRef<HTMLDivElement>(null);

  // Scroll selected day chip into view when it changes
  useEffect(() => {
    const el = daySelectorRef.current?.querySelector<HTMLElement>("[data-selected=true]");
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedDay]);

  // Conflicts that touch the selected day
  const dayConflicts = conflicts.filter(c =>
    (c.a.start_date <= selectedDay && c.a.end_date >= selectedDay) ||
    (c.b.start_date <= selectedDay && c.b.end_date >= selectedDay)
  );

  // Segment IDs from THIS trip that are in a conflict
  const conflictingSegIds = new Set(
    conflicts.flatMap(c => [c.a, c.b])
      .filter(s => s.trip_id === activeTripId)
      .map(s => s.id)
  );

  // The OTHER trips' names that conflict on the selected day
  const conflictingTripNames = Array.from(new Set(
    dayConflicts.flatMap(c => [c.a, c.b])
      .filter(s => s.trip_id !== activeTripId)
      .map(s => s.trip_name)
  ));

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
          <a href={`/api/trips/${activeTripId}/ics`} download
            style={{ color: C.cyan, fontSize: 12, display: "flex", alignItems: "center", gap: 4, textDecoration: "none", marginTop: 4, flexShrink: 0 }}>
            <Icon d={icons.calendar} size={13} stroke={C.cyan} /> Export full trip
          </a>
        )}
      </div>

      {/* Day selector */}
      <div ref={daySelectorRef} style={{ overflowX: "auto" }} className="no-scrollbar">
        <div style={{ display: "flex", gap: 8, padding: "0 20px 16px", width: "max-content" }}>
          {dateRange.map(day => {
            const isSel = day === selectedDay;
            const isToday = day === todayKey;
            const d = new Date(day + "T12:00:00");
            return (
              <div key={day} data-selected={isSel} onClick={() => setSelectedDay(day)}
                style={{ padding: "8px 14px", borderRadius: 12, cursor: "pointer", flexShrink: 0,
                  background: isSel ? C.cyan : C.card,
                  color: isSel ? "#000" : isToday ? C.cyan : C.text,
                  border: `1px solid ${isSel ? C.cyan : isToday ? C.cyan + "40" : C.border}`,
                  fontSize: 13, fontWeight: isSel ? 700 : 400,
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                }}>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{d.toLocaleDateString("en", { weekday: "short" })}</span>
                <span>{d.getDate()}</span>
              </div>
            );
          })}
        </div>
      </div>

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
        {dayEvents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: C.textMuted }}>
            <Icon d={icons.calendar} size={32} stroke={C.textMuted} />
            <div style={{ marginTop: 12, fontSize: 14 }}>
              {events.length === 0 ? "Add trip segments in Settings to see your itinerary" : "No events scheduled for this day"}
            </div>
          </div>
        ) : (
          <>
            <div style={{ position: "absolute", left: 39, top: 0, bottom: 0, width: 2, background: `linear-gradient(to bottom, ${C.cyan}40, ${C.cyan}10)` }} />
            {dayEvents.map(event => {
              const status = getStatus(event);
              const isNow = status === "now";
              const isDone = status === "done";
              const isConflict = !!event.segmentId && conflictingSegIds.has(event.segmentId);
              const catIcon = CATEGORY_ICONS[event.category] ?? icons.tag;
              const hasMap = event.location && (event.location.address || (event.location.lat != null));
              const hasDocs = event.docUrls && event.docUrls.length > 0;
              return (
                <div key={event.id} style={{ display: "flex", gap: 16, marginBottom: 16, position: "relative" }}>
                  <div style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0, zIndex: 1,
                    background: isNow ? C.cyan : isDone ? "#1a2a1a" : C.card3,
                    border: `2px solid ${isNow ? C.cyan : isDone ? C.green : isConflict ? C.yellow : C.border}`,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon d={catIcon} size={16} stroke={isNow ? "#000" : isDone ? C.green : isConflict ? C.yellow : C.textMuted} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ background: isNow ? `${C.cyan}15` : C.card, borderRadius: 14, padding: 14,
                      border: isNow ? `1px solid ${C.cyan}30` : isConflict ? `1px solid ${C.yellow}40` : "none" }}>
                      {isNow && <div style={{ color: C.cyan, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>● NOW</div>}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15, color: isDone ? C.textMuted : C.text }}>{event.title}</div>
                          {event.subtitle && <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{event.subtitle}</div>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: 8 }}>
                          {isConflict && <span style={{ fontSize: 12 }} title="Scheduling conflict">⚠️</span>}
                          <span style={{ color: C.textSub, fontSize: 12 }}>{event.time}</span>
                        </div>
                      </div>
                      {!isDone && (hasMap || hasDocs) && (
                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                          {hasDocs && (
                            <a href={event.docUrls![0]} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                              <div style={{ background: C.card3, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: C.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                                <Icon d={icons.fileText} size={12} /> Docs
                              </div>
                            </a>
                          )}
                          {hasMap && (
                            <div onClick={() => openMapLink(event.location?.address, event.location?.lat, event.location?.lng)}
                              style={{ background: C.card3, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: C.textMuted, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                              <Icon d={icons.navigation} size={12} /> Map
                            </div>
                          )}
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
    </div>
  );
};

const WalletScreen = ({ onAddExpense, activeTripId, user }: any) => {
  const [budget, setBudgetState] = useState<TripBudget>(DEFAULT_BUDGET);
  const [expenses, setExpenses] = useState<Expense[]>([]);
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
  const txSentinelRef = useRef<HTMLDivElement>(null);

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
    } catch {}
    // Background hydration from server
    if (activeTripId && user?.sub) {
      fetch(`/api/trips/${activeTripId}/expenses?callerSub=${user.sub}`)
        .then(r => r.ok ? r.json() : null)
        .then((rows: any[] | null) => {
          if (!rows) return;
          const stored: Expense[] = (() => { try { const s = localStorage.getItem('tripversal_expenses'); return s ? JSON.parse(s) : []; } catch { return []; } })();
          const merged = mergeServerExpenses(stored, rows.map(rowToExpense), activeTripId);
          localStorage.setItem('tripversal_expenses', JSON.stringify(merged));
          setExpenses(merged.filter(e => e.tripId === activeTripId));
        })
        .catch(() => {});
    }
  }, [activeTripId]);

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
      } catch {}
    }
    saveExpenses(expenses.filter(e => e.id !== id));
    setSelectedExpenseId(null); setConfirmDelete(false);
    // Background soft-delete on server
    if (exp?.tripId && user?.sub) {
      fetch(`/api/trips/${exp.tripId}/expenses/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub }),
      }).catch(() => {});
    }
  };
  const handleEdit = (id: string) => {
    const next = expenses.map(e => {
      if (e.id !== id) return e;
      const snap = { description: e.description, localAmount: e.localAmount,
        category: e.category, date: e.date, sourceId: e.sourceId, localCurrency: e.localCurrency };
      return { ...e, description: editDesc, localAmount: parseFloat(editAmount) || e.localAmount,
        category: editCat, date: editDate ? new Date(`${editDate}T12:00:00`).toISOString() : e.date,
        sourceId: editSourceId || e.sourceId, localCurrency: editCurrency, city: editCity || e.city,
        editHistory: [...(e.editHistory || []), { at: new Date().toISOString(), snapshot: snap }] };
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
      }).catch(() => {});
    }
  };

  const { totalBudgetInBase, totalSpent, remaining } = calcSummary(budget, expenses);

  // Build 7-day trend
  const today = new Date();
  const dayData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (6 - i));
    const key = localDateKey(d);
    const label = i === 6 ? "TODAY" : d.toLocaleDateString("en", { weekday: "short" }).toUpperCase().slice(0, 3);
    const total = expenses.filter(e => localDateKey(new Date(e.date)) === key).reduce((s, e) => s + e.baseAmount, 0);
    return { label, total, isToday: i === 6 };
  });
  const maxDay = Math.max(...dayData.map(d => d.total), 1);

  // Source lookup
  const sourceMap = Object.fromEntries(budget.sources.map(s => [s.id, s]));

  return (
    <div style={{ padding: "0 20px 100px" }}>
      <div style={{ paddingTop: 16, marginBottom: 4 }}>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: -1 }}>{currSym(budget.baseCurrency)}{fmtAmt(totalSpent)}</div>
        <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, fontWeight: 600 }}>TOTAL TRIP SPEND</div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.textMuted }}>{currSym(budget.baseCurrency)}{fmtAmt(remaining)}</div>
          <div style={{ color: C.textSub, fontSize: 11, letterSpacing: 1 }}>REMAINING</div>
        </div>
      </div>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Spending Trend</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>7 DAYS</div>
          </div>
          <div style={{ background: "#1a2a1a", borderRadius: 20, padding: "4px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.green }} />
            <span style={{ color: C.green }}>LIVE</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100 }}>
          {dayData.map(d => (
            <div key={d.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div style={{ width: "100%", height: `${Math.max((d.total / maxDay) * 100, d.total > 0 ? 4 : 0)}%`, background: d.isToday ? C.cyan : C.card3, borderRadius: "6px 6px 0 0", minHeight: d.total > 0 ? 4 : 0 }} />
              <div style={{ fontSize: 9, color: d.isToday ? C.cyan : C.textSub, fontWeight: d.isToday ? 700 : 400 }}>{d.label}</div>
            </div>
          ))}
        </div>
      </Card>
      <SectionLabel>TRANSACTIONS</SectionLabel>
      {expenses.length === 0 && (
        <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>No expenses yet. Tap + to add one.</div>
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
            <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
              width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0",
              padding: "20px 20px 40px", zIndex: 201, maxHeight: "80vh", overflowY: "auto" }}>
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
    try { const s = localStorage.getItem('tripversal_budget'); if (s) return JSON.parse(s); } catch {}
    return DEFAULT_BUDGET;
  });
  const [localCurrency, setLocalCurrency] = useState<Currency>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) { const b = JSON.parse(s); if (b.sources?.[0]?.currency) return b.sources[0].currency; } } catch {}
    return "EUR" as Currency;
  });
  const [selectedSourceId, setSelectedSourceId] = useState<string>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) { const b = JSON.parse(s); if (b.sources?.[0]?.id) return b.sources[0].id; } } catch {}
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
    } catch {}
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(async ({ coords: { latitude, longitude } }) => {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, { headers: { "Accept-Language": "en" } });
          const data = await res.json();
          const addr = data.address || {};
          const name = addr.city || addr.town || addr.village || addr.county || "";
          if (name) setCity(name);
        } catch {}
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
          {["1","2","3","4","5","6","7","8","9",".","0","⌫"].map(k => (
            <button key={k} onClick={() => handleKey(k)} style={{ background: C.card3, border: "none", borderRadius: 10, padding: "14px", fontSize: 18, fontWeight: 600, color: C.text, cursor: "pointer", fontFamily: "inherit" }}>{k}</button>
          ))}
        </div>
      </div>
      <div style={{ paddingTop: 20 }}>
        <SectionLabel>MOEDA LOCAL</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {(["EUR","USD","BRL","GBP","COP"] as Currency[]).map(c => {
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
            style={{ background: "transparent", border: "none", color: C.text, fontSize: 15,
              flex: 1, outline: "none", fontFamily: "inherit", colorScheme: "dark" }} />
          <input type="time" value={expTime} onChange={e => setExpTime(e.target.value)}
            style={{ background: "transparent", border: "none", color: C.textMuted, fontSize: 14,
              outline: "none", fontFamily: "inherit", colorScheme: "dark", width: 80 }} />
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
            <button onClick={() => setReceiptDataUrl(null)} style={{ position: "absolute", top: 8, right: 8,
              background: C.redDim, border: "none", borderRadius: "50%", width: 28, height: 28,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon d={icons.x} size={14} stroke={C.red} />
            </button>
          </div>
        ) : (
          <label htmlFor="receiptInput" style={{ border: `2px dashed ${C.border}`, borderRadius: 14, padding: 20,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer" }}>
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
        } catch {}
        const expense: Expense = {
          id: Date.now().toString(),
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
        } catch {}
        setSaving(false);
        onBack();
        // Background write to server (fire-and-forget)
        if (activeTripId && user?.sub) {
          fetch(`/api/trips/${activeTripId}/expenses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callerSub: user.sub, ...expenseToRow(expense) }),
          }).catch(() => {});
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

const SOSScreen = () => (
  <div style={{ padding: "16px 20px 100px", overflowY: "auto" }}>
    <Card style={{ marginBottom: 16, border: `1px solid #ff3b3020` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon d={icons.heart} size={18} stroke={C.red} fill={`${C.red}30`} />
          <span style={{ fontWeight: 700, fontSize: 16 }}>My Medical ID</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle value={true} onChange={() => {}} />
          <span style={{ color: C.cyan, fontSize: 11, fontWeight: 700 }}>SHARING</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>BLOOD TYPE</div>
          <div style={{ fontWeight: 800, fontSize: 22 }}>O+</div>
        </div>
        <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>EMERGENCY CONTACT</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Mom</div>
        </div>
      </div>
      <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
        <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>MEDICAL NOTES</div>
        <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic" }}>No critical notes added.</div>
      </div>
    </Card>
    <SectionLabel>TRAVEL INSURANCE</SectionLabel>
    <Card style={{ marginBottom: 16 }}>
      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>PROVIDER</div>
      <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 16 }}>Allianz</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>POLICY NUMBER</div>
          <Badge color={C.textMuted} bg={C.card3}>AZ-9920</Badge>
        </div>
        <div>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>EMERGENCY PHONE</div>
          <div style={{ fontWeight: 700 }}>+331</div>
        </div>
      </div>
      <Btn style={{ width: "100%", background: C.cyan, color: "#000" }} icon={<Icon d={icons.phone} size={16} stroke="#000" />}>CALL GLOBAL ASSIST</Btn>
    </Card>
    <SectionLabel icon="fileText" action={<button style={{ width: 32, height: 32, borderRadius: 10, background: C.card3, border: "none", cursor: "pointer", color: C.text, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon d={icons.plus} size={16} /></button>}>CRITICAL DOCUMENTS</SectionLabel>
    <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 40, gap: 12 }}>
      <div style={{ width: 60, height: 60, borderRadius: "50%", background: C.card3, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon d={icons.fileText} size={28} stroke={C.textMuted} />
      </div>
      <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center" }}>Store copies of passports, visas, and insurance cards for offline access.</div>
    </Card>
  </div>
);

const SettingsScreen = ({ onManageCrew, user, onLogout, onHistory, trips = [], activeTripId, onSwitchTrip, onTripCreate, onTripUpdate, onTripDelete, offlineSim = false, setOfflineSim, isSyncing = false }: any) => {
  const [forcePending, setForcePending] = useState(false);
  const [showNewTrip, setShowNewTrip] = useState(false);
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
      } catch {}
    } else {
      setUsername(user?.name || "");
      setEmail(user?.email || "");
      setAvatarUrl(user?.picture || null);
    }
  }, []);
  // Budget states (lazy initializers)
  const [budget, setBudget] = useState<TripBudget>(() => {
    try { const s = localStorage.getItem('tripversal_budget'); if (s) return JSON.parse(s); } catch {}
    return DEFAULT_BUDGET;
  });
  const [expenses] = useState<Expense[]>(() => {
    try { const s = localStorage.getItem('tripversal_expenses'); if (s) return JSON.parse(s); } catch {}
    return [];
  });
  const saveBudget = (next: TripBudget) => {
    setBudget(next);
    localStorage.setItem('tripversal_budget', JSON.stringify(next));
    // Background write-back to trips.budget in Supabase
    if (activeTripId && user?.sub) {
      fetch(`/api/trips/${activeTripId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, budget: next }),
      }).catch(() => {});
    }
  };

  // Add source form states
  const [showAddSource, setShowAddSource] = useState(false);
  const [srcName, setSrcName] = useState("");
  const [srcType, setSrcType] = useState<SourceType>("balance");
  const [srcCurrency, setSrcCurrency] = useState<Currency>("EUR");
  const [srcAmount, setSrcAmount] = useState("");
  const [srcColor, setSrcColor] = useState("#00e5ff");
  const [srcSaving, setSrcSaving] = useState(false);

  const srcColors = ["#00e5ff","#30d158","#ffd60a","#ff3b30","#f57c00","#6a1b9a","#1565c0","#e91e8c"];

  const addSource = async () => {
    if (!srcName.trim() || !srcAmount) return;
    setSrcSaving(true);
    let limitInBase = parseFloat(srcAmount);
    try {
      if (srcCurrency !== budget.baseCurrency) {
        const rate = await fetchRate(srcCurrency, budget.baseCurrency);
        limitInBase = parseFloat(srcAmount) * rate;
      }
    } catch {}
    const src: PaymentSource = {
      id: Date.now().toString(),
      name: srcName.trim(),
      type: srcType,
      currency: srcCurrency,
      limit: parseFloat(srcAmount),
      limitInBase,
      color: srcColor,
    };
    const next = { ...budget, sources: [...budget.sources, src] };
    saveBudget(next);
    setSrcName(""); setSrcType("balance"); setSrcCurrency("EUR"); setSrcAmount(""); setSrcColor("#00e5ff");
    setShowAddSource(false); setSrcSaving(false);
  };

  const removeSource = (id: string) => saveBudget({ ...budget, sources: budget.sources.filter(s => s.id !== id) });

  // New trip form states
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
    if (newTripStart > newTripEnd) { setTripError("End date must be on or after start date."); return; }
    setCreatingTrip(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: user?.sub, ownerName: user?.name, ownerAvatarUrl: user?.picture, email: user?.email, name: newTripName.trim(), destination: newTripDest.trim() || undefined, startDate: newTripStart, endDate: newTripEnd, budget: DEFAULT_BUDGET }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const tripRow = await res.json();
      const trip = rowToTrip(tripRow);
      onTripCreate(trip);
      setNewTripName(""); setNewTripDest(""); setNewTripStart(""); setNewTripEnd("");
      setShowNewTrip(false);
      setTripError("");
    } catch (e: any) {
      clearTimeout(timeout);
      setTripError(e.name === 'AbortError' ? "Request timed out. Check your connection." : (e.message || "Failed to create trip."));
    } finally {
      setCreatingTrip(false);
    }
  };

  const handleSaveTrip = async (tripId: string) => {
    setTripError("");
    if (!editTripName.trim()) { setTripError("Trip name is required."); return; }
    if (!editTripStart) { setTripError("Start date is required."); return; }
    if (!editTripEnd) { setTripError("End date is required."); return; }
    if (editTripStart > editTripEnd) { setTripError("End date must be on or after start date."); return; }
    setSavingTrip(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`/api/trips/${tripId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user?.sub, name: editTripName.trim(), destination: editTripDest.trim() || undefined, startDate: editTripStart, endDate: editTripEnd }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const updated = await res.json();
      onTripUpdate?.(rowToTrip(updated));
      setEditingTripId(null);
      setTripError("");
    } catch (e: any) {
      clearTimeout(timeout);
      setTripError(e.name === 'AbortError' ? "Request timed out. Check your connection." : (e.message || "Failed to save trip."));
    } finally {
      setSavingTrip(false);
    }
  };

  const handleDeleteTrip = async (tripId: string) => {
    setDeletingTripId(tripId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`/api/trips/${tripId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user?.sub }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      onTripDelete?.(tripId);
      setConfirmDeleteTripId(null);
    } catch (e: any) {
      clearTimeout(timeout);
      setTripError(e.name === 'AbortError' ? "Request timed out." : (e.message || "Failed to delete trip."));
      setConfirmDeleteTripId(null);
    } finally {
      setDeletingTripId(null);
    }
  };

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
      <SectionLabel icon="wallet">BUDGET SETTINGS</SectionLabel>
      {/* Summary Card */}
      {(() => {
        const { totalBudgetInBase, totalSpent, remaining, pct } = calcSummary(budget, expenses);
        const barColor = pct < 0.6 ? C.cyan : pct < 0.85 ? C.yellow : C.red;
        return (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>BASE CURRENCY</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["EUR","USD","BRL","GBP","COP"] as Currency[]).map(c => (
                  <button key={c} onClick={() => saveBudget({ ...budget, baseCurrency: c })} style={{ background: budget.baseCurrency === c ? C.cyan : C.card3, color: budget.baseCurrency === c ? "#000" : C.textMuted, border: "none", borderRadius: 8, padding: "5px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{c}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>TOTAL BUDGET</div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{currSym(budget.baseCurrency)}{fmtAmt(totalBudgetInBase, 0)}</div>
              </div>
              <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>SPENT</div>
                <div style={{ fontWeight: 800, fontSize: 18, color: barColor }}>{currSym(budget.baseCurrency)}{fmtAmt(totalSpent)}</div>
              </div>
            </div>
            <div style={{ height: 6, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${pct * 100}%`, height: "100%", background: barColor, borderRadius: 4, transition: "width 0.3s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
              <span style={{ color: C.textMuted, fontSize: 11 }}>{currSym(budget.baseCurrency)}{fmtAmt(remaining)} remaining</span>
            </div>
          </Card>
        );
      })()}
      {/* Payment Sources */}
      <SectionLabel action={
        <button onClick={() => setShowAddSource(p => !p)} style={{ background: C.cyan, color: "#000", borderRadius: 20, padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
          <Icon d={icons.plus} size={11} stroke="#000" strokeWidth={2.5} /> ADD
        </button>
      }>PAYMENT SOURCES</SectionLabel>
      {budget.sources.length === 0 && !showAddSource && (
        <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", marginBottom: 12, padding: "8px 0" }}>No sources yet. Add a wallet or credit card.</div>
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
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{currSym(src.currency)}{fmtAmt(src.limit)} {src.currency !== budget.baseCurrency && src.limitInBase ? `≈ ${currSym(budget.baseCurrency)}${fmtAmt(src.limitInBase)}` : ""}</div>
                <div style={{ height: 3, background: C.card3, borderRadius: 2, overflow: "hidden", marginTop: 6 }}>
                  <div style={{ width: `${usePct * 100}%`, height: "100%", background: src.color, borderRadius: 2 }} />
                </div>
              </div>
              <button onClick={() => removeSource(src.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 4 }}><Icon d={icons.trash} size={16} stroke={C.red} /></button>
            </div>
          </Card>
        );
      })}
      {/* Add source form */}
      {showAddSource && (
        <Card style={{ marginBottom: 12, border: `1px solid ${C.cyan}30` }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>New Payment Source</div>
          <Input placeholder="Name (e.g. Nubank, Cash)" value={srcName} onChange={setSrcName} style={{ marginBottom: 10 }} />
          <div style={{ background: C.card3, borderRadius: 12, padding: 4, display: "flex", marginBottom: 10 }}>
            {(["balance","credit"] as SourceType[]).map(t => (
              <button key={t} onClick={() => setSrcType(t)} style={{ flex: 1, padding: "10px", borderRadius: 8, border: "none", cursor: "pointer", background: srcType === t ? C.cyan : "transparent", color: srcType === t ? "#000" : C.textMuted, fontWeight: srcType === t ? 700 : 400, fontSize: 13, fontFamily: "inherit", transition: "all 0.2s" }}>
                {t === "balance" ? "Saldo" : "Crédito"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>CURRENCY</div>
              <select value={srcCurrency} onChange={(e: any) => setSrcCurrency(e.target.value as Currency)} style={{ width: "100%", padding: "12px", borderRadius: 10, background: C.card3, border: `1.5px solid ${C.border}`, color: C.text, fontFamily: "inherit", fontSize: 14 }}>
                {(["EUR","USD","BRL","GBP","COP"] as Currency[]).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>AMOUNT</div>
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
      {/* Daily Limit */}
      <Card style={{ marginBottom: 20, padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>DAILY LIMIT ({budget.baseCurrency})</div>
            <input
              type="number"
              value={budget.dailyLimit}
              onChange={(e: any) => saveBudget({ ...budget, dailyLimit: parseFloat(e.target.value) || 0 })}
              style={{ background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 18, fontWeight: 700, fontFamily: "inherit", width: "100%" }}
            />
          </div>
          <span style={{ color: C.textMuted, fontSize: 14 }}>{currSym(budget.baseCurrency)}/day</span>
        </div>
      </Card>
      <SectionLabel icon="layers" action={
        <button onClick={() => setShowNewTrip(p => !p)} style={{ background: C.cyan, color: "#000", borderRadius: 20, padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>+ New</button>
      }>MY TRIPVERSALS</SectionLabel>

      {showNewTrip && (
        <Card style={{ marginBottom: 12, border: `1px solid ${C.cyan}30` }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>New Tripversal</div>
          <Input placeholder="Trip Name (e.g. Europe Summer)" value={newTripName} onChange={setNewTripName} style={{ marginBottom: 10 }} />
          <Input placeholder="Destination (optional)" value={newTripDest} onChange={setNewTripDest} style={{ marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START DATE</div>
              <Card style={{ padding: 10 }}>
                <input type="date" value={newTripStart} onChange={e => setNewTripStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END DATE</div>
              <Card style={{ padding: 10 }}>
                <input type="date" value={newTripEnd} onChange={e => setNewTripEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
              </Card>
            </div>
          </div>
          {trips.length > 0 && newTripStart && newTripEnd && (() => {
            const overlaps = (trips as Trip[]).filter(t => t.startDate <= newTripEnd && t.endDate >= newTripStart);
            return overlaps.length > 0 ? (
              <div style={{ color: C.yellow, fontSize: 12, marginBottom: 10 }}>ℹ Dates overlap with {overlaps.map(t => t.name).join(', ')} — that's OK</div>
            ) : null;
          })()}
          {tripError && showNewTrip && (
            <div style={{ color: C.red, fontSize: 12, marginBottom: 10, padding: "8px 12px", background: C.redDim, borderRadius: 10 }}>{tripError}</div>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <Btn style={{ flex: 1 }} variant="ghost" onClick={() => { setShowNewTrip(false); setTripError(""); }}>Cancel</Btn>
            <Btn style={{ flex: 1 }} onClick={handleCreateTrip}>{creatingTrip ? "Creating…" : "Create Trip"}</Btn>
          </div>
        </Card>
      )}

      {(trips as Trip[]).map((trip: Trip) => {
        const isActive = trip.id === activeTripId;
        const acceptedCount = (trip.crew || []).filter((m: TripMember) => m.status === 'accepted').length;
        const isEditing = editingTripId === trip.id;
        return (
          <Card key={trip.id} style={{ marginBottom: 10, border: isActive ? `1.5px solid ${C.cyan}30` : undefined, position: "relative", overflow: "visible" }}>
            {isEditing ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Edit Trip</div>
                <Input placeholder="Trip Name" value={editTripName} onChange={setEditTripName} style={{ marginBottom: 10 }} />
                <Input placeholder="Destination (optional)" value={editTripDest} onChange={setEditTripDest} style={{ marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>START DATE</div>
                    <Card style={{ padding: 10 }}>
                      <input type="date" value={editTripStart} onChange={e => setEditTripStart(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>END DATE</div>
                    <Card style={{ padding: 10 }}>
                      <input type="date" value={editTripEnd} onChange={e => setEditTripEnd(e.target.value)} style={{ background: "transparent", border: "none", color: C.text, outline: "none", fontFamily: "inherit", colorScheme: "dark", width: "100%" }} />
                    </Card>
                  </div>
                </div>
                {tripError && isEditing && (
                  <div style={{ color: C.red, fontSize: 12, marginBottom: 10, padding: "8px 12px", background: C.redDim, borderRadius: 10 }}>{tripError}</div>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn style={{ flex: 1 }} variant="ghost" onClick={() => { setEditingTripId(null); setTripError(""); }}>Cancel</Btn>
                  <Btn style={{ flex: 1 }} onClick={() => handleSaveTrip(trip.id)}>{savingTrip ? "Saving…" : "Save"}</Btn>
                </div>
              </>
            ) : (
              <>
                {isActive && <div style={{ position: "absolute", top: -1, right: 0, background: C.cyan, color: "#000", fontSize: 12, fontWeight: 800, padding: "4px 14px", borderRadius: "0 14px 0 14px" }}>Active</div>}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                  <div style={{ flex: 1, paddingRight: isActive ? 60 : 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>{trip.name}</div>
                    {trip.destination && <div style={{ color: C.textMuted, fontSize: 12 }}>{trip.destination}</div>}
                    <div style={{ color: C.textSub, fontSize: 11, marginTop: 2 }}>
                      {formatDateRange(trip.startDate, trip.endDate)} · {acceptedCount} member{acceptedCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0, marginTop: 2 }}>
                    <button
                      onClick={() => { setEditingTripId(trip.id); setEditTripName(trip.name); setEditTripDest(trip.destination || ""); setEditTripStart(trip.startDate); setEditTripEnd(trip.endDate); setTripError(""); }}
                      style={{ background: C.card3, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}
                    >
                      <Icon d={icons.edit} size={15} stroke={C.textMuted} />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteTripId(trip.id)}
                      style={{ background: C.redDim, border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}
                    >
                      <Icon d={icons.trash} size={15} stroke={C.red} />
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  {!isActive && <Btn variant="ghost" style={{ flex: 1, padding: "10px" }} onClick={() => onSwitchTrip(trip.id)}>Set Active</Btn>}
                  {isActive && <Btn variant="secondary" style={{ flex: 1, padding: "10px" }} onClick={onManageCrew} icon={<Icon d={icons.users} size={16} />}>Manage Crew</Btn>}
                </div>
              </>
            )}
          </Card>
        );
      })}
      {trips.length === 0 && !showNewTrip && (
        <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", padding: "12px 0", textAlign: "center" }}>No trips yet. Create one above.</div>
      )}

      {/* ── Confirm Delete Trip — bottom-sheet modal ── */}
      {confirmDeleteTripId && (() => {
        const trip = (trips as Trip[]).find(t => t.id === confirmDeleteTripId);
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
            <div style={{ width: "100%", maxWidth: 430, background: C.card, borderRadius: "20px 20px 0 0", padding: "28px 20px 44px" }}>
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <div style={{ width: 48, height: 48, borderRadius: "50%", background: C.redDim, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
                  <Icon d={icons.trash} size={22} stroke={C.red} />
                </div>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 6 }}>Delete "{trip?.name}"?</div>
                <div style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.5 }}>
                  This will permanently delete the trip and all its data.<br />This action cannot be undone.
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmDeleteTripId(null)}>Cancel</Btn>
                <Btn style={{ flex: 1 }} variant="danger" onClick={() => handleDeleteTrip(confirmDeleteTripId)}>
                  {deletingTripId === confirmDeleteTripId ? "Deleting…" : "Delete Trip"}
                </Btn>
              </div>
            </div>
          </div>
        );
      })()}
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
    } catch {}
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
      pushInviteEvent({ id: Date.now().toString(), type: 'accepted', email: user.email, name: user.name, tripName: trip.name, at: new Date().toISOString() });
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
  const [crewTab, setCrewTab] = useState<'crew' | 'segments'>('crew');
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteToast, setInviteToast] = useState<string | null>(null);
  const [menuMemberId, setMenuMemberId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
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
  const segColors = ["#00e5ff","#30d158","#ffd60a","#ff3b30","#f57c00","#6a1b9a","#1565c0","#e91e8c"];

  if (!trip) return (
    <div style={{ padding: "40px 20px", textAlign: "center", color: C.textMuted }}>No active trip selected.</div>
  );

  const crew: TripMember[] = trip.crew || [];
  const segments: TripSegment[] = trip.segments || [];
  const accepted = crew.filter((m: TripMember) => m.status === 'accepted');
  const pending = crew.filter((m: TripMember) => m.status === 'pending');
  const isAdmin = crew.some((m: TripMember) => m.googleSub === user?.sub && m.role === 'admin');

  const showToast = (msg: string) => { setInviteToast(msg); setTimeout(() => setInviteToast(null), 3000); };

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
      pushInviteEvent({ id: Date.now().toString(), type: 'invited', email: inviteEmail.trim(), tripName: trip.name, at: new Date().toISOString() });
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

  const handleAddSegment = async () => {
    if (!segName.trim()) return;
    setSegSaving(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerSub: user.sub, name: segName.trim(), origin: segOrigin, destination: segDest, startDate: segStart || undefined, endDate: segEnd || undefined, color: segColor, assignedMemberIds: segAssigned }),
      });
      if (!res.ok) throw new Error();
      const seg = await res.json();
      const newSeg: TripSegment = { id: seg.id, name: seg.name, startDate: seg.start_date, endDate: seg.end_date, origin: seg.origin, destination: seg.destination, color: seg.color, assignedMemberIds: seg.assigned_member_ids || [] };
      onTripUpdate({ ...trip, segments: [...segments, newSeg] });
      setSegName(""); setSegOrigin(""); setSegDest(""); setSegStart(""); setSegEnd(""); setSegColor("#00e5ff"); setSegAssigned([]); setShowAddSeg(false);
    } catch { showToast("Failed to add segment."); }
    setSegSaving(false);
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
          <div style={{ fontSize: 18, fontWeight: 700 }}>Travel Crew</div>
          <div style={{ color: C.textMuted, fontSize: 12 }}>{trip.name}</div>
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ background: C.card3, borderRadius: 14, padding: 4, display: "flex", marginBottom: 20 }}>
        {(['crew', 'segments'] as const).map(t => (
          <button key={t} onClick={() => setCrewTab(t)} style={{ flex: 1, padding: "12px", borderRadius: 10, border: "none", cursor: "pointer", background: crewTab === t ? C.cyan : "transparent", color: crewTab === t ? "#000" : C.textMuted, fontWeight: crewTab === t ? 700 : 400, fontSize: 13, fontFamily: "inherit", transition: "all 0.2s", letterSpacing: 1 }}>
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
        </>
      ) : (
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
                <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>COLOR</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {segColors.map(c => (
                    <button key={c} onClick={() => setSegColor(c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: segColor === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {segColor === c && <Icon d={icons.check} size={12} stroke="#fff" strokeWidth={3} />}
                    </button>
                  ))}
                </div>
              </div>
              {accepted.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>ASSIGN MEMBERS</div>
                  {accepted.map((m: TripMember) => (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
                      <input type="checkbox" checked={segAssigned.includes(m.id)} onChange={e => setSegAssigned(prev => e.target.checked ? [...prev, m.id] : prev.filter(id => id !== m.id))} />
                      <Avatar name={m.name || m.email} src={m.avatarUrl} size={28} />
                      <span style={{ fontSize: 13 }}>{m.name || m.email}</span>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setShowAddSeg(false)}>Cancel</Btn>
                <Btn style={{ flex: 1 }} onClick={handleAddSegment}>{segSaving ? "Saving…" : "Create"}</Btn>
              </div>
            </Card>
          )}

          {segments.length === 0 && !showAddSeg && (
            <div style={{ color: C.textSub, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>No segments yet. Add one above.</div>
          )}
          {segments.map((seg: TripSegment) => {
            const assignedNames = seg.assignedMemberIds.length === 0 ? 'Everyone'
              : seg.assignedMemberIds.map((id: string) => accepted.find((m: TripMember) => m.id === id)?.name || '?').join(', ');
            return (
              <Card key={seg.id} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: seg.color, marginTop: 5, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{seg.name}</div>
                    {(seg.origin || seg.destination) && (
                      <div style={{ color: C.textMuted, fontSize: 12 }}>{seg.origin} {seg.origin && seg.destination ? '→' : ''} {seg.destination}</div>
                    )}
                    {seg.startDate && seg.endDate && (
                      <div style={{ color: C.textSub, fontSize: 12 }}>{formatDateRange(seg.startDate, seg.endDate)}</div>
                    )}
                    <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{assignedNames}</div>
                  </div>
                  {isAdmin && (
                    <button onClick={() => handleDeleteSegment(seg.id)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 4 }}>
                      <Icon d={icons.trash} size={16} stroke={C.red} />
                    </button>
                  )}
                </div>
              </Card>
            );
          })}
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
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>
      </div>
    </div>
  );
};

function AppShell() {
  const [user, setUser] = useState<any>(null);
  const [tab, setTab] = useState("home");
  const [showSettings, setShowSettings] = useState(false);
  const [showManageCrew, setShowManageCrew] = useState(false);
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
      try { setUser(JSON.parse(stored)); } catch {}
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
      .catch(() => {});
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
    setShowSettings(false); setShowManageCrew(false); setShowAddExpense(false); setShowHistory(false); setTab(t);
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
      case "home": content = <HomeScreen onNav={handleNav} onAddExpense={() => setShowAddExpense(true)} activeTripId={activeTripId} user={user} />; break;
      case "itinerary": content = <ItineraryScreen activeTripId={activeTripId} activeTrip={activeTrip} userSub={user?.sub} />; break;
      case "wallet": content = <WalletScreen onAddExpense={() => setShowAddExpense(true)} activeTripId={activeTripId} user={user} />; break;
      case "photos": content = <PhotosScreen />; break;
      case "sos": content = <SOSScreen />; break;
      default: content = null;
    }
  }

  const activeTab = showSettings || showManageCrew || showAddExpense || showHistory || pendingInviteToken ? null : tab;

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
