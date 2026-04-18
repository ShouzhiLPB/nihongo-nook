-- 扩展 `jp_learn_patch_lesson_payload` 白名单：分类/作者/行译/显隐/媒体键与外链/视频轴等（仍不替代整包首传）。
-- 需在已执行 `20260425120000_jp_learn_patch_lesson_payload.sql` 之后执行（或首次即跑本文件亦可，等同完整函数体）。

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

  if p_patch ? 'category' and jsonb_typeof(p_patch->'category') = 'string' then
    p_safe := p_safe || jsonb_build_object('category', p_patch->'category');
  end if;
  if p_patch ? 'author' and jsonb_typeof(p_patch->'author') = 'string' then
    p_safe := p_safe || jsonb_build_object('author', p_patch->'author');
  end if;

  if p_patch ? 'translationVisible' and jsonb_typeof(p_patch->'translationVisible') = 'boolean' then
    p_safe := p_safe || jsonb_build_object('translationVisible', p_patch->'translationVisible');
  end if;

  if p_patch ? 'lessonKind' and jsonb_typeof(p_patch->'lessonKind') = 'string' then
    if (p_patch->>'lessonKind') not in ('text', 'video') then
      raise exception 'invalid lessonKind';
    end if;
    p_safe := p_safe || jsonb_build_object('lessonKind', p_patch->'lessonKind');
  end if;

  if p_patch ? 'lineTranslations' and jsonb_typeof(p_patch->'lineTranslations') = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_patch->'lineTranslations') as t(elem)
      where jsonb_typeof(t.elem) <> 'string'
    ) then
      raise exception 'lineTranslations must be array of strings';
    end if;
    p_safe := p_safe || jsonb_build_object('lineTranslations', p_patch->'lineTranslations');
  end if;

  if p_patch ? 'coverIllustrationDataUrl' and jsonb_typeof(p_patch->'coverIllustrationDataUrl') = 'string' then
    p_safe := p_safe || jsonb_build_object('coverIllustrationDataUrl', p_patch->'coverIllustrationDataUrl');
  end if;
  if p_patch ? 'coverIllustrationMediaKey' and jsonb_typeof(p_patch->'coverIllustrationMediaKey') = 'string' then
    p_safe := p_safe || jsonb_build_object('coverIllustrationMediaKey', p_patch->'coverIllustrationMediaKey');
  end if;
  if p_patch ? 'listeningAudioDataUrl' and jsonb_typeof(p_patch->'listeningAudioDataUrl') = 'string' then
    p_safe := p_safe || jsonb_build_object('listeningAudioDataUrl', p_patch->'listeningAudioDataUrl');
  end if;
  if p_patch ? 'listeningAudioMediaKey' and jsonb_typeof(p_patch->'listeningAudioMediaKey') = 'string' then
    p_safe := p_safe || jsonb_build_object('listeningAudioMediaKey', p_patch->'listeningAudioMediaKey');
  end if;
  if p_patch ? 'videoSourceUrl' and jsonb_typeof(p_patch->'videoSourceUrl') = 'string' then
    p_safe := p_safe || jsonb_build_object('videoSourceUrl', p_patch->'videoSourceUrl');
  end if;
  if p_patch ? 'videoSourceMediaKey' and jsonb_typeof(p_patch->'videoSourceMediaKey') = 'string' then
    p_safe := p_safe || jsonb_build_object('videoSourceMediaKey', p_patch->'videoSourceMediaKey');
  end if;

  if p_patch ? 'videoCues' and jsonb_typeof(p_patch->'videoCues') = 'array' then
    p_safe := p_safe || jsonb_build_object('videoCues', p_patch->'videoCues');
  end if;

  if p_patch ? 'trashedAt' and jsonb_typeof(p_patch->'trashedAt') = 'string' then
    p_safe := p_safe || jsonb_build_object('trashedAt', p_patch->'trashedAt');
  end if;

  if p_safe = '{}'::jsonb then
    raise exception 'p_patch has no allowed keys';
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

comment on function public.jp_learn_patch_lesson_payload(text, jsonb) is 'Patch whitelisted lesson fields inside payload.lessons (name/content/meta/translations/media keys/videoCues/trashedAt) without full-row upsert.';

revoke all on function public.jp_learn_patch_lesson_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_lesson_payload(text, jsonb) to authenticated;
