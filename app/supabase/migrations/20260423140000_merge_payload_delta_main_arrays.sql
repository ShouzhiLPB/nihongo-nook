-- i2-4 收口：在 `jp_learn_merge_payload_delta` 中增加主数据数组整段替换（lessons / vocabCards / sentenceTasks / grammarTasks / chatSessions）。
-- 需在已执行 `20260421120000_merge_payload_delta_notes_favs.sql`（或已含同等分支的 RPC）之后执行；亦可单独执行本文件（本文件为完整函数定义）。

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

comment on function public.jp_learn_merge_payload_delta(jsonb) is 'Merge stats, mediaLibrary, lessonNotes, favoriteSentences, lessons, vocabCards, sentenceTasks, grammarTasks, chatSessions into user_app_data.payload (Iter i2-4 full).';
