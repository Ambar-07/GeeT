-- GeeT Karaoke Platform: Initial Schema, RLS & Transactional RPCs
-- Free-tier cloud design: metadata & room coordination only; never store audio or local paths.

create extension if not exists pgcrypto;

-- 1. Core tables
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) between 6 and 12),
  host_user_id uuid not null,
  host_capability_hash text not null,
  status text not null default 'open' check (status in ('open', 'host_disconnected', 'closed')),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours')
);

create table if not exists public.room_participants (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role text not null check (role in ('host', 'participant')),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (room_id, user_id)
);

create table if not exists public.room_songs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  host_song_id text not null,
  title text not null,
  artist text not null default '',
  duration_ms integer not null check (duration_ms >= 0),
  readiness text not null default 'raw' check (readiness in ('raw', 'preparing', 'ready', 'failed')),
  unique (room_id, host_song_id)
);

create table if not exists public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  song_id uuid not null references public.room_songs(id) on delete cascade,
  requested_by uuid not null,
  position integer not null check (position >= 0),
  status text not null default 'queued' check (status in ('queued', 'playing', 'played', 'skipped')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (room_id, idempotency_key, requested_by)
);

create table if not exists public.playback_state (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  song_id uuid references public.room_songs(id) on delete set null,
  status text not null default 'idle' check (status in ('idle', 'playing', 'paused', 'ended')),
  position_ms integer not null default 0 check (position_ms >= 0),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create index if not exists idx_room_songs_room on public.room_songs(room_id);
create index if not exists idx_queue_entries_room_pos on public.queue_entries(room_id, position);

-- 2. RLS helper functions (SECURITY DEFINER with fixed search_path to prevent recursion)
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_participants p
    where p.room_id = p_room_id
      and p.user_id = (select auth.uid())
      and p.revoked_at is null
  );
$$;

create or replace function public.is_room_host(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room_id
      and r.host_user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_room_member(uuid) from public;
revoke all on function public.is_room_host(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.is_room_host(uuid) to authenticated;

-- 3. Enable RLS on every exposed table
alter table public.rooms enable row level security;
alter table public.room_participants enable row level security;
alter table public.room_songs enable row level security;
alter table public.queue_entries enable row level security;
alter table public.playback_state enable row level security;

-- Read policies: room members only (never expose all room codes)
create policy rooms_member_read on public.rooms
  for select to authenticated
  using (public.is_room_member(id));

create policy participants_member_read on public.room_participants
  for select to authenticated
  using (public.is_room_member(room_id));

create policy room_songs_member_read on public.room_songs
  for select to authenticated
  using (public.is_room_member(room_id));

create policy queue_member_read on public.queue_entries
  for select to authenticated
  using (public.is_room_member(room_id));

create policy playback_member_read on public.playback_state
  for select to authenticated
  using (public.is_room_member(room_id));

-- Host-only direct writes for published catalogue & sparse playback checkpoints
create policy room_songs_host_write on public.room_songs
  for all to authenticated
  using (public.is_room_host(room_id))
  with check (public.is_room_host(room_id));

create policy playback_host_write on public.playback_state
  for all to authenticated
  using (public.is_room_host(room_id))
  with check (public.is_room_host(room_id));

-- Revoke direct mutations on tables governed by transactional RPCs
revoke insert, update, delete on public.rooms from anon, authenticated;
revoke insert, update, delete on public.room_participants from anon, authenticated;
revoke insert, update, delete on public.queue_entries from anon, authenticated;

-- 4. Transactional RPCs
create or replace function public.create_room()
returns table(room_id uuid, code text, host_capability text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_code text;
  v_cap text;
  v_room_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  v_code := upper(substring(encode(gen_random_bytes(5), 'hex') from 1 for 8));
  v_cap := encode(gen_random_bytes(24), 'hex');

  insert into public.rooms (code, host_user_id, host_capability_hash)
  values (v_code, v_uid, encode(digest(v_cap, 'sha256'), 'hex'))
  returning id into v_room_id;

  insert into public.room_participants (room_id, user_id, display_name, role)
  values (v_room_id, v_uid, 'Host', 'host');

  insert into public.playback_state (room_id) values (v_room_id);

  return query select v_room_id, v_code, v_cap;
end;
$$;

create or replace function public.join_room(p_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_room_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select id into v_room_id
  from public.rooms
  where code = upper(trim(p_code))
    and status <> 'closed'
    and expires_at > now();

  if v_room_id is null then
    raise exception 'Room not found or closed';
  end if;

  insert into public.room_participants (room_id, user_id, display_name, role, last_seen, revoked_at)
  values (v_room_id, v_uid, trim(p_display_name), 'participant', now(), null)
  on conflict (room_id, user_id) do update
    set display_name = excluded.display_name,
        last_seen = now(),
        revoked_at = null;

  return v_room_id;
end;
$$;

create or replace function public.add_song(p_room_id uuid, p_song_id uuid, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_existing uuid;
  v_next_pos integer;
  v_entry_id uuid;
begin
  if v_uid is null or not public.is_room_member(p_room_id) then
    raise exception 'Not an active room member';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and status = 'open') then
    raise exception 'Room is not open';
  end if;

  select id into v_existing
  from public.queue_entries
  where room_id = p_room_id
    and idempotency_key = p_idempotency_key
    and requested_by = v_uid;

  if v_existing is not null then
    return v_existing;
  end if;

  select coalesce(max(position), 0) + 1 into v_next_pos
  from public.queue_entries
  where room_id = p_room_id;

  insert into public.queue_entries (room_id, song_id, requested_by, position, idempotency_key)
  values (p_room_id, p_song_id, v_uid, v_next_pos, p_idempotency_key)
  returning id into v_entry_id;

  update public.rooms set revision = revision + 1 where id = p_room_id;
  return v_entry_id;
end;
$$;

create or replace function public.remove_song(p_room_id uuid, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_owner uuid;
begin
  if v_uid is null or not public.is_room_member(p_room_id) then
    raise exception 'Not an active room member';
  end if;

  select requested_by into v_owner
  from public.queue_entries
  where id = p_entry_id and room_id = p_room_id;

  if v_owner is null then
    raise exception 'Queue entry not found';
  end if;

  if v_owner <> v_uid and not public.is_room_host(p_room_id) then
    raise exception 'Only the host or requester can remove this entry';
  end if;

  delete from public.queue_entries where id = p_entry_id and room_id = p_room_id;
  update public.rooms set revision = revision + 1 where id = p_room_id;
end;
$$;

create or replace function public.close_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_room_host(p_room_id) then
    raise exception 'Host privilege required';
  end if;

  update public.rooms
  set status = 'closed', revision = revision + 1
  where id = p_room_id;
end;
$$;

revoke all on function public.create_room() from public;
revoke all on function public.join_room(text, text) from public;
revoke all on function public.add_song(uuid, uuid, text) from public;
revoke all on function public.remove_song(uuid, uuid) from public;
revoke all on function public.close_room(uuid) from public;

grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.add_song(uuid, uuid, text) to authenticated;
grant execute on function public.remove_song(uuid, uuid) to authenticated;
grant execute on function public.close_room(uuid) to authenticated;
