-- Short-lived actor-bound receipts let a buyer select a public BZP notice found by a live search.
-- Discovery re-fetches using the same filters; the saved response is not treated as current evidence.
alter table marketplace.sourcing_requests drop constraint sourcing_requests_buyer_notice_number_check;
alter table marketplace.sourcing_requests add constraint sourcing_requests_buyer_notice_number_check
  check (buyer_notice_number ~ '^\d{1,7}-(19|20)\d{2}$' or buyer_notice_number ~ '^bzp:[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$');

create table marketplace.public_directory_searches (
  id             text primary key,
  participant_id text not null,
  participant_role text not null check (participant_role in ('buyer','supplier')),
  filters        jsonb not null,
  result         jsonb not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  foreign key (participant_id, participant_role) references marketplace.participants (id, role),
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);

alter table marketplace.public_directory_searches enable row level security;
alter table marketplace.public_directory_searches force row level security;
create policy backend_access on marketplace.public_directory_searches to marketplace_app using (true) with check (true);
grant select, insert, delete on marketplace.public_directory_searches to marketplace_app;
