'use client';

import { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getSupabaseAnon } from '../../lib/supabase';
import { useTranslation } from 'react-i18next';

interface ActiveSession {
    user_sub: string;
    user_name: string;
    lat: number;
    lng: number;
    is_active: boolean;
}

function createLabeledIcon(name: string, color: string, pulse: boolean) {
    return new L.DivIcon({
        className: '',
        html: `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
            <div style="background:rgba(0,0,0,0.75);color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;white-space:nowrap;margin-bottom:4px;border:1px solid ${color};backdrop-filter:blur(6px);">${name || '?'}</div>
            <div style="width:20px;height:20px;background:${color};border-radius:50%;border:3px solid #fff;box-shadow:0 0 10px ${color}80;${pulse ? 'animation:pulse 1s infinite;' : ''}"></div>
        </div>`,
        iconSize: [80, 46],
        iconAnchor: [40, 46]
    });
}

function AutoPan({ position }: { position: [number, number] | null }) {
    const map = useMap();
    const didPan = useRef(false);
    useEffect(() => {
        if (position && !didPan.current) {
            map.setView(position, map.getZoom(), { animate: true });
            didPan.current = true;
        }
    }, [position, map]);
    return null;
}

const anonSupabase = getSupabaseAnon();

export default function LiveMap({
    tripId,
    onBack,
    currentUserSub,
    sosInitiatorSub,
}: {
    tripId: string;
    onBack: () => void;
    currentUserSub?: string;
    sosInitiatorSub?: string | null;
}) {
    const { t } = useTranslation();
    const [sessions, setSessions] = useState<ActiveSession[]>([]);

    useEffect(() => {
        if (!tripId) return;

        // Fetch all active sessions (both SOS initiator and group members)
        anonSupabase.from('trip_sos_sessions')
            .select('user_sub, user_name, lat, lng, is_active')
            .eq('trip_id', tripId)
            .eq('is_active', true)
            .then(({ data }) => {
                if (data && data.length > 0) {
                    setSessions(data as ActiveSession[]);
                }
            });

        // Subscribe to all location changes
        const channel = anonSupabase.channel(`sos_updates_${tripId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'trip_sos_sessions',
                filter: `trip_id=eq.${tripId}`
            }, (payload) => {
                const row = payload.new as any;
                setSessions(prev => {
                    const filtered = prev.filter(s => s.user_sub !== row.user_sub);
                    if (row.is_active && row.lat && row.lng) {
                        return [...filtered, {
                            user_sub: row.user_sub,
                            user_name: row.user_name || '',
                            lat: row.lat,
                            lng: row.lng,
                            is_active: true
                        }];
                    }
                    return filtered;
                });
            }).subscribe();

        return () => {
            anonSupabase.removeChannel(channel);
        };
    }, [tripId]);

    // Center on SOS initiator if present, otherwise first session
    const initiatorSession = sessions.find(s => s.user_sub === sosInitiatorSub) ?? null;
    const centerSession = initiatorSession ?? (sessions.length > 0 ? sessions[0] : null);
    const centerPos: [number, number] | null = centerSession ? [centerSession.lat, centerSession.lng] : null;

    const sosActive = sessions.some(s => s.user_sub === sosInitiatorSub);

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000' }}>
            <style>{`
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(255,0,0, 0.7); }
          70% { box-shadow: 0 0 0 20px rgba(255,0,0, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255,0,0, 0); }
        }
      `}</style>

            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '20px', zIndex: 10000, display: 'flex', gap: 10, background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)' }}>
                <button onClick={onBack} style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(10px)', border: 'none', color: '#fff', padding: '10px 16px', borderRadius: 20, fontWeight: 700 }}>
                    ← {t('liveMap.back')}
                </button>
                <div style={{ background: sosActive ? 'rgba(255,0,0,0.8)' : 'rgba(100,100,100,0.8)', color: '#fff', padding: '10px 16px', borderRadius: 20, fontWeight: 700, flex: 1, textAlign: 'center' }}>
                    {sosActive ? `🚨 ${t('liveMap.liveTracking')}` : t('liveMap.resolved')}
                </div>
            </div>

            {centerPos ? (
                <MapContainer center={centerPos} zoom={16} zoomControl={false} style={{ width: '100vw', height: '100vh' }}>
                    <TileLayer
                        attribution='&copy; OpenStreetMap'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    {sessions.map(s => {
                        const isInitiator = s.user_sub === sosInitiatorSub;
                        const isMe = s.user_sub === currentUserSub;
                        // SOS initiator → red pulsing for everyone
                        // Other members (including me when I'm not initiator) → blue
                        const color = isInitiator ? '#ff3b30' : '#0a84ff';
                        const pulse = isInitiator;
                        const displayName = s.user_name?.trim() || (isMe ? t('liveMap.you') : '?');
                        const prefix = isInitiator ? '🚨' : (isMe ? '📍' : '👤');
                        const label = `${prefix} ${displayName}`;
                        return (
                            <Marker key={s.user_sub} position={[s.lat, s.lng]} icon={createLabeledIcon(label, color, pulse)}>
                                <Popup>{displayName}</Popup>
                            </Marker>
                        );
                    })}
                    <AutoPan position={centerPos} />
                </MapContainer>
            ) : (
                <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
                    {t('liveMap.loading')}
                </div>
            )}
        </div>
    );
}
