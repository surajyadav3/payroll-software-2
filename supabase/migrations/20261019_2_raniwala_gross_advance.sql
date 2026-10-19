-- =============================================================
-- Raniwala: "Gross Advance" (19 Oct 2026).
--
-- HR: staff paid on a lower actual gross keep the monthly (structure) gross
-- for PF / ESIC, and the difference is what HR's sheet calls the cash
-- advance ("Cash Ad"). Name it Gross Advance and store that difference for
-- every employee.
--
--   employee_salaries.gross_advance        monthly gross - actual gross,
--                                          0 when there is no actual gross
--                                          (or it is not below the gross).
--   employee_salary_history.gross_advance  the same, for each recorded change.
--
-- Both are generated columns, so the stored figure always follows gross and
-- actual_gross whoever writes them (set_employee_salary, the profiles.ctc
-- trigger, imports). It is the full-month figure; the amount deducted in a
-- month is that difference for the days paid, kept per payslip in
-- breakdown.raniwala.actualGrossDiff.
--
-- The payroll deduction line was "Salary Adjustment" (17 Oct); it is now
-- "Gross Advance". The September 2026 slips already processed (held, not
-- released) store the old name in breakdown.deductions, so it is renamed
-- there too. The web takes the name from RANIWALA_LABELS.adjustment.
-- =============================================================

ALTER TABLE public.employee_salaries
  ADD COLUMN IF NOT EXISTS gross_advance numeric(12,2)
  GENERATED ALWAYS AS (
    CASE WHEN actual_gross > 0 AND actual_gross < gross THEN gross - actual_gross ELSE 0 END
  ) STORED;

COMMENT ON COLUMN public.employee_salaries.gross_advance IS
  'Gross Advance: monthly gross - actual gross (0 without an actual gross). Payroll deducts it for the days paid (20261019_2).';

ALTER TABLE public.employee_salary_history
  ADD COLUMN IF NOT EXISTS gross_advance numeric(12,2)
  GENERATED ALWAYS AS (
    CASE WHEN actual_gross > 0 AND actual_gross < gross THEN gross - actual_gross ELSE 0 END
  ) STORED;

COMMENT ON COLUMN public.employee_salary_history.gross_advance IS
  'Gross Advance after this change: gross - actual gross (20261019_2).';

-- Stored Raniwala slips: rename the deduction line, nothing else changes.
-- (Other tenants' slips are left alone, even with a line of that name.)
UPDATE public.payslips ps
SET breakdown = jsonb_set(
  ps.breakdown, '{deductions}',
  (SELECT jsonb_agg(
            CASE WHEN d->>'name' = 'Salary Adjustment'
                 THEN jsonb_set(d, '{name}', '"Gross Advance"') ELSE d END
            ORDER BY o)
     FROM jsonb_array_elements(ps.breakdown->'deductions') WITH ORDINALITY AS x(d, o))
)
WHERE ps.breakdown ? 'raniwala'
  AND jsonb_typeof(ps.breakdown->'deductions') = 'array'
  AND ps.breakdown->'deductions' @> '[{"name": "Salary Adjustment"}]';
