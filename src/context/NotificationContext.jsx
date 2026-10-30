import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { listMyNotifications, countUnread, markRead as svcMarkRead, markAllRead as svcMarkAllRead } from '@/services/notificationService';
import { supabase } from '@/lib/supabase';
import { ATTENDANCE_NOTICE_TYPES, emitAttendanceChanged } from '@/lib/attendanceEvents';

const NotificationContext = createContext({});

// Polling stays as the fallback; on top of it a realtime feed of this
// person's own new notifications (app_notifications is in the realtime
// publication since 20261016_1, same feed the mobile app listens to) reloads
// the bell at once and tells open attendance screens to reload when an
// approval / scan changed the day.
const POLL_MS = 45000;

export function NotificationProvider({ children }) {
  const { profile } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!profile?.id) {
      setNotifications([]);
      setUnreadCount(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [{ data }, { count }] = await Promise.all([
      listMyNotifications(profile.id),
      countUnread(profile.id),
    ]);
    setNotifications(data || []);
    setUnreadCount(count || 0);
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!profile?.id) return undefined;
    const channel = supabase
      .channel(`my-notifications-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'app_notifications', filter: `profile_id=eq.${profile.id}` },
        (payload) => {
          load();
          if (ATTENDANCE_NOTICE_TYPES.includes(payload.new?.type)) emitAttendanceChanged();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, load]);

  const markRead = useCallback(async (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id && !n.is_read ? { ...n, is_read: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    await svcMarkRead(id);
  }, []);

  const markAllRead = useCallback(async () => {
    if (!profile?.id) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    await svcMarkAllRead(profile.id);
  }, [profile?.id]);

  const value = useMemo(() => ({
    notifications, unreadCount, loading, refresh: load, markRead, markAllRead,
  }), [notifications, unreadCount, loading, load, markRead, markAllRead]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationContext);
