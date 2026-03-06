'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { WallboardState } from '@/types/wallboard';

const SSE_URL = '/api/sse/wallboard';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

interface UseWallboardSSEResult {
  data: WallboardState | null;
  isConnected: boolean;
  lastUpdate: Date | null;
  error: string | null;
  dataMode: 'polling' | 'realtime';
}

/**
 * React hook that connects to the wallboard SSE endpoint and returns
 * live-updating WallboardState.
 *
 * Features:
 * - Auto-reconnects with exponential backoff on disconnect
 * - Resets backoff on successful connection
 * - Ignores heartbeat messages
 * - Cleans up on unmount
 */
export function useWallboardSSE(): UseWallboardSSEResult {
  const [data, setData] = useState<WallboardState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataMode, setDataMode] = useState<'polling' | 'realtime'>('polling');

  const eventSourceRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    // Don't connect if unmounted or already connected
    if (!mountedRef.current) return;
    if (eventSourceRef.current?.readyState === EventSource.OPEN) return;

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource(SSE_URL);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setIsConnected(true);
      setError(null);
      // Reset backoff on successful connection
      backoffRef.current = MIN_BACKOFF_MS;
    };

    es.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;

      try {
        const parsed = JSON.parse(event.data);

        // Ignore heartbeat messages
        if (parsed?.type === 'heartbeat') return;

        // Validate it's a WallboardState (has required fields)
        if (parsed && typeof parsed.lastUpdated === 'string' && 'queues' in parsed) {
          const state = parsed as WallboardState;
          setData(state);
          setLastUpdate(new Date());
          setDataMode(state.dataMode ?? 'polling');

          // Update connection status from server state
          if (state.connectionStatus === 'error') {
            setError('PBX connection error');
          } else {
            setError(null);
          }
        }
      } catch {
        // Malformed JSON -- ignore silently
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;

      setIsConnected(false);

      // EventSource will auto-close on certain errors (e.g. 401)
      // ReadyState 2 = CLOSED
      if (es.readyState === EventSource.CLOSED) {
        setError('Connection lost');
        es.close();
        eventSourceRef.current = null;
        scheduleReconnect();
      }
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    // Clear any existing reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }

    const delay = backoffRef.current;
    backoffRef.current = Math.min(delay * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (mountedRef.current) {
        connect();
      }
    }, delay);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      // Clear reconnect timer
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      // Close EventSource
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect]);

  return { data, isConnected, lastUpdate, error, dataMode };
}
