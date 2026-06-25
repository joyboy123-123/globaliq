-- =====================================================================
-- GlobalIQ — customer capture schema (PostgreSQL / Supabase)
-- Run this in Supabase → SQL Editor (or psql) once.
-- =====================================================================

-- Case-insensitive text so Foo@x.com and foo@x.com are treated as one email.
create extension if not exists citext;

-- Payment lifecycle as a constrained enum (prevents typo'd statuses).
do $$ begin
  create type payment_status as enum ('unpaid', 'pending', 'paid', 'refunded');
exception when duplicate_object then null;
end $$;

create table if not exists public.customers (
  -- Customer ID: stable primary key you can attach everything else to.
  id                   uuid primary key default gen_random_uuid(),

  -- Email: UNIQUE + citext == "no duplicate email records", case-insensitive.
  email                citext not null unique,

  -- When the email was first submitted on the page.
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Test data.
  iq_score             integer,                              -- nullable until test scored
  test_completed       boolean not null default false,       -- completion status
  test_completed_at    timestamptz,

  -- Payment.
  payment_status       payment_status not null default 'unpaid',
  paid_at              timestamptz,
  payment_provider_id  text,                                 -- e.g. Stripe customer/session id

  -- Fields that support the emails you want to send LATER.
  certificate_url      text,                                 -- link to the generated PDF/img
  certificate_sent_at  timestamptz,
  marketing_consent    boolean not null default false,       -- set true only if they opt in
  unsubscribed_at      timestamptz,                          -- honor opt-outs (CAN-SPAM/GDPR)

  -- Light attribution, handy later.
  source               text default 'iq-checkout',
  ip_address           inet,
  user_agent           text
);

-- Fast lookups by status for your admin views / cron jobs.
create index if not exists customers_payment_status_idx on public.customers (payment_status);
create index if not exists customers_created_at_idx     on public.customers (created_at desc);

-- Keep updated_at fresh on every change.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists customers_touch_updated_at on public.customers;
create trigger customers_touch_updated_at
  before update on public.customers
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row Level Security
-- The frontend must NEVER be able to read the whole email list.
-- We lock the table down and let only the service role (server side) touch it.
-- All writes go through the Edge Function below, which uses the service key.
-- =====================================================================
alter table public.customers enable row level security;

-- No anon/public policies are created on purpose:
-- with RLS on and no policy, the public 'anon' key can neither read nor write.
-- The service_role key bypasses RLS, so server-side code still works.
-- This is what stops a visitor from scraping your customer list from the browser.
