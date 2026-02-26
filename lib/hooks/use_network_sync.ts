'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface UseNetworkSyncOptions {
  /**
   * Chamada assim que o dispositivo volta a ficar online.
   * Deve ser async — o lock só é liberado após a Promise resolver.
   */
  onReconnect?: () => Promise<void>;
  /**
   * Tempo (ms) de espera após o evento 'online' antes de disparar a sync.
   * Redes móveis oscilam: aguardar a estabilização evita rajadas de chamadas.
   * Padrão: 1500 ms.
   */
  debounceMs?: number;
}

export interface NetworkSyncState {
  /** Estado real de conectividade do dispositivo. */
  isOnline: boolean;
  /** true enquanto onReconnect estiver em execução. */
  isSyncing: boolean;
}

export function useNetworkSync({
  onReconnect,
  debounceMs = 1500,
}: UseNetworkSyncOptions = {}): NetworkSyncState {
  // Assume online no servidor (SSR) — hidrata com o valor real no client
  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  // Lock via ref: não usa state para evitar re-renders extras durante a sync
  const isSyncingRef = useRef(false);
  // Ref do timer de debounce para poder cancelá-lo se o sinal cair de novo
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSync = useCallback(async () => {
    // Garante que apenas uma sync rode por vez (lock)
    if (isSyncingRef.current || !onReconnect) return;

    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      await onReconnect();
    } catch (e) {
      console.error('[useNetworkSync] erro durante sync:', e);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [onReconnect]);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    // Debounce: cancela qualquer timer anterior e agenda nova sync
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runSync, debounceMs);
  }, [runSync, debounceMs]);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    // Cancela sync agendada — não adianta tentar sem rede
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  useEffect(() => {
    // SSR guard: window não existe no servidor
    if (typeof window === 'undefined') return;

    // Hidrata com o estado real do dispositivo (pode diferir do true inicial)
    setIsOnline(navigator.onLine);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [handleOnline, handleOffline]);

  return { isOnline, isSyncing };
}
