import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { C } from '../TripversalApp';

interface LocationAutocompleteProps {
    value: string;
    onChange: (val: string) => void;
    placeholder?: string;
    style?: React.CSSProperties;
}

export default function LocationAutocomplete({ value, onChange, placeholder, style }: LocationAutocompleteProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState(value);
    const [suggestions, setSuggestions] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<NodeJS.Timeout>();

    useEffect(() => {
        setQuery(value);
    }, [value]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchSuggestions = async (search: string) => {
        if (!search.trim() || search.length < 3) {
            setSuggestions([]);
            setIsOpen(false);
            return;
        }

        setLoading(true);
        try {
            const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(search)}&count=5&language=en&format=json`);
            if (res.ok) {
                const data = await res.json();
                setSuggestions(data.results || []);
                setIsOpen(true);
            }
        } catch (error) {
            console.error("Geocoding API error:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setQuery(val);
        onChange(val); // Always keep the parent synced with raw input text

        if (debounceRef.current) clearTimeout(debounceRef.current);

        debounceRef.current = setTimeout(() => {
            fetchSuggestions(val);
        }, 400);
    };

    const handleSelect = (item: any) => {
        // e.g. "Tokyo, Japan"
        const formatted = `${item.name}${item.admin1 ? `, ${item.admin1}` : ''}${item.country ? `, ${item.country}` : ''}`;
        setQuery(formatted);
        onChange(formatted);
        setIsOpen(false);
        setSuggestions([]);
    };

    return (
        <div ref={wrapperRef} style={{ position: 'relative', width: '100%', ...style }}>
            <div style={{ position: 'relative' }}>
                <input
                    type="text"
                    value={query}
                    onChange={handleInputChange}
                    onFocus={() => {
                        if (suggestions.length > 0) setIsOpen(true);
                    }}
                    placeholder={placeholder || "Search location..."}
                    style={{
                        width: '100%',
                        background: 'transparent',
                        border: 'none',
                        color: C.text,
                        fontSize: 16,
                        outline: 'none',
                        padding: '12px 16px',
                        boxSizing: 'border-box'
                    }}
                />
                {loading && (
                    <div style={{ position: 'absolute', right: 12, top: 12, width: 20, height: 20 }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke={C.cyan} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                        <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
                    </div>
                )}
            </div>

            {isOpen && suggestions.length > 0 && (
                <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    background: C.card3,
                    borderRadius: 12,
                    marginTop: 4,
                    zIndex: 100,
                    overflow: 'hidden',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                    border: `1px solid ${C.border}`
                }}>
                    {suggestions.map((item, idx) => (
                        <div
                            key={item.id || idx}
                            onClick={() => handleSelect(item)}
                            style={{
                                padding: '12px 16px',
                                cursor: 'pointer',
                                borderBottom: idx < suggestions.length - 1 ? `1px solid ${C.border}` : 'none',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            <div style={{ fontWeight: 600, color: C.text, fontSize: 14 }}>{item.name}</div>
                            <div style={{ color: C.textMuted, fontSize: 12 }}>
                                {item.admin1 && `${item.admin1}, `}{item.country}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
