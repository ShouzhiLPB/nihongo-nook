-- 单条课文笔记 / 收藏句小字段补丁（更新正文等不必整包 upsert）。
-- 新增 / 删除仍可由客户端走 `jp_learn_merge_payload_delta` 整段替换子树（见应用防抖合并）。
-- 需在 `user_app_data` 与 notes/favs 增量迁移之后执行。

create or replace function public.jp_learn_patch_lesson_note_payload(p_note_id text, p_patch jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  arr jsonb;
  p_safe jsonb := '{}'::jsonb;
  found boolean;
  new_arr jsonb;
  out_time timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_note_id is null or length(trim(p_note_id)) = 0 then raise exception 'p_note_id required'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be object'; end if;

  if p_patch ? 'title' and jsonb_typeof(p_patch->'title') = 'string' then
    p_safe := p_safe || jsonb_build_object('title', p_patch->'title');
  end if;
  if p_patch ? 'content' and jsonb_typeof(p_patch->'content') = 'string' then
    p_safe := p_safe || jsonb_build_object('content', p_patch->'content');
  end if;
  if p_patch ? 'lineIndex' and jsonb_typeof(p_patch->'lineIndex') = 'number' then
    p_safe := p_safe || jsonb_build_object('lineIndex', p_patch->'lineIndex');
  end if;
  if p_patch ? 'updatedAt' and jsonb_typeof(p_patch->'updatedAt') = 'string' then
    p_safe := p_safe || jsonb_build_object('updatedAt', p_patch->'updatedAt');
  end if;

  if p_safe = '{}'::jsonb then raise exception 'p_patch has no allowed keys'; end if;

  perform set_config('statement_timeout', '600s', true);
  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then raise exception 'no cloud row: upload full snapshot first'; end if;

  arr := coalesce(cur->'lessonNotes', '[]'::jsonb);
  if jsonb_typeof(arr) <> 'array' then raise exception 'invalid payload.lessonNotes'; end if;

  select exists (select 1 from jsonb_array_elements(arr) x(e) where x.e->>'id' = p_note_id) into found;
  if not found then raise exception 'lesson note id not found in cloud payload'; end if;

  select coalesce(jsonb_agg(y.merged order by y.ord), '[]'::jsonb) into new_arr
  from (
    select t.ord,
      case when t.elem->>'id' = p_note_id then t.elem || p_safe else t.elem end as merged
    from jsonb_array_elements(arr) with ordinality as t(elem, ord)
  ) y;

  cur := jsonb_set(cur, '{lessonNotes}', new_arr, true);
  update public.user_app_data set payload = cur, updated_at = now() where user_id = uid returning updated_at into out_time;
  return out_time;
end;
$$;

comment on function public.jp_learn_patch_lesson_note_payload(text, jsonb) is 'Patch one lesson note inside payload.lessonNotes.';

revoke all on function public.jp_learn_patch_lesson_note_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_lesson_note_payload(text, jsonb) to authenticated;


create or replace function public.jp_learn_patch_favorite_sentence_payload(p_fav_id text, p_patch jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  arr jsonb;
  p_safe jsonb := '{}'::jsonb;
  found boolean;
  new_arr jsonb;
  out_time timestamptz;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_fav_id is null or length(trim(p_fav_id)) = 0 then raise exception 'p_fav_id required'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be object'; end if;

  if p_patch ? 'jp' and jsonb_typeof(p_patch->'jp') = 'string' then
    p_safe := p_safe || jsonb_build_object('jp', p_patch->'jp');
  end if;
  if p_patch ? 'zhHint' and jsonb_typeof(p_patch->'zhHint') = 'string' then
    p_safe := p_safe || jsonb_build_object('zhHint', p_patch->'zhHint');
  end if;
  if p_patch ? 'lineIndex' and jsonb_typeof(p_patch->'lineIndex') = 'number' then
    p_safe := p_safe || jsonb_build_object('lineIndex', p_patch->'lineIndex');
  end if;

  if p_safe = '{}'::jsonb then raise exception 'p_patch has no allowed keys'; end if;

  perform set_config('statement_timeout', '600s', true);
  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then raise exception 'no cloud row: upload full snapshot first'; end if;

  arr := coalesce(cur->'favoriteSentences', '[]'::jsonb);
  if jsonb_typeof(arr) <> 'array' then raise exception 'invalid payload.favoriteSentences'; end if;

  select exists (select 1 from jsonb_array_elements(arr) x(e) where x.e->>'id' = p_fav_id) into found;
  if not found then raise exception 'favorite sentence id not found in cloud payload'; end if;

  select coalesce(jsonb_agg(y.merged order by y.ord), '[]'::jsonb) into new_arr
  from (
    select t.ord,
      case when t.elem->>'id' = p_fav_id then t.elem || p_safe else t.elem end as merged
    from jsonb_array_elements(arr) with ordinality as t(elem, ord)
  ) y;

  cur := jsonb_set(cur, '{favoriteSentences}', new_arr, true);
  update public.user_app_data set payload = cur, updated_at = now() where user_id = uid returning updated_at into out_time;
  return out_time;
end;
$$;

comment on function public.jp_learn_patch_favorite_sentence_payload(text, jsonb) is 'Patch one favorite sentence inside payload.favoriteSentences.';

revoke all on function public.jp_learn_patch_favorite_sentence_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_favorite_sentence_payload(text, jsonb) to authenticated;
