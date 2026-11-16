-- Phase 5: Atomic queue ordering, request limits, host capability helper, and playback RPCs

-- Shared internal helper: verifies auth.uid() is room host AND capability matches hash
create or replace function public._assert_host_capability(p_room_id uuid, p_capability text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
begin
  if not public.is_room_host(p_room_id) then
    raise exception 'Host privilege required';
  end if;

  select host_capability_hash into v_hash
  from public.rooms
  where id = p_room_id
  for update;

  if v_hash is null or v_hash <> encode(digest(coalesce(p_capability, ''), 'sha256'), 'hex') then
    raise exception 'Invalid host capability';
  end if;
end;
$$;

revoke all on function public._assert_host_capability(uuid, text) from public, anon, authenticated;

-- Refactor set_room_status to reuse _assert_host_capability
create or replace function public.set_room_status(
  p_room_id uuid,
  p_status text,
  p_capability text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rev bigint;
begin
  if p_status not in ('open', 'host_disconnected', 'closed') then
    raise exception 'Invalid room status';
  end if;

  perform public._assert_host_capability(p_room_id, p_capability);

  update public.rooms
  set status = p_status,
      revision = revision + 1
  where id = p_room_id
  returning revision into v_rev;

  return v_rev;
end;
$$;

-- Harden add_song: lock room row for concurrency, verify song belongs to room, enforce per-guest limit
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
  if v_uid is null or not public.is_room_member(p_room_id) then
    raise exception 'Not an active room member';
  end if;

  -- Lock room row so concurrent queue additions serialize cleanly
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

-- Host-only atomic queue reorder
create or replace function public.reorder_queue(
  p_room_id uuid,
  p_ordered_entry_ids uuid[],
  p_capability text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rev bigint;
  v_base_pos integer;
  v_idx integer;
  v_entry_id uuid;
begin
  perform public._assert_host_capability(p_room_id, p_capability);

  select coalesce(max(position), 0) into v_base_pos
  from public.queue_entries
  where room_id = p_room_id;

  -- Shift queued entries above max first to avoid any position ambiguity, then assign dense order
  v_idx := 1;
  foreach v_entry_id in array p_ordered_entry_ids loop
    update public.queue_entries
    set position = v_base_pos + v_idx
    where id = v_entry_id
      and room_id = p_room_id
      and status = 'queued';
    v_idx := v_idx + 1;
  end loop;

  update public.rooms
  set revision = revision + 1
  where id = p_room_id
  returning revision into v_rev;

  return v_rev;
end;
$$;

-- Host-only queue advancement (next, skip, or play specific entry)
create or replace function public.advance_queue(
  p_room_id uuid,
  p_action text,
  p_capability text,
  p_entry_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rev bigint;
  v_next_entry public.queue_entries%rowtype;
begin
  if p_action not in ('next', 'skip', 'play_entry') then
    raise exception 'Invalid queue action';
  end if;

  perform public._assert_host_capability(p_room_id, p_capability);

  update public.queue_entries
  set status = case when p_action = 'skip' then 'skipped' else 'played' end
  where room_id = p_room_id and status = 'playing';

  if p_action = 'play_entry' and p_entry_id is not null then
    select * into v_next_entry
    from public.queue_entries
    where id = p_entry_id and room_id = p_room_id and status = 'queued';
  else
    select * into v_next_entry
    from public.queue_entries
    where room_id = p_room_id and status = 'queued'
    order by position asc, created_at asc
    limit 1;
  end if;

  update public.rooms
  set revision = revision + 1
  where id = p_room_id
  returning revision into v_rev;

  if v_next_entry.id is not null then
    update public.queue_entries
    set status = 'playing'
    where id = v_next_entry.id;

    update public.playback_state
    set song_id = v_next_entry.song_id,
        status = 'playing',
        position_ms = 0,
        revision = v_rev,
        updated_at = now()
    where room_id = p_room_id;
  else
    update public.playback_state
    set song_id = null,
        status = 'ended',
        position_ms = 0,
        revision = v_rev,
        updated_at = now()
    where room_id = p_room_id;
  end if;

  return v_rev;
end;
$$;

-- Host-only sparse playback checkpoint
create or replace function public.sync_playback_checkpoint(
  p_room_id uuid,
  p_status text,
  p_position_ms integer,
  p_capability text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rev bigint;
begin
  if p_status not in ('idle', 'playing', 'paused', 'ended') then
    raise exception 'Invalid playback status';
  end if;

  perform public._assert_host_capability(p_room_id, p_capability);

  update public.rooms
  set revision = revision + 1
  where id = p_room_id
  returning revision into v_rev;

  update public.playback_state
  set status = p_status,
      position_ms = greatest(0, p_position_ms),
      revision = v_rev,
      updated_at = now()
  where room_id = p_room_id;

  return v_rev;
end;
$$;

-- Revoke direct client writes to playback_state so all mutations go through RPCs
revoke insert, update, delete on public.playback_state from anon, authenticated;

revoke all on function public.reorder_queue(uuid, uuid[], text) from public;
revoke all on function public.advance_queue(uuid, text, text, uuid) from public;
revoke all on function public.sync_playback_checkpoint(uuid, text, integer, text) from public;

grant execute on function public.reorder_queue(uuid, uuid[], text) to authenticated;
grant execute on function public.advance_queue(uuid, text, text, uuid) to authenticated;
grant execute on function public.sync_playback_checkpoint(uuid, text, integer, text) to authenticated;
