import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './auth';

/**
 * Live messages without polling: one Supabase Realtime subscription per browser tab on
 * work_messages (shared by every screen that is listening, closed when the last one leaves).
 *
 * The server only delivers rows of channels this person can see (RLS on work_messages), and the
 * filter keeps other companies' traffic from ever being checked for this client. The event is
 * used as a signal — "something changed in channel X" — and the screen then reads the formatted
 * messages through the API, so what is shown always went through the same rules.
 *
 * onChange(row, eventType): row is the changed work_messages row (snake_case columns).
 */
const listeners = new Set();
let channel = null;
let channelTenant = null;

function open(tenant) {
    channelTenant = tenant;
    channel = supabase
        .channel(`work-messages-${tenant}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'work_messages', filter: `tenant_id=eq.${tenant}` }, (payload) => {
            const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
            for (const l of listeners) l(row ?? {}, payload.eventType);
        })
        .subscribe((status) => {
            // After a dropped connection comes back, anything missed meanwhile is fetched once.
            if (status === 'SUBSCRIBED') for (const l of listeners) l({}, 'RESYNC');
        });
}

function close() {
    if (channel) void supabase.removeChannel(channel);
    channel = null;
    channelTenant = null;
}

export function useLiveMessages(onChange, enabled = true) {
    const { me } = useAuth();
    const tenant = me?.tenant.id ?? null;
    const cb = useRef(onChange);
    useEffect(() => {
        cb.current = onChange;
    });
    useEffect(() => {
        if (!tenant || !enabled) return undefined;
        const fn = (row, type) => cb.current(row, type);
        listeners.add(fn);
        if (channel && channelTenant !== tenant) close();
        if (!channel) open(tenant);
        return () => {
            listeners.delete(fn);
            if (!listeners.size) close();
        };
    }, [tenant, enabled]);
}
