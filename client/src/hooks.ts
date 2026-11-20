import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, resyncClock, serverNow } from './api';

/** Re-renders every `ms` and returns the current server-anchored time. */
export function useServerNow(ms = 1000): number {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Keeps the server clock in sync: periodically, when the connection returns and when the tab regains focus. */
export function useClockSync(intervalMs = 30_000) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const sync = () => resyncClock().then(() => setOnline(true)).catch(() => setOnline(false));
    sync();
    const id = setInterval(sync, intervalMs);
    const onOnline = () => { setOnline(true); sync(); };
    const onOffline = () => setOnline(false);
    const onVis = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs]);
  return online;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => fnRef.current().then((d) => { setData(d); setError(null); }).catch((e) => setError(e)), []);
  useEffect(() => {
    reload();
    if (!refreshMs) return;
    const id = setInterval(reload, refreshMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload, setData };
}
