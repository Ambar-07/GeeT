-- Phase 4: Host capability verification, column-level secret protection, and Realtime publication

-- Prevent any client role from reading host_capability_hash via PostgREST
revoke select (host_capability_hash) on public.rooms from anon, authenticated;

-- Host status transition verified with both auth.uid() and high-entropy host capability
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
  v_hash text;
  v_rev bigint;
begin
  if p_status not in ('open', 'host_disconnected', 'closed') then
    raise exception 'Invalid room status';
  end if;

  if not public.is_room_host(p_room_id) then
    raise exception 'Host privilege required';
  end if;

  select host_capability_hash into v_hash
  from public.rooms
  where id = p_room_id;

  if v_hash is null or v_hash <> encode(digest(coalesce(p_capability, ''), 'sha256'), 'hex') then
    raise exception 'Invalid host capability';
  end if;

  update public.rooms
  set status = p_status,
      revision = revision + 1
  where id = p_room_id
  returning revision into v_rev;

  return v_rev;
end;
$$;

revoke all on function public.set_room_status(uuid, text, text) from public;
grant execute on function public.set_room_status(uuid, text, text) to authenticated;

-- Enable Realtime Postgres Changes for room coordination tables when publication exists
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['rooms', 'room_participants', 'room_songs', 'queue_entries', 'playback_state'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
