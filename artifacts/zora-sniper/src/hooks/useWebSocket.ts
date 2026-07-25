import { useEffect, useRef, useCallback } from 'react';

type WebSocketMessage = {
  type: string;
  payload: unknown;
};

type SubscriberCallback = (payload: any) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef<Map<string, Set<SubscriberCallback>>>(new Map());
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);
        const subs = subscribersRef.current.get(data.type);
        if (subs) {
          subs.forEach((cb) => cb(data.payload));
        }
      } catch (e) {
        console.error('WebSocket message parsing error:', e);
      }
    };

    ws.onclose = () => {
      const attempts = reconnectAttemptsRef.current;
      const delay = Math.min(10000, Math.pow(2, attempts) * 1000);
      reconnectAttemptsRef.current += 1;
      
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = (error) => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const subscribe = useCallback((type: string, callback: SubscriberCallback) => {
    if (!subscribersRef.current.has(type)) {
      subscribersRef.current.set(type, new Set());
    }
    subscribersRef.current.get(type)!.add(callback);

    return () => {
      const subs = subscribersRef.current.get(type);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          subscribersRef.current.delete(type);
        }
      }
    };
  }, []);

  return { subscribe };
}
