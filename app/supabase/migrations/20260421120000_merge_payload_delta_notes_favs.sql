-- i2-4 扩展：在 `jp_learn_merge_payload_delta` 中增加 `lessonNotes`、`favoriteSentences` 整段替换（与 stats 同理）。
-- 需在已执行 `20260418000000_merge_payload_delta.sql` 之后执行。

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

  update public.user_app_data
  set payload = merged, updated_at = now()
  where user_id = uid
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_merge_payload_delta(jsonb) is 'Merge stats, mediaLibrary, lessonNotes, favoriteSentences into user_app_data.payload (Iter i2-4).';
