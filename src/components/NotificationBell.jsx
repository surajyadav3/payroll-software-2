import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationContext';
import { resolveNotificationLink } from '@/lib/notificationLinks';

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const { profile } = useAuth();
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!profile) return null;

  const handleRowClick = (n) => {
    setOpen(false);
    if (!n.is_read) markRead(n.id);
    const href = resolveNotificationLink(n.link_key, profile.role, n.related_id);
    if (href) navigate(href);
  };

  const recent = notifications.slice(0, 8);

  return (
    <div ref={ref} className="notification-bell-wrap" style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        title="Notifications"
        style={{
          position: 'relative', width: 38, height: 38, borderRadius: '50%', border: '1px solid var(--border)',
          background: 'var(--surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <i className="fas fa-bell" style={{ fontSize: 15, color: 'var(--text)' }} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 999,
              background: 'var(--danger)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="notification-panel"
          style={{
            position: 'absolute', top: 46, right: 0, width: 340, maxHeight: 440, overflowY: 'auto',
            background: 'var(--popover-bg, #1A1B2E)', border: '1px solid var(--popover-border, rgba(255,255,255,0.1))', borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)', zIndex: 300, padding: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px' }}>
            <strong style={{ fontSize: 13, color: 'var(--popover-fg, #fff)' }}>Notifications</strong>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                Mark all as read
              </button>
            )}
          </div>

          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--popover-fg-subtle, rgba(255,255,255,0.6))', fontSize: 12 }}>Loading…</div>
          ) : recent.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--popover-fg-subtle, rgba(255,255,255,0.6))', fontSize: 12 }}>You're all caught up.</div>
          ) : (
            recent.map((n) => (
              <button
                key={n.id}
                onClick={() => handleRowClick(n)}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'left',
                  padding: 10, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--popover-hover, rgba(255,255,255,0.06))'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span
                  style={{
                    marginTop: 5, width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: n.is_read ? 'transparent' : 'var(--primary)',
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: n.is_read ? 400 : 700, color: 'var(--popover-fg, #fff)' }}>{n.title}</div>
                  {n.body && <div style={{ fontSize: 12, color: 'var(--popover-fg-muted, rgba(255,255,255,0.65))', marginTop: 2 }}>{n.body}</div>}
                  <div style={{ fontSize: 11, color: 'var(--popover-fg-subtle, rgba(255,255,255,0.45))', marginTop: 3 }}>{timeAgo(n.created_at)}</div>
                </div>
              </button>
            ))
          )}

          <div style={{ borderTop: '1px solid var(--popover-border, rgba(255,255,255,0.1))', marginTop: 4, padding: '8px 10px', textAlign: 'center' }}>
            <button
              onClick={() => { setOpen(false); navigate('/notifications'); }}
              style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', fontWeight: 600, padding: 0 }}
            >
              View all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
