import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { useOutletView } from '@/context/OutletViewContext';
import { useDebounce } from '@/hooks/useDebounce';
import { getActionsForRole } from '@/lib/searchActions';
import { listActiveEmployees } from '@/services/employeeService';
import { fullName, getInitials, getAvatarColor, isHrSupport } from '@/lib/helpers';

// Only roles with an actual employee-directory route get the "Employees"
// result group — an individual employee has no one to look up this way.
const EMPLOYEE_SEARCH_ROLES = ['admin', 'manager'];

export default function GlobalSearch() {
  const { profile, tenant } = useAuth();
  const { isEnabled } = useFeatures();
  const { selectOutlet } = useOutletView();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [employees, setEmployees] = useState([]);
  const ref = useRef(null);
  const debouncedQuery = useDebounce(query, 150);

  const role = profile?.role || 'employee';
  const canSearchEmployees = EMPLOYEE_SEARCH_ROLES.includes(role);

  useEffect(() => {
    if (!canSearchEmployees || !tenant?.id) return;
    listActiveEmployees(tenant.id).then(({ data }) => setEmployees(data || []));
  }, [canSearchEmployees, tenant?.id]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const hrSupport = isHrSupport(profile);
  const actions = useMemo(() => getActionsForRole(role, isEnabled, { hrSupport }), [role, isEnabled, hrSupport]);

  const q = debouncedQuery.trim().toLowerCase();

  const matchedActions = (q.length === 0 ? actions.slice(0, 8) : actions.filter((a) =>
    a.label.toLowerCase().includes(q) || (a.keywords || []).some((k) => k.toLowerCase().includes(q))
  )).slice(0, 8);

  const matchedEmployees = (!canSearchEmployees || q.length === 0) ? [] : employees.filter((e) =>
    fullName(e).toLowerCase().includes(q) || (e.department || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)
    || (e.employee_id || '').toLowerCase().includes(q) || (e.essl_employee_code || '').toLowerCase().includes(q)
  ).slice(0, 5);

  if (!profile) return null;

  const goToAction = (href) => {
    setOpen(false);
    setQuery('');
    navigate(href);
  };

  const goToEmployee = (emp) => {
    setOpen(false);
    setQuery('');
    // The employees list is scoped to whatever outlet is currently selected —
    // a match found tenant-wide here could easily live outside that outlet,
    // which would otherwise land the searcher on a page that says "no
    // employees match" for someone who very much exists. Switching to
    // "All Outlets" guarantees the person search just found is actually there.
    if (role === 'admin') selectOutlet(null);
    const target = role === 'manager' ? '/manager-employees' : '/employees';
    // The EMP CODE is unique, so searching by it lands on exactly this person
    // (a name can be shared); fall back to the name when there's no code.
    navigate(`${target}?q=${encodeURIComponent(emp.employee_id || fullName(emp))}`);
  };

  const hasResults = matchedActions.length > 0 || matchedEmployees.length > 0;

  return (
    <div ref={ref} className="global-search" style={{ position: 'relative', width: 260, flexShrink: 1 }}>
      <div style={{ position: 'relative' }}>
        <i className="fas fa-search" style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          fontSize: 12, color: 'var(--text-muted)', pointerEvents: 'none',
        }} />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); } }}
          placeholder={canSearchEmployees ? 'Search actions, employees or EMP code…' : 'Search actions…'}
          className="global-search-input"
          style={{
            width: '100%', padding: '8px 12px 8px 32px', borderRadius: 20, border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit',
          }}
        />
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: 42, left: 0, width: 'min(320px, calc(100vw - 32px))', maxHeight: '60vh', overflowY: 'auto',
          background: 'var(--popover-bg, #1A1B2E)', border: '1px solid var(--popover-border, rgba(255,255,255,0.1))', borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)', zIndex: 300, padding: 6,
        }}>
          {!hasResults ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--popover-fg-subtle, rgba(255,255,255,0.6))', fontSize: 12 }}>
              {q ? `No matches for "${debouncedQuery}"` : 'Start typing to search…'}
            </div>
          ) : (
            <>
              {matchedEmployees.length > 0 && (
                <>
                  <div className="global-search-group-label">Employees</div>
                  {matchedEmployees.map((e) => (
                    <button key={e.id} onClick={() => goToEmployee(e)} className="global-search-result"
                      onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                      <span style={{
                        width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                        color: '#fff', background: `linear-gradient(135deg, ${getAvatarColor(e.id)})`,
                      }}>
                        {getInitials(e.first_name, e.last_name)}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--popover-fg, #fff)', fontWeight: 600 }}>{fullName(e)}</div>
                        <div style={{ fontSize: 11, color: 'var(--popover-fg-subtle, rgba(255,255,255,0.5))' }}>{[e.employee_id, e.department || 'No department'].filter(Boolean).join(' · ')}</div>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {matchedActions.length > 0 && (
                <>
                  <div className="global-search-group-label">Actions &amp; Features</div>
                  {matchedActions.map((a) => (
                    <button key={a.label} onClick={() => goToAction(a.href)} className="global-search-result"
                      onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                      <span style={{ width: 26, textAlign: 'center', color: 'var(--primary)', flexShrink: 0 }}>
                        <i className={`fas ${a.icon}`} />
                      </span>
                      <div style={{ fontSize: 13, color: 'var(--popover-fg, #fff)', fontWeight: 500 }}>{a.label}</div>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const hoverIn = (e) => { e.currentTarget.style.background = 'var(--popover-hover, rgba(255,255,255,0.06))'; };
const hoverOut = (e) => { e.currentTarget.style.background = 'transparent'; };
