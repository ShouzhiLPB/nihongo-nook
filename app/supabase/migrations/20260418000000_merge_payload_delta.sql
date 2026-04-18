-- i2-4：结构化增量上行（MVP）——在已有整包快照行上合并 JSON 片段，减少「只刷了统计却整包重写」的流量。
-- 需在 Dashboard SQL Editor 执行过 20260417000000_user_app_data.sql 之后再执行本文件。

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

  update public.user_app_data
  set payload = merged, updated_at = now()
  where user_id = uid
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_merge_payload_delta(jsonb) is 'Merge stats and/or mediaLibrary keys into user_app_data.payload (Iter i2-4).';

revoke all on function public.jp_learn_merge_payload_delta(jsonb) from public;
grant execute on function public.jp_learn_merge_payload_delta(jsonb) to authenticated;
