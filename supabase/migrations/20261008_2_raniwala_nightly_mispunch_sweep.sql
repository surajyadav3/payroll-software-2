-- =============================================================
-- Single-punch day => Mispunch: run it every night (8 Oct 2026).
--
-- Bug: RITIK JAIN (Raniwala, 394) clocked in once from the app on Sun
-- 4 Oct and never clocked out; the day still showed 'Present' with 0 h.
-- About 160 Raniwala days from 25 Sep onward were the same, both app and
-- ESSL device punches.
--
-- Cause: 20260925_2 put mark_mispunches() at the end of
-- mark_attendance_from_punches(), the nightly absent sweep, but that cron
-- ('attendance-nightly-absent-sweep') is not scheduled on prod. The one
-- nightly job that does run, essl-finalize-yesterday, deliberately skips
-- single-punch days (p_rescore), and an app punch only gets re-scored when a
-- punch is added or reviewed. So once 20260925_4's Sept backfill ran, nothing
-- turned a closed one-punch day into Mispunch.
--
-- Fix (user rule): every midnight, check the day that just ended; an
-- employee with only one punch that day -> Mispunch. OT employees
-- (profiles.overtime_applicable) may still be working past midnight, so
-- they're checked later, at 04:00 IST (latest Raniwala shift ends 21:00,
-- top OT slab is 5h+; no overnight shifts).
--   * raniwala-mispunch-midnight  00:05 IST (18:35 UTC) -> non-OT employees
--   * raniwala-mispunch-ot        04:00 IST (22:30 UTC) -> OT employees
-- Both judge (IST today - 1). Only tenants with mark_single_punch_mispunch
-- (Raniwala), and only punch-derived statuses Present/Late/Half Day/Absent;
-- Leave, comp off and Pending Approval are left alone. A later second punch
-- (a late device sync, an approved regularize) re-scores the day as before.
--
-- Backfill 25 Sep .. yesterday (20260925_4 already covered 1-24 Sep).
-- =============================================================

CREATE OR REPLACE FUNCTION mark_mispunches_for(p_date date, p_overtime boolean)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
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
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job
  WHERE jobname IN ('raniwala-mispunch-midnight', 'raniwala-mispunch-ot');
END $$;

SELECT cron.schedule('raniwala-mispunch-midnight', '35 18 * * *', $$
  SELECT mark_mispunches_for((now() AT TIME ZONE 'Asia/Kolkata')::date - 1, false);
$$);

SELECT cron.schedule('raniwala-mispunch-ot', '30 22 * * *', $$
  SELECT mark_mispunches_for((now() AT TIME ZONE 'Asia/Kolkata')::date - 1, true);
$$);

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
