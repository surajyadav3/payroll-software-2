-- =============================================================
-- Comp off on People / Leave Balances (12 Oct 2026).
--
-- HR sees every employee's comp off next to Earned Leave and can add or
-- remove days with a reason. profiles.comp_off_balance stays the one
-- balance (the app's Home and Leaves screens already read it fresh, so a
-- change shows on the employee's app the next time the screen loads -- no
-- app release needed).
--
-- comp_off_balance is a bare counter with no history, so every HR change
-- is also written to comp_off_adjustments (who, when, how many days, why,
-- balance after). Only HR changes are logged here; credits from the
-- hours rule (20260928_4) and Comp Off leave approvals keep updating the
-- counter as before.
--
-- hr_adjust_comp_off(): HR only (admin incl. HR Support, superadmin), same
-- tenant. Unlike adjust_comp_off_balance it never clamps silently -- taking
-- off more than the employee has is an error, so the log always matches
-- the real change. The row is locked so two HR clicks cannot lose an update.
-- Each change also sends the employee an in-app notice with the new balance.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.comp_off_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  profile_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  days          numeric NOT NULL CHECK (days <> 0),
  balance_after numeric NOT NULL CHECK (balance_after >= 0),
  note          text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comp_off_adjustments_profile
  ON public.comp_off_adjustments (profile_id, created_at DESC);

ALTER TABLE public.comp_off_adjustments ENABLE ROW LEVEL SECURITY;

-- Read: the employee their own rows, HR every row in the tenant.
-- No insert/update/delete policies -- rows are written only by the RPC.
DROP POLICY IF EXISTS "comp_off_adjustments: own or HR can select" ON public.comp_off_adjustments;
CREATE POLICY "comp_off_adjustments: own or HR can select" ON public.comp_off_adjustments
  FOR SELECT TO authenticated
  USING (
    tenant_id = (SELECT my_tenant_id())
    AND (profile_id = (SELECT auth.uid()) OR (SELECT my_role()) IN ('admin', 'superadmin'))
  );

CREATE OR REPLACE FUNCTION public.hr_adjust_comp_off(p_profile_id uuid, p_days numeric, p_note text DEFAULT '')
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant  uuid;
  v_balance numeric;
  v_after   numeric;
BEGIN
  IF p_days IS NULL OR p_days = 0 THEN
    RAISE EXCEPTION 'Enter the number of days';
  END IF;
  IF abs(p_days) > 365 THEN
    RAISE EXCEPTION 'At most 365 days in one change';
  END IF;

  SELECT tenant_id, COALESCE(comp_off_balance, 0) INTO v_tenant, v_balance
  FROM profiles WHERE id = p_profile_id
  FOR UPDATE;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND tenant_id = v_tenant AND role IN ('admin', 'superadmin')
  ) THEN
    RAISE EXCEPTION 'Only HR can change comp off balances';
  END IF;

  v_after := v_balance + p_days;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Cannot remove % day(s) -- the balance is only %', abs(p_days), v_balance;
  END IF;

  UPDATE profiles SET comp_off_balance = v_after WHERE id = p_profile_id;

  INSERT INTO comp_off_adjustments (tenant_id, profile_id, days, balance_after, note, created_by)
  VALUES (v_tenant, p_profile_id, p_days, v_after, COALESCE(left(trim(p_note), 500), ''), auth.uid());

  -- Tell the employee: shows in the app's Notices and Home "Updates" and the
  -- web bell. link_key stays NULL on purpose -- 'leave_requests' would let the
  -- Raniwala team-only filter (trg_team_only_request_notifications) drop the
  -- notice when the employee is a manager/HOD outside HR's "team".
  INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body)
  VALUES (
    v_tenant, p_profile_id, auth.uid(), 'comp_off_updated',
    CASE WHEN p_days > 0 THEN 'Comp off added' ELSE 'Comp off removed' END,
    format('HR %s %s comp off day%s. Your comp off balance is now %s.%s',
      CASE WHEN p_days > 0 THEN 'added' ELSE 'removed' END,
      trim_scale(abs(p_days)), CASE WHEN abs(p_days) = 1 THEN '' ELSE 's' END,
      trim_scale(v_after),
      CASE WHEN COALESCE(trim(p_note), '') <> '' THEN ' Reason: ' || left(trim(p_note), 200) ELSE '' END)
  );

  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.hr_adjust_comp_off(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_adjust_comp_off(uuid, numeric, text) TO authenticated;
