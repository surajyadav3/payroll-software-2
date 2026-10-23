-- =============================================================
-- Raniwala Earned Leave: joining-month credit 1.5 / 1 / 0.5 / 0 (23 Oct 2026).
--
-- HR changed the joining-month rule from 20261021_6 (1–15 / 16–25 / 26+):
--   joined on the 1st–10th  = 1.5
--   joined on the 11th–18th = 1
--   joined on the 19th–26th = 0.5
--   joined on the 27th+     = nothing for that month
-- The 1.5 on the 1st of every following month is unchanged, and so is
-- everything else in sync_joining_leave_credit / run_monthly_leave_accrual:
-- they read the amount from joining_month_leave_credit, so new joiners in
-- any month get the new slabs from here on.
--
-- Existing September / October joiners: their joining-month credit row is
-- set to the new amount (removed when it is now 0, added when it was 0 and
-- now isn't). Monthly credits and leave taken are not touched, so this also
-- covers a joiner who has already taken leave (464). Inactive employees and
-- HR Support logins are not touched. Re-runnable.
-- =============================================================

COMMENT ON COLUMN leave_types.joining_credit_from IS
  'Monthly-accrual types: employees joining on/after this date get a joining-month credit (1st-10th = 1.5, 11th-18th = 1, 19th-26th = 0.5, 27th+ = 0) and the monthly credit for every month since. NULL = off.';

-- ── 1. New amounts ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION joining_month_leave_credit(p_join date)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(day FROM p_join) <= 10 THEN 1.5
              WHEN extract(day FROM p_join) <= 18 THEN 1
              WHEN extract(day FROM p_join) <= 26 THEN 0.5
              ELSE 0 END::numeric;
$$;

-- ── 2. Existing joiners ────────────────────────────────────────
-- Joining credit changed amount.
UPDATE leave_ledger l
SET days = joining_month_leave_credit(p.join_date)
FROM profiles p, leave_types lt
WHERE l.profile_id = p.id AND l.leave_type_id = lt.id
  AND lt.joining_credit_from IS NOT NULL AND p.tenant_id = lt.tenant_id
  AND p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
  AND p.join_date >= lt.joining_credit_from
  AND l.entry_type = 'Accrual' AND l.created_by IS NULL AND l.leave_request_id IS NULL
  AND l.note LIKE '% joining month credit (joined %'
  AND joining_month_leave_credit(p.join_date) > 0
  AND l.days <> joining_month_leave_credit(p.join_date);

-- Joining credit is now nothing (joined the 27th or later).
DELETE FROM leave_ledger l
USING profiles p, leave_types lt
WHERE l.profile_id = p.id AND l.leave_type_id = lt.id
  AND lt.joining_credit_from IS NOT NULL AND p.tenant_id = lt.tenant_id
  AND p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
  AND p.join_date >= lt.joining_credit_from
  AND l.entry_type = 'Accrual' AND l.created_by IS NULL AND l.leave_request_id IS NULL
  AND l.note LIKE '% joining month credit (joined %'
  AND joining_month_leave_credit(p.join_date) = 0;

-- Joining credit was nothing and now isn't (joined the 26th).
INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, effective_date, note)
SELECT lt.tenant_id, p.id, lt.id, 'Accrual', joining_month_leave_credit(p.join_date), p.join_date,
       to_char(p.join_date, 'FMMonth YYYY') || ' joining month credit (joined '
         || to_char(p.join_date, 'FMDD Mon') || ')'
FROM profiles p
JOIN leave_types lt ON lt.tenant_id = p.tenant_id AND lt.joining_credit_from IS NOT NULL
WHERE p.status = 'Active' AND NOT COALESCE(p.hr_support, false)
  AND p.join_date >= lt.joining_credit_from
  AND p.join_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date
  AND joining_month_leave_credit(p.join_date) > 0
  AND NOT EXISTS (
    SELECT 1 FROM leave_ledger l
    WHERE l.profile_id = p.id AND l.leave_type_id = lt.id AND l.entry_type = 'Accrual'
      AND l.note LIKE '% joining month credit (joined %'
  );
