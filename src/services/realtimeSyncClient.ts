export interface RealtimeSyncEvent {
  eventId: string;
  type:
    | 'payment:settled'
    | 'maintenance:message'
    | 'maintenance:ticket'
    | 'approval:decided'
    | 'sms:dispatched'
    | 'notice:published'
    | 'state:synced'
    | 'state:reset';
  ownerId: string;
  originClientId?: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const CLIENT_ID = `CLI-${Math.random().toString(36).slice(2, 9)}`;
const seenEvents = new Set<string>();
const listeners = new Set<(ev: RealtimeSyncEvent) => void>();

let socket: WebSocket | null = null;
let broadcastChannel: BroadcastChannel | null = null;
let reconnectTimer: number | null = null;
let initialized = false;
let connecting = false;

export function getRealtimeClientId(): string {
  return CLIENT_ID;
}

function initBroadcastChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' || broadcastChannel) {
    return;
  }
  try {
    broadcastChannel = new BroadcastChannel('ad-prms-sync');
    broadcastChannel.onmessage = (e) => {
      const ev = e.data as RealtimeSyncEvent | undefined;
      if (ev && ev.eventId) dispatchToListeners(ev);
    };
  } catch {
    // BroadcastChannel unavailable
  }
}

import { getStoredJwtTokens, WS_BASE_URL } from './productionApiClient';

async function connectSocket() {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
  if (!window.location?.host || !window.location.protocol.startsWith('http')) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  connecting = true;
  try {
    let wsUrl = '';
    const jwt = getStoredJwtTokens()?.access;

    if (WS_BASE_URL && jwt) {
      wsUrl = `${WS_BASE_URL}/ws/sync/?token=${encodeURIComponent(jwt)}`;
    } else {
      // Only open local WS when Express /api/health confirms the backend WS hub is active
      if (typeof fetch === 'function') {
        const probe = await fetch('/api/health', { cache: 'no-store' });
        const contentType = probe.headers.get('content-type') || '';
        if (!probe.ok || !contentType.includes('application/json')) {
          return;
        }
        const health = (await probe.json()) as { ok?: boolean; ws?: string };
        if (!health?.ok) return;
      }
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${window.location.host}/ws`;
    }

    const ws = new WebSocket(wsUrl);
    socket = ws;

    ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data)) as {
          kind?: string;
          event?: RealtimeSyncEvent;
          recentEvents?: RealtimeSyncEvent[];
        };
        if (parsed.kind === 'sync:event' && parsed.event) {
          dispatchToListeners(parsed.event);
        } else if (parsed.kind === 'sync:hello' && Array.isArray(parsed.recentEvents)) {
          parsed.recentEvents.forEach(dispatchToListeners);
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      socket = null;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        void connectSocket();
      }, 3000);
    };

    ws.onerror = () => {
      // Handled gracefully by onclose reconnect backoff
    };
  } catch {
    // Static preview or offline mode — BroadcastChannel handles local tab sync cleanly
  } finally {
    connecting = false;
  }
}

function dispatchToListeners(ev: RealtimeSyncEvent) {
  if (!ev.eventId || seenEvents.has(ev.eventId)) return;
  seenEvents.add(ev.eventId);
  if (ev.originClientId === CLIENT_ID) return;
  listeners.forEach((cb) => cb(ev));
}

export function subscribeRealtimeEvents(handler: (ev: RealtimeSyncEvent) => void): () => void {
  listeners.add(handler);
  if (!initialized && typeof window !== 'undefined') {
    initialized = true;
    initBroadcastChannel();
    void connectSocket();
    window.addEventListener('online', () => {
      void connectSocket();
    });
  }
  return () => {
    listeners.delete(handler);
  };
}

export function publishRealtimeEvent(
  event: Omit<RealtimeSyncEvent, 'eventId' | 'originClientId' | 'timestamp'>
): boolean {
  const fullEvent: RealtimeSyncEvent = {
    ...event,
    eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    originClientId: CLIENT_ID,
    timestamp: new Date().toISOString(),
  };
  seenEvents.add(fullEvent.eventId);

  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(fullEvent);
    } catch {
      // Ignore
    }
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ kind: 'sync:publish', event: fullEvent }));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
