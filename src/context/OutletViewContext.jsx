import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { listOutlets } from '@/services/tenantService';

const OutletViewContext = createContext({});

const storageKey = (tenantId, profileId) => `outlet_view:${tenantId}:${profileId}`;
const requestStorageKey = (tenantId, profileId) => `request_outlets:${tenantId}:${profileId}`;

export function OutletViewProvider({ children }) {
  const { tenant, profile } = useAuth();
  const canScope = profile?.role === 'admin' || profile?.role === 'superadmin';

  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState(undefined); // undefined = not loaded yet
  const [outletProfileIds, setOutletProfileIds] = useState(null);
  const [ready, setReady] = useState(false);
  // The Requests pages' own pick: any mix of ticked outlets (Set of ids), not
  // the single app-wide outlet. null until a Requests page first asks for it,
  // so nothing is fetched for it elsewhere.
  const [requestOutletIds, setRequestOutletIds] = useState(null);
  const [requestProfileIds, setRequestProfileIds] = useState(undefined); // undefined = loading, null = every outlet

  // Load outlets + restore the stored selection whenever the tenant changes.
  useEffect(() => {
    if (!tenant?.id || !profile?.id) return;
    if (!canScope) {
      setOutlets([]);
      setSelectedOutletId(null);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    listOutlets(tenant.id).then(({ data }) => {
      if (cancelled) return;
      setOutlets(data || []);
      const stored = localStorage.getItem(storageKey(tenant.id, profile.id));
      if (stored === null) {
        setSelectedOutletId(undefined); // still "not chosen yet" — triggers the gate
      } else {
        setSelectedOutletId(stored === 'combined' ? null : stored);
      }
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [tenant?.id, profile?.id, canScope]);

  // Re-fetch the outlets list in place (e.g. after saving per-outlet settings like
  // geofencing) without disturbing the current selection.
  const refreshOutlets = useCallback(async () => {
    if (!tenant?.id || !canScope) return;
    const { data } = await listOutlets(tenant.id);
    setOutlets(data || []);
  }, [tenant?.id, canScope]);

  // Recompute the outlet's employee-id set whenever the selection changes.
  useEffect(() => {
    if (!tenant?.id || !selectedOutletId) {
      setOutletProfileIds(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('id')
      .eq('tenant_id', tenant.id)
      // Employees with no outlet assigned yet (outlet_id IS NULL — e.g. newly
      // imported, or an admin/manager who was never assigned a branch) don't
      // belong to any single outlet, so their records would otherwise vanish
      // from every outlet-scoped view (visible only under "Combined") even
      // though nobody chose to hide them. Folding them into every outlet's
      // set instead means they're never silently invisible.
      .or(`outlet_id.eq.${selectedOutletId},outlet_id.is.null`)
      .then(({ data }) => {
        if (!cancelled) setOutletProfileIds(new Set((data || []).map((r) => r.id)));
      });
    return () => { cancelled = true; };
  }, [tenant?.id, selectedOutletId]);

  const selectOutlet = useCallback((id) => {
    if (!tenant?.id || !profile?.id) return;
    localStorage.setItem(storageKey(tenant.id, profile.id), id || 'combined');
    setSelectedOutletId(id || null);
  }, [tenant?.id, profile?.id]);

  // First Requests page opened: the stored ticks, else the app-wide outlet
  // (Combined = every outlet ticked).
  const initRequestOutlets = useCallback(() => {
    if (!ready || requestOutletIds || !tenant?.id || !profile?.id) return;
    const known = new Set(outlets.map((o) => o.id));
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(requestStorageKey(tenant.id, profile.id)) || '[]').filter((id) => known.has(id)); } catch { ids = []; }
    if (!ids.length) ids = selectedOutletId && known.has(selectedOutletId) ? [selectedOutletId] : [...known];
    setRequestOutletIds(new Set(ids));
  }, [ready, requestOutletIds, tenant?.id, profile?.id, outlets, selectedOutletId]);

  const selectRequestOutlets = useCallback((ids) => {
    if (!tenant?.id || !profile?.id || !ids.size) return;
    localStorage.setItem(requestStorageKey(tenant.id, profile.id), JSON.stringify([...ids]));
    setRequestOutletIds(new Set(ids));
  }, [tenant?.id, profile?.id]);

  // Ticked outlets -> employee ids; every outlet ticked (or no outlets) = no
  // filter. No-outlet staff are kept in, same as the single-outlet set above.
  useEffect(() => {
    if (!ready) return;
    if (!canScope || !outlets.length) { setRequestProfileIds(null); return; }
    if (!requestOutletIds) return;
    if (outlets.every((o) => requestOutletIds.has(o.id))) { setRequestProfileIds(null); return; }
    let cancelled = false;
    setRequestProfileIds(undefined);
    supabase
      .from('profiles')
      .select('id')
      .eq('tenant_id', tenant.id)
      .or(`outlet_id.in.(${[...requestOutletIds].join(',')}),outlet_id.is.null`)
      .then(({ data }) => {
        if (!cancelled) setRequestProfileIds(new Set((data || []).map((r) => r.id)));
      });
    return () => { cancelled = true; };
  }, [ready, canScope, outlets, requestOutletIds, tenant?.id]);

  const selectedOutletName = selectedOutletId
    ? outlets.find((o) => o.id === selectedOutletId)?.name || ''
    : '';

  const needsSelection = ready && canScope && outlets.length > 0 && selectedOutletId === undefined;

  const value = useMemo(() => ({
    outlets,
    selectedOutletId: selectedOutletId || null,
    selectedOutletName,
    outletProfileIds,
    needsSelection,
    ready,
    selectOutlet,
    refreshOutlets,
    requestOutletIds,
    requestProfileIds,
    initRequestOutlets,
    selectRequestOutlets,
  }), [outlets, selectedOutletId, selectedOutletName, outletProfileIds, needsSelection, ready, selectOutlet, refreshOutlets,
    requestOutletIds, requestProfileIds, initRequestOutlets, selectRequestOutlets]);

  return (
    <OutletViewContext.Provider value={value}>
      {children}
    </OutletViewContext.Provider>
  );
}

export const useOutletView = () => useContext(OutletViewContext);

// For the Requests pages: the ticked outlets' employee ids — a Set to filter
// by, null for every outlet, undefined while it is still loading (skip the fetch).
export function useRequestOutletScope() {
  const { requestProfileIds, initRequestOutlets } = useContext(OutletViewContext);
  useEffect(() => { initRequestOutlets?.(); }, [initRequestOutlets]);
  return requestProfileIds;
}
