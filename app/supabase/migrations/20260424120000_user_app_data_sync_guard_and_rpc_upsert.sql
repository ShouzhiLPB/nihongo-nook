-- 大 payload：避免「整包 select + 整包 upsert」与默认 statement_timeout 叠加导致 canceling statement due to statement timeout。
-- 1) jp_learn_remote_sync_guard_meta：仅返回 exists / bare_shell（不在网络上拉整份 JSON）。
-- 2) jp_learn_upsert_user_app_data：服务端 upsert，本会话放宽 statement_timeout（仅该事务内）。
-- 3) jp_learn_merge_payload_delta：合并前同样放宽超时（大 jsonb 多次 jsonb_set 可能较慢）。
-- 需在已执行 20260423140000_merge_payload_delta_main_arrays.sql 之后执行。

-- ── 轻量元数据（与客户端 appDataIsBareShellForCloudUpload 口径对齐） ──
create or replace function public.jp_learn_remote_sync_guard_meta()
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  pl jsonb;
  core int;
  marks int;
  dwell_lr bigint;
  dwell_pr bigint;
  daily_keys int;
  media_keys int;
  stats_nonempty boolean;
  bare boolean;
begin
  select u.payload into pl
  from public.user_app_data u
  where u.user_id = auth.uid();

  if pl is null then
    return jsonb_build_object('exists', false, 'bare_shell', true);
  end if;

  core :=
    case when jsonb_typeof(coalesce(pl->'lessons', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'lessons', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'vocabCards', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'vocabCards', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'sentenceTasks', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'sentenceTasks', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'grammarTasks', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'grammarTasks', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'chatSessions', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'chatSessions', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'lessonNotes', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'lessonNotes', '[]'::jsonb)) else 0 end
    + case when jsonb_typeof(coalesce(pl->'favoriteSentences', '[]'::jsonb)) = 'array'
      then jsonb_array_length(coalesce(pl->'favoriteSentences', '[]'::jsonb)) else 0 end;

  marks :=
    coalesce(nullif(trim(pl->'stats'->>'practiceMarkCorrect'), '')::int, 0)
    + coalesce(nullif(trim(pl->'stats'->>'practiceMarkWrong'), '')::int, 0)
    + coalesce(nullif(trim(pl->'stats'->>'practiceMarkEasy'), '')::int, 0);

  dwell_lr := coalesce(nullif(trim(pl->'stats'->>'dwellLessonReaderSec'), '')::bigint, 0);
  dwell_pr := coalesce(nullif(trim(pl->'stats'->>'dwellPracticeSec'), '')::bigint, 0);

  if jsonb_typeof(coalesce(pl->'stats'->'daily', '{}'::jsonb)) = 'object' then
    select count(*)::int into daily_keys from jsonb_object_keys(pl->'stats'->'daily');
  else
    daily_keys := 0;
  end if;

  stats_nonempty := (marks > 0 or dwell_lr > 0 or dwell_pr > 0 or daily_keys > 0);

  if jsonb_typeof(coalesce(pl->'mediaLibrary', '{}'::jsonb)) = 'object' then
    select count(*)::int into media_keys from jsonb_object_keys(coalesce(pl->'mediaLibrary', '{}'::jsonb));
  else
    media_keys := 0;
  end if;

  bare := (core = 0 and not stats_nonempty and media_keys = 0);

  return jsonb_build_object('exists', true, 'bare_shell', bare);
end;
$$;

comment on function public.jp_learn_remote_sync_guard_meta() is 'Small JSON for bare-shell guard without downloading full payload (perf / timeout).';

revoke all on function public.jp_learn_remote_sync_guard_meta() from public;
grant execute on function public.jp_learn_remote_sync_guard_meta() to authenticated;

-- ── 整包写入（放宽本会话 statement_timeout） ──
create or replace function public.jp_learn_upsert_user_app_data(p_payload jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  out_time timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  perform set_config('statement_timeout', '600s', true);

  insert into public.user_app_data (user_id, payload, updated_at)
  values (uid, p_payload, now())
  on conflict (user_id) do update
  set payload = excluded.payload, updated_at = excluded.updated_at
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_upsert_user_app_data(jsonb) is 'Upsert own user_app_data row with extended statement_timeout for large JSONB.';

revoke all on function public.jp_learn_upsert_user_app_data(jsonb) from public;
grant execute on function public.jp_learn_upsert_user_app_data(jsonb) to authenticated;

-- ── 增量合并：同样放宽超时（读整包 cur + 多次 jsonb_set） ──
create or replace function public.jp_learn_merge_payload_delta(p_delta jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  merged jsonb;
  out_time timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  perform set_config('statement_timeout', '600s', true);

  select payload into cur
  from public.user_app_data
  where user_id = uid
  for update;

  if cur is null then
    raise exception 'no cloud row: upload full snapshot first';
  end if;

  merged := cur;

  if p_delta ? 'stats' and jsonb_typeof(p_delta->'stats') = 'object' then
    merged := jsonb_set(merged, '{stats}', p_delta->'stats', true);
  end if;

  if p_delta ? 'mediaLibrary' and jsonb_typeof(p_delta->'mediaLibrary') = 'object' then
    merged := jsonb_set(
      merged,
      '{mediaLibrary}',
      coalesce(merged->'mediaLibrary', '{}'::jsonb) || (p_delta->'mediaLibrary'),
      true
    );
  end if;

  if p_delta ? 'lessonNotes' and jsonb_typeof(p_delta->'lessonNotes') = 'array' then
    merged := jsonb_set(merged, '{lessonNotes}', p_delta->'lessonNotes', true);
  end if;

  if p_delta ? 'favoriteSentences' and jsonb_typeof(p_delta->'favoriteSentences') = 'array' then
    merged := jsonb_set(merged, '{favoriteSentences}', p_delta->'favoriteSentences', true);
  end if;

  if p_delta ? 'lessons' and jsonb_typeof(p_delta->'lessons') = 'array' then
    merged := jsonb_set(merged, '{lessons}', p_delta->'lessons', true);
  end if;

  if p_delta ? 'vocabCards' and jsonb_typeof(p_delta->'vocabCards') = 'array' then
    merged := jsonb_set(merged, '{vocabCards}', p_delta->'vocabCards', true);
  end if;

  if p_delta ? 'sentenceTasks' and jsonb_typeof(p_delta->'sentenceTasks') = 'array' then
    merged := jsonb_set(merged, '{sentenceTasks}', p_delta->'sentenceTasks', true);
  end if;

  if p_delta ? 'grammarTasks' and jsonb_typeof(p_delta->'grammarTasks') = 'array' then
    merged := jsonb_set(merged, '{grammarTasks}', p_delta->'grammarTasks', true);
  end if;

  if p_delta ? 'chatSessions' and jsonb_typeof(p_delta->'chatSessions') = 'array' then
    merged := jsonb_set(merged, '{chatSessions}', p_delta->'chatSessions', true);
  end if;

  update public.user_app_data
  set payload = merged, updated_at = now()
  where user_id = uid
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_merge_payload_delta(jsonb) is 'Merge delta into payload with extended statement_timeout (large JSONB).';

revoke all on function public.jp_learn_merge_payload_delta(jsonb) from public;
grant execute on function public.jp_learn_merge_payload_delta(jsonb) to authenticated;
