'use client'

import { useState, useEffect } from "react";
import { GoogleOAuthProvider, useGoogleLogin } from "@react-oauth/google";

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
}

interface TripBudget {
  baseCurrency: Currency;
  dailyLimit: number;
  sources: PaymentSource[];
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

const C = {
  bg: "#0a0a0a", card: "#141414", card2: "#1c1c1e", card3: "#232326",
  border: "#2a2a2e", cyan: "#00e5ff", cyanDim: "#00b8cc", text: "#ffffff",
  textMuted: "#8e8e93", textSub: "#636366", red: "#ff3b30", redDim: "#3d1a1a",
  green: "#30d158", yellow: "#ffd60a", purple: "#1a1333", purpleBorder: "#3d2d6e",
};

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

const Header = ({ onSettings, isOnline = true, user }: any) => {
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
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: isOnline ? C.green : C.red }} />
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

const HomeScreen = ({ onNav, onAddExpense }: any) => (
  <div style={{ padding: "0 0 100px" }}>
    <div style={{ padding: "16px 20px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 40, fontWeight: 800, color: C.text, letterSpacing: -1 }}>€126</span>
          <span style={{ color: C.textMuted, fontSize: 18 }}>/ €400</span>
        </div>
        <div style={{ background: "#1a2a1a", color: C.green, borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
          <span>↗</span> 32%
        </div>
      </div>
      <div style={{ height: 6, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: "32%", height: "100%", background: C.cyan, borderRadius: 4 }} />
      </div>
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
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ position: "relative" }}>
            <Avatar name="P" size={40} color="#aaa" />
            <div style={{ position: "absolute", bottom: -2, right: -2, background: "#f5a623", borderRadius: 4, padding: "1px 3px" }}>
              <Icon d={icons.wallet} size={8} stroke="#fff" fill="none" />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14 }}><span style={{ color: C.text, fontWeight: 600 }}>Patrick</span> <span style={{ color: C.textMuted }}>paid</span></div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>Paid for Lunch at Le Bistro</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: C.textMuted, fontSize: 11 }}>07:04 PM</div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>€126.00</div>
          </div>
        </div>
      </Card>
    </div>
  </div>
);

const itineraryData = [
  { time: "08:00", type: "plane", title: "Flight CDG → FCO", sub: "Air France AF1234 • Gate 2B", status: "done", icon: icons.plane },
  { time: "11:30", type: "transit", title: "Leonardo Express", sub: "Fiumicino → Termini • 32 min", status: "done", icon: icons.car },
  { time: "13:00", type: "checkin", title: "Check-in Airbnb Roma", sub: "Via del Corso 18 • Host: Marco", status: "now", icon: icons.building },
  { time: "15:30", type: "activity", title: "Colosseum Tour", sub: "Booked • 4 adults + 3 kids", status: "upcoming", icon: icons.tag },
  { time: "20:00", type: "food", title: "Dinner reservation", sub: "Trattoria da Mario • 7 pax", status: "upcoming", icon: icons.food },
];

