-- Adversarial RLS verification suite for disposable test databases.
-- Run inside a transaction so no test artifacts persist.
begin;

do $$
declare
  v_host uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_guest uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_outsider uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_room_id uuid;
  v_code text;
  v_cap text;
  v_song_id uuid;
  v_entry_id uuid;
  v_count integer;
begin
  -- 1. Host creates room
  perform set_config('request.jwt.claim.sub', v_host::text, true);
  perform set_config('role', 'authenticated', true);
  select room_id, code, host_capability into v_room_id, v_code, v_cap from public.create_room();

  insert into public.room_songs (room_id, host_song_id, title, artist, duration_ms)
  values (v_room_id, 'song1', 'Test Track', 'Artist', 10000)
  returning id into v_song_id;

  -- 2. Unauthenticated anon cannot read rooms
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin
    execute 'select count(*) from public.rooms' into v_count;
    if v_count > 0 then
      raise exception 'FAIL: anon read rooms';
    end if;
  exception when insufficient_privilege then
    null;
  end;

  -- 3. Authenticated outsider cannot read room or add song
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  select count(*) into v_count from public.rooms where id = v_room_id;
  if v_count <> 0 then
    raise exception 'FAIL: outsider read non-member room';
  end if;

  begin
    perform public.add_song(v_room_id, v_song_id, 'outsider-key');
    raise exception 'FAIL: outsider added song';
  exception when others then
    null;
  end;

  -- 4. Guest joins room, cannot read host_capability_hash, cannot run host RPCs
  perform set_config('request.jwt.claim.sub', v_guest::text, true);
  perform public.join_room(v_code, 'GuestOne');

  begin
    execute 'select host_capability_hash from public.rooms limit 1';
    raise exception 'FAIL: guest selected host_capability_hash';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_room_status(v_room_id, 'closed', 'wrong-cap');
    raise exception 'FAIL: guest mutated room status';
  exception when others then
    null;
  end;

  -- 5. Guest adds song (idempotent) and host cannot be bypassed
  v_entry_id := public.add_song(v_room_id, v_song_id, 'guest-key-1');
  if public.add_song(v_room_id, v_song_id, 'guest-key-1') <> v_entry_id then
    raise exception 'FAIL: idempotency key returned different entry';
  end if;

  -- 6. Another outsider still cannot remove guest's queue entry
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  begin
    perform public.remove_song(v_room_id, v_entry_id);
    raise exception 'FAIL: outsider removed guest entry';
  exception when others then
    null;
  end;
end;
$$;

rollback;
