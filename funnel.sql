-- =====================================================================
-- GlobalIQ — funnel drop-off tracking
-- Run AFTER schema.sql, in Supabase → SQL Editor.
-- =====================================================================

-- Mark how far each customer got. Email submission is already implied by the
-- row existing (created_at). We add a marker for reaching the payment screen
-- and for clicking the pay button, so you can see exactly where people drop.
alter table public.customers
  add column if not exists reached_checkout     boolean not null default false,
  add column if not exists reached_checkout_at  timestamptz,
  add column if not exists clicked_pay_at       timestamptz;

-- One-row dashboard of the whole funnel. Just: select * from funnel_metrics;
create or replace view public.funnel_metrics as
select
  count(*)                                                      as entered_email,
  count(*) filter (where reached_checkout)                      as reached_checkout,
  count(*) filter (where clicked_pay_at is not null)            as clicked_pay,
  count(*) filter (where payment_status = 'paid')               as paid,

  -- The two numbers you asked for:
  count(*) filter (where payment_status <> 'paid')              as entered_email_never_paid,
  count(*) filter (where reached_checkout
                     and payment_status <> 'paid')              as reached_end_never_paid,

  -- Conversion %, rounded, guarding against divide-by-zero.
  round(100.0 * count(*) filter (where payment_status = 'paid')
        / nullif(count(*), 0), 1)                               as email_to_paid_pct,
  round(100.0 * count(*) filter (where payment_status = 'paid')
        / nullif(count(*) filter (where reached_checkout), 0), 1) as checkout_to_paid_pct
from public.customers;

-- Optional: see the actual people who reached the end but didn't pay,
-- e.g. to spot a pattern. select * from abandoned_at_checkout;
create or replace view public.abandoned_at_checkout as
select id, email, created_at, reached_checkout_at, clicked_pay_at, iq_score
from public.customers
where reached_checkout and payment_status <> 'paid'
order by reached_checkout_at desc;