const ItineraryScreen = () => (
  <div style={{ padding: "16px 20px 100px" }}>
    <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{"Today's Itinerary"}</div>
    <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 20 }}>Tuesday, 18 Feb 2026 · Rome, Italy</div>
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: 19, top: 0, bottom: 0, width: 2, background: `linear-gradient(to bottom, ${C.cyan}40, ${C.cyan}10)` }} />
      {itineraryData.map((item, i) => {
        const isNow = item.status === "now";
        const isDone = item.status === "done";
        return (
          <div key={i} style={{ display: "flex", gap: 16, marginBottom: 16, position: "relative" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: isNow ? C.cyan : isDone ? "#1a2a1a" : C.card3, border: `2px solid ${isNow ? C.cyan : isDone ? C.green : C.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, zIndex: 1 }}>
              <Icon d={item.icon} size={16} stroke={isNow ? "#000" : isDone ? C.green : C.textMuted} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ background: isNow ? `${C.cyan}15` : C.card, borderRadius: 14, padding: 14, border: isNow ? `1px solid ${C.cyan}30` : "none" }}>
                {isNow && <div style={{ color: C.cyan, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>● NOW</div>}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: isDone ? C.textMuted : C.text }}>{item.title}</div>
                    <div style={{ color: C.textSub, fontSize: 12, marginTop: 2 }}>{item.sub}</div>
                  </div>
                  <div style={{ color: C.textSub, fontSize: 12, flexShrink: 0, marginLeft: 8 }}>{item.time}</div>
                </div>
                {!isDone && (
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <div style={{ background: C.card3, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: C.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                      <Icon d={icons.fileText} size={12} /> Docs
                    </div>
                    <div style={{ background: C.card3, borderRadius: 8, padding: "6px 12px", fontSize: 12, color: C.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                      <Icon d={icons.navigation} size={12} /> Map
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const WalletScreen = ({ onAddExpense }: any) => {
  const [budget, setBudgetState] = useState<TripBudget>(DEFAULT_BUDGET);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  useEffect(() => {
    try {
      const bs = localStorage.getItem('tripversal_budget');
      if (bs) setBudgetState(JSON.parse(bs));
      const es = localStorage.getItem('tripversal_expenses');
      if (es) setExpenses(JSON.parse(es));
    } catch {}
  }, []);

  const { totalBudgetInBase, totalSpent, remaining } = calcSummary(budget, expenses);

  // Build 7-day trend
  const today = new Date();
  const dayData = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (6 - i));
    const key = d.toISOString().slice(0, 10);
    const label = i === 6 ? "TODAY" : d.toLocaleDateString("en", { weekday: "short" }).toUpperCase().slice(0, 3);
    const total = expenses.filter(e => e.date.slice(0, 10) === key).reduce((s, e) => s + e.baseAmount, 0);
    return { label, total, isToday: i === 6 };
  });
  const maxDay = Math.max(...dayData.map(d => d.total), 1);

  // Source lookup
  const sourceMap = Object.fromEntries(budget.sources.map(s => [s.id, s]));

  return (
    <div style={{ padding: "0 20px 100px" }}>
      <div style={{ paddingTop: 16, marginBottom: 4 }}>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: -1 }}>{currSym(budget.baseCurrency)}{totalSpent.toFixed(2)}</div>
        <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, fontWeight: 600 }}>TOTAL TRIP SPEND</div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.textMuted }}>{currSym(budget.baseCurrency)}{remaining.toFixed(2)}</div>
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
      {expenses.slice(0, 20).map(exp => {
        const src = sourceMap[exp.sourceId];
        const catIcon = categories.find(c => c.id === exp.category)?.icon || icons.moreH;
        const dateStr = new Date(exp.date).toLocaleDateString("en", { day: "numeric", month: "short" }).toUpperCase();
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
                <div style={{ fontWeight: 700, fontSize: 15 }}>{currSym(exp.localCurrency)}{exp.localAmount.toFixed(2)}</div>
                <div style={{ color: C.textSub, fontSize: 11 }}>{dateStr}</div>
              </div>
            </div>
          </Card>
        );
      })}
      <div style={{ position: "fixed", bottom: 90, right: "calc(50% - 200px)", width: 56, height: 56, borderRadius: "50%", background: C.cyan, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: `0 4px 20px ${C.cyan}50` }} onClick={onAddExpense}>
        <Icon d={icons.plus} size={24} stroke="#000" strokeWidth={2.5} />
      </div>
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

const AddExpenseScreen = ({ onBack }: any) => {
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
          <span style={{ fontSize: 32, color: C.textMuted }}>€</span>
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
            <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
              {budget.sources.map(src => {
                const active = selectedSourceId === src.id;
                return (
                  <button key={src.id} onClick={() => { setSelectedSourceId(src.id); setLocalCurrency(src.currency); }} style={{ flexShrink: 0, background: active ? "#003d45" : C.card3, border: active ? `2px solid ${src.color}` : "2px solid transparent", borderRadius: 14, padding: "12px 16px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, minWidth: 120 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: src.color }} />
                      <span style={{ color: active ? C.text : C.textMuted, fontWeight: active ? 700 : 400, fontSize: 13 }}>{src.name}</span>
                    </div>
                    <span style={{ color: C.textSub, fontSize: 11 }}>{src.currency}</span>
                  </button>
                );
              })}
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
        <SectionLabel>DATE</SectionLabel>
        <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon d={icons.calendar} size={16} stroke={C.textMuted} />
          <span style={{ color: C.text, fontSize: 15, flex: 1 }}>18/02/2026</span>
        </Card>
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
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ color: C.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>SPLIT</span>
            <span style={{ color: C.cyan, fontSize: 12, fontWeight: 600 }}>remaining: €{total.toFixed(2)}</span>
          </div>
          {members.map(m => {
            const toPay = totalShares > 0 ? (total * shares[m] / totalShares).toFixed(2) : "0.00";
            return (
              <Card key={m} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <Avatar name={m} />
                  <div>
                    <div style={{ fontWeight: 600 }}>{m}</div>
                    <div style={{ color: C.cyan, fontSize: 12 }}>€{toPay}</div>
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
                    <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 8 }}>FIXED €</div>
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
        <div style={{ border: `2px dashed ${C.border}`, borderRadius: 14, padding: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer" }}>
          <Icon d={icons.receipt} size={20} stroke={C.textMuted} />
          <span style={{ color: C.textMuted, fontSize: 14 }}>Add Receipt</span>
        </div>
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
          date: new Date().toISOString(),
          sourceId: selectedSourceId,
          type: expType as "personal" | "group",
          localAmount,
          localCurrency,
          baseAmount: localAmount * localToBaseRate,
          baseCurrency: budget.baseCurrency,
          localToBaseRate,
          whoPaid: expType === "group" ? whoPaid : undefined,
          splits: expType === "group" ? shares : undefined,
        };
        try {
          const prev = localStorage.getItem('tripversal_expenses');
          const arr: Expense[] = prev ? JSON.parse(prev) : [];
          localStorage.setItem('tripversal_expenses', JSON.stringify([expense, ...arr]));
        } catch {}
        setSaving(false);
        onBack();
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

const SettingsScreen = ({ onManageCrew, user, onLogout }: any) => {
  const [offlineSim, setOfflineSim] = useState(false);
  const [forcePending, setForcePending] = useState(false);
  const [showNewTrip, setShowNewTrip] = useState(false);
  const [tripName, setTripName] = useState("");
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
  const saveBudget = (next: TripBudget) => { setBudget(next); localStorage.setItem('tripversal_budget', JSON.stringify(next)); };

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

  const [trips, setTrips] = useState<any[]>([
    { name: "European Summer", code: "TRV-8821", members: 3, active: true }
  ]);
  const activeTrip = trips.find(t => t.active) || trips[0];

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
                <div style={{ fontWeight: 800, fontSize: 18 }}>{currSym(budget.baseCurrency)}{totalBudgetInBase.toFixed(0)}</div>
              </div>
              <div style={{ background: C.card3, borderRadius: 12, padding: 12 }}>
                <div style={{ color: C.textMuted, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>SPENT</div>
                <div style={{ fontWeight: 800, fontSize: 18, color: barColor }}>{currSym(budget.baseCurrency)}{totalSpent.toFixed(2)}</div>
              </div>
            </div>
            <div style={{ height: 6, background: C.card3, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${pct * 100}%`, height: "100%", background: barColor, borderRadius: 4, transition: "width 0.3s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
              <span style={{ color: C.textMuted, fontSize: 11 }}>{currSym(budget.baseCurrency)}{remaining.toFixed(2)} remaining</span>
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
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{currSym(src.currency)}{src.limit.toFixed(2)} {src.currency !== budget.baseCurrency && src.limitInBase ? `≈ ${currSym(budget.baseCurrency)}${src.limitInBase.toFixed(2)}` : ""}</div>
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
      <SectionLabel icon="layers">MY TRIPVERSALS</SectionLabel>
      {activeTrip && (
        <Card style={{ marginBottom: 10, border: `1.5px solid ${C.cyan}30`, position: "relative", overflow: "visible" }}>
          <div style={{ position: "absolute", top: -1, right: 0, background: C.cyan, color: "#000", fontSize: 12, fontWeight: 800, padding: "4px 14px", borderRadius: "0 14px 0 14px" }}>Active</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{activeTrip.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <Badge color={C.textMuted} bg={C.card3}>{activeTrip.code}</Badge>
              <span style={{ color: C.textMuted, fontSize: 13 }}>• {activeTrip.members} members</span>
            </div>
          </div>
          <Btn style={{ width: "100%" }} variant="secondary" onClick={onManageCrew} icon={<Icon d={icons.users} size={16} stroke={C.text} />}>Manage Crew</Btn>
        </Card>
      )}
      {!showNewTrip ? (
        <Btn style={{ width: "100%", marginBottom: 20 }} variant="secondary" onClick={() => setShowNewTrip(true)} icon={<Icon d={icons.plane} size={16} stroke={C.textMuted} />}>Start New Tripversal</Btn>
      ) : (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ textAlign: "center", fontWeight: 600, marginBottom: 14 }}>Start a new trip? Current data will be archived.</div>
          <Input placeholder="Trip Name" value={tripName} onChange={setTripName} style={{ marginBottom: 12 }} />
          <div style={{ display: "flex", gap: 10 }}>
            <Btn style={{ flex: 1 }} variant="secondary" onClick={() => setShowNewTrip(false)}>Cancel</Btn>
            <Btn style={{ flex: 1 }} onClick={() => {
              if (!tripName.trim()) return;
              // archive existing active trip(s) and create a new active trip
              const code = `TRV-${Math.floor(1000 + Math.random() * 9000)}`;
              setTrips(prev => prev.map(t => ({ ...t, active: false })).concat([{ name: tripName.trim(), code, members: 1, active: true }]));
              setTripName("");
              setShowNewTrip(false);
            }}>Create</Btn>
          </div>
        </Card>
      )}
      <SectionLabel icon="bug">DEV CONTROLS</SectionLabel>
      <Card>
        {[
          { label: "Offline Simulation", sub: offlineSim ? "NETWORK OFFLINE" : "NETWORK ONLINE", icon: icons.wifi, val: offlineSim, set: setOfflineSim, iconBg: "#003d10", iconColor: C.green },
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

const ManageCrewScreen = ({ onBack }: any) => {
  const [showPass, setShowPass] = useState(false);
  const [showAddSeg, setShowAddSeg] = useState(false);
  const [segName, setSegName] = useState("");
  const [segColor, setSegColor] = useState("#e53935");
  const [segments, setSegments] = useState([
    { name: "Everyone", color: C.cyan, default: true }
  ]);
  const [whatsapp, setWhatsapp] = useState("");
  const [crew, setCrew] = useState([
    { name: "You", whatsapp: "your@whatsapp", status: "you" as const },
    { name: "Patrick", whatsapp: "+55 11 98765-4321", status: "accepted" as const },
    { name: "Sarah", whatsapp: "+33 6 12 34 56 78", status: "invited" as const }
  ]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const segColors = ["#e53935","#f57c00","#f9cf1e","#2e7d32","#00bcd4","#1565c0","#6a1b9a","#e91e8c"];
  return (
    <div style={{ padding: "16px 20px 100px", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ background: C.card3, border: "none", borderRadius: 10, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.text, fontSize: 18 }}>←</button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Manage Crew</span>
      </div>
      <div style={{ background: `linear-gradient(135deg, ${C.purple} 0%, #120d24 100%)`, borderRadius: 20, padding: 20, marginBottom: 20, border: `1px solid ${C.purpleBorder}` }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Invite Family</div>
        <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>Share this code with family members to join the Tripversal.</div>
        <div style={{ background: "#ffffff10", borderRadius: 12, padding: 14, marginBottom: 10 }}>
          <div style={{ color: C.textSub, fontSize: 10, letterSpacing: 1.5, marginBottom: 6 }}>TRIPVERSAL CODE</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: C.cyan, fontSize: 24, fontWeight: 800, letterSpacing: 2 }}>TRV-8821</span>
            <button style={{ width: 36, height: 36, borderRadius: 10, background: "#ffffff15", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.text }}><Icon d={icons.copy} size={16} /></button>
          </div>
        </div>
        <div style={{ background: "#ffffff10", borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ color: C.textSub, fontSize: 10, letterSpacing: 1.5, marginBottom: 6 }}>TRIPVERSAL PASSWORD</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ letterSpacing: 4, fontSize: 14 }}>{showPass ? "pass123" : "● ● ● ● ● ● ●"}</span>
              <button onClick={() => setShowPass((p: boolean) => !p)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted }}><Icon d={icons.eye} size={16} /></button>
            </div>
            <button style={{ width: 36, height: 36, borderRadius: 10, background: "#ffffff15", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: C.text }}><Icon d={icons.edit} size={16} /></button>
          </div>
        </div>
        <Btn variant="white" style={{ width: "100%" }} icon={<Icon d={icons.share} size={16} />}>Share Invite</Btn>
      </div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.textMuted, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
            <Icon d={icons.layers} size={14} /> TRIP SEGMENTS
          </div>
          <button onClick={() => setShowAddSeg((p: boolean) => !p)} style={{ background: C.cyan, color: "#000", borderRadius: 20, padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
            <Icon d={icons.plus} size={12} stroke="#000" strokeWidth={2.5} /> NEW SEGMENT
          </button>
        </div>
        {showAddSeg && (
          <div style={{ background: C.card3, borderRadius: 14, padding: 16, marginBottom: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Add Segment</div>
            <Input placeholder="e.g. Europe Leg 1" value={segName} onChange={setSegName} style={{ marginBottom: 14 }} />
            <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 10 }}>SEGMENT COLOR</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 16 }}>
              {segColors.map(c => (
                <button key={c} onClick={() => setSegColor(c)} style={{ width: 36, height: 36, borderRadius: "50%", background: c, border: segColor === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {segColor === c && <Icon d={icons.check} size={14} stroke="#fff" strokeWidth={3} />}
                </button>
              ))}
            </div>
            <Btn style={{ width: "100%" }} variant="secondary" onClick={() => {
              if (segName.trim()) {
                setSegments([...segments, { name: segName, color: segColor, default: false }]);
                setSegName("");
                setSegColor(segColors[0]);
                setShowAddSeg(false);
              }
            }}>Create</Btn>
          </div>
        )}
        {/* Lista de segmentos */}
        {segments.map((seg, idx) => (
          <div key={seg.name + idx} style={{ background: C.card3, borderRadius: 20, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, width: "fit-content", marginBottom: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: seg.color }} />
            <span style={{ fontWeight: 600 }}>{seg.name}</span>
            {seg.default && <span style={{ color: C.textMuted, fontSize: 13 }}>(Default)</span>}
          </div>
        ))}
      </Card>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#003d3a", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon d={icons.users} size={24} stroke={C.cyan} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Group Settings</div>
          <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1 }}>TRAVEL CREW</div>
        </div>
      </div>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <input placeholder="WhatsApp or Phone" value={whatsapp} onChange={(e: any) => setWhatsapp(e.target.value)} style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: C.text, fontSize: 15, fontFamily: "inherit" }} />
          <button onClick={() => {
            if (whatsapp.trim() && !crew.some(c => c.whatsapp === whatsapp.trim())) {
              setCrew([...crew, { name: `User_${crew.length}`, whatsapp: whatsapp.trim(), status: "invited" as const }]);
              setWhatsapp("");
            }
          }} style={{ background: C.card3, border: "none", borderRadius: 10, padding: "8px 16px", color: C.text, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Add</button>
        </div>
      </Card>
      <div style={{ color: C.textMuted, fontSize: 11, letterSpacing: 1, marginBottom: 10 }}>FAMILY MEMBERS ({crew.length})</div>
      {crew.map((m) => (
        <Card key={m.whatsapp} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <Avatar name={m.name} size={42} color={m.status === "you" ? C.cyan : m.status === "invited" ? "#999" : C.cyan} />
              <div style={{ position: "absolute", bottom: 0, left: 4, width: 8, height: 8, borderRadius: "50%", background: m.status === "you" ? C.cyan : m.status === "accepted" ? C.green : "#999", border: "2px solid #141414" }} />
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 6 }}>({m.status === "you" ? "Me" : m.status === "invited" ? "Pending invite" : "Accepted"})</span>
            </div>
            {m.status === "you" ? <Icon d={icons.edit} size={16} stroke={C.textMuted} /> : (
              <button onClick={() => setConfirmDelete(m.whatsapp)} style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 0 }}><Icon d={icons.trash} size={16} stroke={C.red} /></button>
            )}
          </div>
        </Card>
      ))}
      {confirmDelete && (
        <Card style={{ marginBottom: 16, background: `${C.redDim}80`, borderRadius: 16, padding: 20 }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8, color: C.red }}>Remove member?</div>
            <div style={{ color: C.textMuted, fontSize: 14 }}>This member will be removed from the trip group.</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn style={{ flex: 1 }} variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn style={{ flex: 1 }} variant="danger" onClick={() => {
              setCrew(crew.filter(c => c.whatsapp !== confirmDelete));
              setConfirmDelete(null);
            }}>Remove</Btn>
          </div>
        </Card>
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
  const [showCrew, setShowCrew] = useState(false);
  const [showAddExpense, setShowAddExpense] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('tripversal_user');
    if (stored) {
      try { setUser(JSON.parse(stored)); } catch {}
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('tripversal_user');
    localStorage.removeItem('tripversal_profile');
    localStorage.removeItem('tripversal_budget');
    localStorage.removeItem('tripversal_expenses');
    setUser(null);
  };

  if (!user) return <LoginScreen onLogin={setUser} />;

  const handleNav = (t: string) => {
    setShowSettings(false); setShowCrew(false); setShowAddExpense(false); setTab(t);
  };

  let content;
  if (showAddExpense) content = <AddExpenseScreen onBack={() => setShowAddExpense(false)} />;
  else if (showCrew) content = <ManageCrewScreen onBack={() => setShowCrew(false)} />;
  else if (showSettings) content = <SettingsScreen onManageCrew={() => setShowCrew(true)} user={user} onLogout={handleLogout} />;
  else {
    switch (tab) {
      case "home": content = <HomeScreen onNav={handleNav} onAddExpense={() => setShowAddExpense(true)} />; break;
      case "itinerary": content = <ItineraryScreen />; break;
      case "wallet": content = <WalletScreen onAddExpense={() => setShowAddExpense(true)} />; break;
      case "photos": content = <PhotosScreen />; break;
      case "sos": content = <SOSScreen />; break;
      default: content = null;
    }
  }

  const activeTab = showSettings || showCrew || showAddExpense ? null : tab;

  return (
    <div style={{ background: "#000", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 430, minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", position: "relative", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
        <Header onSettings={() => { setShowSettings(true); setShowCrew(false); setShowAddExpense(false); }} user={user} />
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
