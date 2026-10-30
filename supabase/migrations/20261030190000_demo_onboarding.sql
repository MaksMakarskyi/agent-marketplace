-- Automatic demo onboarding. Apply explicitly; never at server startup.
--
-- A bot connects with the marketplace URL only. The MCP session id the server issues becomes its credential
-- (stored as a SHA-256 hash, like operator-issued tokens). On registration, one SECURITY DEFINER function
-- creates the participant's grant from server-held demo ceilings, the participant, the credential and, for a
-- buyer, its Stripe sandbox test card. The backend role still cannot write grants, credentials or cards
-- directly, and a bot never chooses its ceilings.

create table marketplace.onboarding_sessions (
  session_hash    text primary key check (session_hash ~ '^[0-9a-f]{64}$'),
  participant_id  text references marketplace.participants (id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);

revoke all on marketplace.onboarding_sessions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on marketplace.onboarding_sessions from anon, authenticated';
  end if;
end $$;
grant select on marketplace.onboarding_sessions to marketplace_app;
alter table marketplace.onboarding_sessions enable row level security;
create policy backend_read on marketplace.onboarding_sessions for select to marketplace_app using (true);

-- Opens a pending session. Bounded so an open link cannot be used to fill the table.
create function marketplace.open_onboarding_session(p_session_hash text, p_hours integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from marketplace.onboarding_sessions where created_at > now() - interval '1 hour') >= 500 then
    raise exception 'ONBOARDING_RATE_LIMIT' using errcode = 'check_violation';
  end if;
  insert into marketplace.onboarding_sessions (session_hash, expires_at)
  values (p_session_hash, now() + make_interval(hours => least(greatest(p_hours, 1), 168)));
end $$;

-- Binds a pending session to a new demo participant. Idempotent: a registered session returns its participant.
create function marketplace.onboard_demo_participant(
  p_session_hash text, p_role text, p_currency text,
  p_max_order_minor bigint, p_max_run_minor bigint,
  p_min_delivered_minor bigint, p_max_quantity integer,
  p_stripe_customer text, p_stripe_payment_method text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s marketplace.onboarding_sessions;
  pid text;
begin
  select * into s from marketplace.onboarding_sessions where session_hash = p_session_hash for update;
  if not found or s.expires_at <= now() then
    raise exception 'ONBOARDING_SESSION_UNKNOWN' using errcode = 'check_violation';
  end if;
  if s.participant_id is not null then return s.participant_id; end if;
  if p_role not in ('buyer', 'supplier') then
    raise exception 'ONBOARDING_ROLE_INVALID' using errcode = 'check_violation';
  end if;
  if (select count(*) from marketplace.operator_grants where created_by = 'auto-onboarding') >= 200 then
    raise exception 'ONBOARDING_FULL' using errcode = 'check_violation';
  end if;

  pid := 'demo-' || p_role || '-' || substr(encode(sha256(convert_to(p_session_hash || clock_timestamp()::text, 'UTF8')), 'hex'), 1, 12);
  if p_role = 'buyer' then
    insert into marketplace.operator_grants (id, role, currency, expires_at, max_order_total_minor, max_run_total_minor, created_by)
    values ('g-' || pid, 'buyer', p_currency, s.expires_at, p_max_order_minor, p_max_run_minor, 'auto-onboarding');
  else
    insert into marketplace.operator_grants (id, role, currency, expires_at, min_delivered_total_minor, max_available_quantity, created_by)
    values ('g-' || pid, 'supplier', p_currency, s.expires_at, p_min_delivered_minor, p_max_quantity, 'auto-onboarding');
  end if;
  insert into marketplace.participants (id, grant_id, role) values (pid, 'g-' || pid, p_role);
  insert into marketplace.api_credentials (token_hash, participant_id) values (p_session_hash, pid);
  if p_role = 'buyer' and p_stripe_customer is not null and p_stripe_payment_method is not null then
    insert into marketplace.payment_credentials (participant_id, stripe_customer_id, stripe_payment_method_id)
    values (pid, p_stripe_customer, p_stripe_payment_method);
  end if;
  update marketplace.onboarding_sessions set participant_id = pid where session_hash = p_session_hash;
  return pid;
end $$;

revoke execute on function marketplace.open_onboarding_session(text, integer) from public;
revoke execute on function marketplace.onboard_demo_participant(text, text, text, bigint, bigint, bigint, integer, text, text) from public;
grant execute on function marketplace.open_onboarding_session(text, integer) to marketplace_app;
grant execute on function marketplace.onboard_demo_participant(text, text, text, bigint, bigint, bigint, integer, text, text) to marketplace_app;
