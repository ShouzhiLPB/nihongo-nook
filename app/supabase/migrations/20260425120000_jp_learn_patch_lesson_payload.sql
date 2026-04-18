-- 单篇课文小字段补丁：避免仅改标题/正文就整包 upsert（i2-4 余量 · 首版）。
-- 需在已执行 20260417000000_user_app_data.sql 与 20260424120000（或等价 upsert RPC）之后执行。

create or replace function public.jp_learn_patch_lesson_payload(p_lesson_id text, p_patch jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  lessons jsonb;
  p_safe jsonb := '{}'::jsonb;
  found boolean;
  new_lessons jsonb;
  out_time timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if p_lesson_id is null or length(trim(p_lesson_id)) = 0 then
    raise exception 'p_lesson_id required';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'p_patch must be object';
  end if;

  if p_patch ? 'name' and jsonb_typeof(p_patch->'name') = 'string' then
    p_safe := p_safe || jsonb_build_object('name', p_patch->'name');
  end if;
  if p_patch ? 'content' and jsonb_typeof(p_patch->'content') = 'string' then
    p_safe := p_safe || jsonb_build_object('content', p_patch->'content');
  end if;
  if p_patch ? 'updatedAt' and jsonb_typeof(p_patch->'updatedAt') = 'string' then
    p_safe := p_safe || jsonb_build_object('updatedAt', p_patch->'updatedAt');
  end if;

  if p_safe = '{}'::jsonb then
    raise exception 'p_patch has no allowed keys (name, content, updatedAt as strings)';
  end if;

  perform set_config('statement_timeout', '600s', true);

  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then
    raise exception 'no cloud row: upload full snapshot first';
  end if;

  lessons := coalesce(cur->'lessons', '[]'::jsonb);
  if jsonb_typeof(lessons) <> 'array' then
    raise exception 'invalid payload.lessons';
  end if;

  select exists (
    select 1 from jsonb_array_elements(lessons) as t(elem) where t.elem->>'id' = p_lesson_id
  ) into found;
  if not found then
    raise exception 'lesson id not found in cloud payload';
  end if;

  select coalesce(jsonb_agg(x.merged order by x.ord), '[]'::jsonb)
  into new_lessons
  from (
    select
      t.ord,
      case
        when t.elem->>'id' = p_lesson_id then t.elem || p_safe
        else t.elem
      end as merged
    from jsonb_array_elements(lessons) with ordinality as t(elem, ord)
  ) x;

  cur := jsonb_set(cur, '{lessons}', new_lessons, true);

  update public.user_app_data
  set payload = cur, updated_at = now()
  where user_id = uid
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_patch_lesson_payload(text, jsonb) is 'Patch one lesson name/content/updatedAt inside payload.lessons without full-row upsert.';

revoke all on function public.jp_learn_patch_lesson_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_lesson_payload(text, jsonb) to authenticated;
