-- 单张词卡小字段补丁：编辑 / SRS 进度不必整包 upsert（i2-4 余量）。
-- 需在 `user_app_data` 与整包 upsert 相关迁移之后执行。

create or replace function public.jp_learn_patch_vocab_card_payload(p_vocab_id text, p_patch jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur jsonb;
  cards jsonb;
  p_safe jsonb := '{}'::jsonb;
  found boolean;
  new_cards jsonb;
  out_time timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if p_vocab_id is null or length(trim(p_vocab_id)) = 0 then
    raise exception 'p_vocab_id required';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'p_patch must be object';
  end if;

  if p_patch ? 'term' and jsonb_typeof(p_patch->'term') = 'string' then
    p_safe := p_safe || jsonb_build_object('term', p_patch->'term');
  end if;
  if p_patch ? 'kana' and jsonb_typeof(p_patch->'kana') = 'string' then
    p_safe := p_safe || jsonb_build_object('kana', p_patch->'kana');
  end if;
  if p_patch ? 'etymology' and jsonb_typeof(p_patch->'etymology') = 'string' then
    p_safe := p_safe || jsonb_build_object('etymology', p_patch->'etymology');
  end if;
  if p_patch ? 'latestExample' and jsonb_typeof(p_patch->'latestExample') = 'string' then
    p_safe := p_safe || jsonb_build_object('latestExample', p_patch->'latestExample');
  end if;
  if p_patch ? 'updatedAt' and jsonb_typeof(p_patch->'updatedAt') = 'string' then
    p_safe := p_safe || jsonb_build_object('updatedAt', p_patch->'updatedAt');
  end if;

  if p_patch ? 'meanings' and jsonb_typeof(p_patch->'meanings') = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_patch->'meanings') as t(m)
      where jsonb_typeof(t.m) <> 'object'
         or not (t.m ? 'zh')
         or jsonb_typeof(t.m->'zh') <> 'string'
         or (t.m ? 'example' and jsonb_typeof(t.m->'example') <> 'string')
    ) then
      raise exception 'invalid meanings';
    end if;
    p_safe := p_safe || jsonb_build_object('meanings', p_patch->'meanings');
  end if;

  if p_patch ? 'vocabDistractors' and jsonb_typeof(p_patch->'vocabDistractors') = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_patch->'vocabDistractors') as t(s)
      where jsonb_typeof(t.s) <> 'string'
    ) then
      raise exception 'vocabDistractors must be array of strings';
    end if;
    p_safe := p_safe || jsonb_build_object('vocabDistractors', p_patch->'vocabDistractors');
  end if;

  if p_patch ? 'vocabZhDistractors' and jsonb_typeof(p_patch->'vocabZhDistractors') = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_patch->'vocabZhDistractors') as t(s)
      where jsonb_typeof(t.s) <> 'string'
    ) then
      raise exception 'vocabZhDistractors must be array of strings';
    end if;
    p_safe := p_safe || jsonb_build_object('vocabZhDistractors', p_patch->'vocabZhDistractors');
  end if;

  if p_patch ? 'mastery' and jsonb_typeof(p_patch->'mastery') = 'number' then
    p_safe := p_safe || jsonb_build_object('mastery', p_patch->'mastery');
  end if;
  if p_patch ? 'reviewStage' and jsonb_typeof(p_patch->'reviewStage') = 'number' then
    p_safe := p_safe || jsonb_build_object('reviewStage', p_patch->'reviewStage');
  end if;
  if p_patch ? 'nextReviewDay' and jsonb_typeof(p_patch->'nextReviewDay') = 'string' then
    p_safe := p_safe || jsonb_build_object('nextReviewDay', p_patch->'nextReviewDay');
  end if;
  if p_patch ? 'reviewGraduated' and jsonb_typeof(p_patch->'reviewGraduated') = 'boolean' then
    p_safe := p_safe || jsonb_build_object('reviewGraduated', p_patch->'reviewGraduated');
  end if;

  if p_safe = '{}'::jsonb then
    raise exception 'p_patch has no allowed keys';
  end if;

  perform set_config('statement_timeout', '600s', true);

  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then
    raise exception 'no cloud row: upload full snapshot first';
  end if;

  cards := coalesce(cur->'vocabCards', '[]'::jsonb);
  if jsonb_typeof(cards) <> 'array' then
    raise exception 'invalid payload.vocabCards';
  end if;

  select exists (
    select 1 from jsonb_array_elements(cards) as x(elem) where x.elem->>'id' = p_vocab_id
  ) into found;
  if not found then
    raise exception 'vocab id not found in cloud payload';
  end if;

  select coalesce(jsonb_agg(y.merged order by y.ord), '[]'::jsonb)
  into new_cards
  from (
    select
      t.ord,
      case
        when t.elem->>'id' = p_vocab_id then t.elem || p_safe
        else t.elem
      end as merged
    from jsonb_array_elements(cards) with ordinality as t(elem, ord)
  ) y;

  cur := jsonb_set(cur, '{vocabCards}', new_cards, true);

  update public.user_app_data
  set payload = cur, updated_at = now()
  where user_id = uid
  returning updated_at into out_time;

  return out_time;
end;
$$;

comment on function public.jp_learn_patch_vocab_card_payload(text, jsonb) is 'Patch whitelisted vocab card fields inside payload.vocabCards without full-row upsert.';

revoke all on function public.jp_learn_patch_vocab_card_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_vocab_card_payload(text, jsonb) to authenticated;
