-- GlobalIQ — funnel drop-off tracking
-- Run AFTER schema.sql, in Supabase -> SQL Editor.

alter table public.customers
  add column if not exists reached_checkout     boolean not null default false,
  add column if not exists reached_checkout_at  timestamptz,
  add column if not exists clicked_pay_at       timestamptz;

create or replace view public.funnel_metrics as
select
  count(*)                                            as entered_email,
  count(*) filter (where reached_checkout)            as reached_checkout,
  count(*) filter (where clicked_pay_at is not null)  as clicked_pay,
  count(*) filter (where payment_status = 'paid')     as paid,
  count(*) filter (where payment_status <> 'paid')    as entered_email_never_paid,
  count(*) filter (where reached_checkout
                     and payment_status <> 'paid')    as reached_end_never_paid,
  round(100.0 * count(*) filter (where payment_status = 'paid')
        / nullif(count(*), 0), 1)                     as email_to_paid_pct,
  round(100.0 * count(*) filter (where payment_status = 'paid')
        / nullif(count(*) filter (where reached_checkout), 0), 1) as checkout_to_paid_pct
from public.customers;
