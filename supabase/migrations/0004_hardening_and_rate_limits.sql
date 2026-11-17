-- Phase 7: Server-side rate limiting for room creation, joining, and queue additions

create table if not exists public.rate_limits (
  user_id uuid not null,
  bucket text not null,
  window_start timestamptz not null default now(),
  hits integer not null default 1,
  primary key (user_id, bucket)
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public._check_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window interval
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := (select auth.uid());
  v_hits integer;
  v_start timestamptz;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  insert into public.rate_limits (user_id, bucket, window_start, hits)
  values (v_uid, p_bucket, now(), 1)
  on conflict (user_id, bucket) do update
    set hits = case
          when public.rate_limits.window_start + p_window < now() then 1
          else public.rate_limits.hits + 1
        end,
        window_start = case
          when public.rate_limits.window_start + p_window < now() then now()
          else public.rate_limits.window_start
        end
  returning hits, window_start into v_hits, v_start;

  if v_hits > p_limit then
    raise exception 'Rate limit exceeded for % (try again later)', p_bucket;
  end if;
end;
$$;

revoke all on function public._check_rate_limit(text, integer, interval) from public, anon, authenticated;

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
  perform public._check_rate_limit('create_room', 5, interval '1 hour');

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
  perform public._check_rate_limit('join_room', 15, interval '5 minutes');

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
  v_active_count integer;
begin
  perform public._check_rate_limit('add_song', 20, interval '5 minutes');

  if not public.is_room_member(p_room_id) then
    raise exception 'Not an active room member';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and status = 'open' for update) then
    raise exception 'Room is not open';
  end if;

  if not exists (select 1 from public.room_songs where id = p_song_id and room_id = p_room_id) then
    raise exception 'Song is not published in this room';
  end if;

  select id into v_existing
  from public.queue_entries
  where room_id = p_room_id
    and idempotency_key = p_idempotency_key
    and requested_by = v_uid;

  if v_existing is not null then
    return v_existing;
  end if;

  if not public.is_room_host(p_room_id) then
    select count(*) into v_active_count
    from public.queue_entries
    where room_id = p_room_id
      and requested_by = v_uid
      and status = 'queued';
    if v_active_count >= 5 then
      raise exception 'Participant queue limit reached (max 5 queued songs)';
    end if;
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
