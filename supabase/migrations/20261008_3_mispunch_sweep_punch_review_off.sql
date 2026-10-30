-- =============================================================
-- Mispunch sweep: make the trigger keep 'Mispunch' (8 Oct 2026).
--
-- Bug: 20261008_2's backfill turned ~150 single-punch Raniwala days
-- (25 Sep - 7 Oct) into 'Absent' instead of 'Mispunch'.
-- trg_recompute_attendance_from_punches does
--   v_forced := current_setting('app.punch_review', true) = 'on';
-- which is NULL when the setting was never set in the session, so its
--   IF NEW.status = 'Mispunch' AND NOT v_forced AND <=1 punch THEN RETURN NEW
-- guard is skipped and the day is re-scored on hours (0 h -> Absent).
--
-- Fix: both sweep functions set app.punch_review = 'off' for their own
-- transaction first, so v_forced is false and the guard keeps Mispunch.
-- Then re-run the 25 Sep .. yesterday backfill: every day it broke is
-- 'Absent' with exactly one punch, which mark_mispunches picks up.
-- =============================================================

CREATE OR REPLACE FUNCTION mark_mispunches(p_date date)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM set_config('app.punch_review', 'off', true);
  UPDATE attendance a
  SET status = 'Mispunch'
  FROM tenants t
  WHERE t.id = a.tenant_id
    AND t.mark_single_punch_mispunch
    AND a.date = p_date
    AND a.status IN ('Present','Late','Half Day','Absent')
    AND (SELECT count(*) FROM punches pu WHERE pu.attendance_id = a.id) = 1;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION mark_mispunches(date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION mark_mispunches_for(p_date date, p_overtime boolean)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM set_config('app.punch_review', 'off', true);
  UPDATE attendance a
  SET status = 'Mispunch'
  FROM tenants t, profiles p
  WHERE t.id = a.tenant_id
    AND p.id = a.profile_id
    AND t.mark_single_punch_mispunch
    AND COALESCE(p.overtime_applicable, false) = p_overtime
    AND a.date = p_date
    AND a.status IN ('Present','Late','Half Day','Absent')
    AND (SELECT count(*) FROM punches pu WHERE pu.attendance_id = a.id) = 1;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION mark_mispunches_for(date, boolean) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_day   date := '2026-09-25';
  v_total int  := 0;
BEGIN
  WHILE v_day < (now() AT TIME ZONE 'Asia/Kolkata')::date LOOP
    v_total := v_total + mark_mispunches(v_day);
    v_day := v_day + 1;
  END LOOP;
  RAISE NOTICE 'Marked % single-punch day(s) as Mispunch', v_total;
END $$;
