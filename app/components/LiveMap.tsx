'use client';

import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getSupabaseAnon } from '../../lib/supabase';

const victimIcon = new L.DivIcon({
    className: 'victim-marker',
    html: `<div style="width: 24px; height: 24px; background: red; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px rgba(255,0,0,0.8); animation: pulse 1s infinite;"></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
});

const searcherIcon = new L.DivIcon({
    className: 'searcher-marker',
    html: `<div style="width: 20px; height: 20px; background: #0a84ff; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 8px rgba(10,132,255,0.6);"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
});

function AutoPan({ position }: { position: [number, number] | null }) {
    const map = useMap();
    useEffect(() => {
        if (position) map.setView(position, map.getZoom(), { animate: true });
    }, [position, map]);
    return null;
}

const anonSupabase = getSupabaseAnon();

export default function LiveMap({ tripId, onBack }: { tripId: string, onBack: () => void }) {
    const [victimLoc, setVictimLoc] = useState<[number, number] | null>(null);
    const [myLoc, setMyLoc] = useState<[number, number] | null>(null);
    const [isSOSActive, setIsSOSActive] = useState(true);

    useEffect(() => {
        if ("geolocation" in navigator) {
            const watchId = navigator.geolocation.watchPosition(
                (pos) => setMyLoc([pos.coords.latitude, pos.coords.longitude]),
                (err) => console.error("Searcher LOC err:", err),
                { enableHighAccuracy: true }
            );
            return () => navigator.geolocation.clearWatch(watchId);
        }
    }, []);

    useEffect(() => {
        if (!tripId) return;

        // Fetch initial
        anonSupabase.from('trip_sos_sessions')
            .select('lat, lng, is_active')
            .eq('trip_id', tripId)
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(1)
            .then(({ data }) => {
                if (data && data.length > 0) {
                    setVictimLoc([data[0].lat, data[0].lng]);
                    setIsSOSActive(data[0].is_active);
                }
            });

        // Subscribe
        const channel = anonSupabase.channel('sos_updates')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'trip_sos_sessions',
                filter: `trip_id=eq.${tripId}`
            }, (payload) => {
                const row = payload.new as any;
                setIsSOSActive(row.is_active);
                if (row.is_active) setVictimLoc([row.lat, row.lng]);
            }).subscribe();

        return () => {
            anonSupabase.removeChannel(channel);
        };
    }, [tripId]);

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
                    ← Back
                </button>
                <div style={{ background: isSOSActive ? 'rgba(255,0,0,0.8)' : 'rgba(100,100,100,0.8)', color: '#fff', padding: '10px 16px', borderRadius: 20, fontWeight: 700, flex: 1, textAlign: 'center' }}>
                    {isSOSActive ? '🚨 LIVE SOS TRACKING' : 'SOS RESOLVED'}
                </div>
            </div>

            {(victimLoc || myLoc) ? (
                <MapContainer center={victimLoc || myLoc || [0, 0]} zoom={16} zoomControl={false} style={{ width: '100vw', height: '100vh' }}>
                    <TileLayer
                        attribution='&copy; OpenStreetMap'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    {victimLoc && isSOSActive && (
                        <Marker position={victimLoc} icon={victimIcon}>
                            <Popup>SOS Location</Popup>
                        </Marker>
                    )}
                    {myLoc && (
                        <Marker position={myLoc} icon={searcherIcon}>
                            <Popup>You</Popup>
                        </Marker>
                    )}
                    <AutoPan position={victimLoc} />
                </MapContainer>
            ) : (
                <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
                    Consultando a localização em tempo real...
                </div>
            )}
        </div>
    );
}
