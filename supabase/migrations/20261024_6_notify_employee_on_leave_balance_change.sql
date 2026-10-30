-- =============================================================
-- HR's Leave Balances +/- reaches the employee straight away (24 Oct 2026).
--
-- "Whatever the balance is in the HR portal for leave balances and comp
-- off, if I change someone the employee immediately gets it on the app and
-- can apply."
--
-- Both balances were already one source: the app and the HR page read the
-- same leave_ledger (Earned Leave) and profiles.comp_off_balance (Comp Off).
-- What was missing: a Comp Off change told the employee (hr_adjust_comp_off,
-- 20261012_3) but an Earned Leave change did not. allocate_leave now writes
-- the same kind of app_notifications row, so the employee gets the notice +
-- push, and the open app (realtime on app_notifications) reloads its
-- balances on 'leave_balance_updated' / 'comp_off_updated'.
--
-- allocate_leave's only caller is the HR Leave Balances page. Body below is
-- the live definition unchanged, plus the notice.
-- =============================================================

CREATE OR REPLACE FUNCTION public.allocate_leave(p_profile_id uuid, p_leave_type_id uuid, p_days numeric, p_entry_type text DEFAULT 'Allocation'::text, p_note text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant  uuid;
  v_type    text;
  v_balance numeric;
BEGIN
  IF p_entry_type NOT IN ('Allocation','Accrual','Carry Forward') THEN
    RAISE EXCEPTION 'Use record_leave_deduction / record_leave_encashment for those entry types';
  END IF;
  SELECT tenant_id INTO v_tenant FROM profiles WHERE id = p_profile_id;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND tenant_id = v_tenant AND role IN ('admin','manager','superadmin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO leave_ledger (tenant_id, profile_id, leave_type_id, entry_type, days, note, created_by)
  VALUES (v_tenant, p_profile_id, p_leave_type_id, p_entry_type, p_days, p_note, auth.uid());

  -- Tell the employee, like hr_adjust_comp_off. link_key stays NULL for the
  -- same reason (the Raniwala team-only filter would drop a 'leave_requests'
  -- notice for a manager/HOD outside HR's team).
  IF p_days <> 0 THEN
    SELECT name INTO v_type FROM leave_types WHERE id = p_leave_type_id;
    SELECT COALESCE(sum(days), 0) INTO v_balance
    FROM leave_ledger WHERE profile_id = p_profile_id AND leave_type_id = p_leave_type_id;

    INSERT INTO app_notifications (tenant_id, profile_id, actor_id, type, title, body)
    VALUES (
      v_tenant, p_profile_id, auth.uid(), 'leave_balance_updated',
      format('%s %s', COALESCE(v_type, 'Leave'), CASE WHEN p_days > 0 THEN 'added' ELSE 'removed' END),
      format('HR %s %s %s day%s. Your %s balance is now %s.%s',
        CASE WHEN p_days > 0 THEN 'added' ELSE 'removed' END,
        trim_scale(abs(p_days)), COALESCE(v_type, 'leave'), CASE WHEN abs(p_days) = 1 THEN '' ELSE 's' END,
        COALESCE(v_type, 'leave'), trim_scale(v_balance),
        CASE WHEN COALESCE(trim(p_note), '') <> '' THEN ' Reason: ' || left(trim(p_note), 200) ELSE '' END)
    );
  END IF;
END;
$function$;
