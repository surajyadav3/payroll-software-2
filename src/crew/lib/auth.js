import { useMemo } from 'react';
import { useAuth as useAppAuth } from '@/context/AuthContext';

/**
 * The signed-in person, in the shape the ported screens expect (the platform's `useAuth`).
 * Here an employee is a profile: employee id = profile id.
 *
 * Permissions map onto this app's roles (the server re-checks every action):
 *   HR (admin, superadmin)              — runs review cycles, company goals and KPIs, oversees all work
 *   managers (manager, hod, management) — goals, KPIs and reviews of their reporting tree
 *   everyone                            — their own goals, reviews, tasks and messages
 */
const HR = new Set(['admin', 'superadmin']);
const LEADS = new Set(['manager', 'hod', 'management']);
const HR_ONLY = new Set(['pms.cycle.manage', 'pms.goal.company.manage', 'work.manage', 'work.oversee']);
const FOR_OTHERS = new Set(['pms.goal.manage', 'pms.review.manage', 'pms.kpi.manage']);

export function useAuth() {
    const { profile, tenant, loading } = useAppAuth();
    return useMemo(() => {
        const role = profile?.role ?? null;
        const hr = HR.has(role);
        const leads = hr || LEADS.has(role);
        const name = [profile?.first_name, profile?.middle_name, profile?.last_name].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
        const me = profile
            ? {
                user: { id: profile.id, displayName: name || profile.email || '' },
                tenant: { id: profile.tenant_id ?? tenant?.id ?? null, slug: '', name: tenant?.company_name ?? '' },
                employee: profile.tenant_id ? { id: profile.id, departmentId: profile.department ?? null, locationId: profile.outlet_id ?? null } : null,
                role,
                grants: [],
            }
            : null;
        return {
            status: loading ? 'loading' : me ? 'authenticated' : 'anonymous',
            me,
            /** Holds the permission at any scope. */
            can: (permission) => !!me && (HR_ONLY.has(permission) ? hr : FOR_OTHERS.has(permission) ? leads : true),
            /** Holds it beyond their own records: "manages other people". */
            canForOthers: (permission) => !!me && (HR_ONLY.has(permission) ? hr : leads),
        };
    }, [profile, tenant, loading]);
}
