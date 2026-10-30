import { listAnnouncements } from './announcementService';
import { listPolicies } from './policyService';
import { listKras } from './kraService';
import { listPips } from './pipService';
import { fullName } from '@/lib/helpers';

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + '…' : s || '');

/**
 * One generic "recent updates" feed for the Dashboard, merging every kind of
 * thing that gets "posted" for an employee to notice — announcements,
 * policies, new KRAs, and PIPs — into a single timeline. Each source's own
 * RLS policy already scopes rows to what the caller may see (their own KRAs/
 * PIPs plus company-wide ones for employees, everything for admin/manager),
 * so no extra visibility filtering is needed here.
 *
 * `excludeAnnouncements` / `excludePolicies` drop those sources — Raniwala's
 * Home shows announcements in their own section at the top and policies only
 * on the Policies page (see home/HomePage.jsx; the CrewCore app matches).
 *
 * To add another source later: fetch it, map its rows to the same
 * { id, type, icon, color, title, subtitle, date, link } shape, and push
 * into `items` before the sort below.
 */
export async function fetchRecentUpdates(tenantId, { profileId, limit = 8, excludeAnnouncements = false, excludePolicies = false } = {}) {
  const [annRes, polRes, kraRes, pipRes] = await Promise.allSettled([
    excludeAnnouncements ? Promise.resolve({ data: [] }) : listAnnouncements(tenantId, { limit }),
    excludePolicies ? Promise.resolve({ data: [] }) : listPolicies(tenantId),
    listKras(tenantId, { profileId }),
    listPips(tenantId),
  ]);

  const items = [];

  if (annRes.status === 'fulfilled') {
    for (const a of annRes.value.data || []) {
      items.push({
        id: `announcement-${a.id}`,
        type: 'Announcement',
        icon: 'fa-bullhorn',
        color: 'var(--warning)',
        title: a.title,
        subtitle: truncate(a.body, 90) || (a.author ? `Posted by ${fullName(a.author)}` : ''),
        date: a.created_at,
        link: '/announcements',
      });
    }
  }

  if (polRes.status === 'fulfilled') {
    for (const p of polRes.value.data || []) {
      items.push({
        id: `policy-${p.id}`,
        type: 'Policy',
        icon: 'fa-file-alt',
        color: 'var(--success)',
        title: `New policy: ${p.title}`,
        subtitle: p.author ? `Rolled out by ${fullName(p.author)}` : 'Policy roll-out',
        date: p.created_at,
        link: '/policies',
      });
    }
  }

  if (kraRes.status === 'fulfilled') {
    for (const k of kraRes.value.data || []) {
      items.push({
        id: `kra-${k.id}`,
        type: 'KRA',
        icon: 'fa-bullseye',
        color: 'var(--primary)',
        title: `New KRA: ${k.title}`,
        subtitle: k.scope === 'company' ? 'Company-wide KRA' : (k.profile ? `Assigned to ${fullName(k.profile)}` : 'New KRA assigned'),
        date: k.created_at,
        link: '/performance',
      });
    }
  }

  if (pipRes.status === 'fulfilled') {
    for (const p of pipRes.value.data || []) {
      const isSelf = p.profile_id === profileId;
      items.push({
        id: `pip-${p.id}`,
        type: 'PIP',
        icon: 'fa-triangle-exclamation',
        color: 'var(--danger)',
        title: 'Performance Improvement Plan started',
        subtitle: isSelf ? truncate(p.reason, 90) : (p.employee ? `For ${fullName(p.employee)}` : ''),
        date: p.created_at,
        link: '/performance/pip',
      });
    }
  }

  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return { data: items.slice(0, limit), error: null };
}
