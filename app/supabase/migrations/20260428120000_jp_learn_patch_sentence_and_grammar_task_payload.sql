-- 句子题 / 语法题小字段补丁（练习 SRS + 详情弹层保存），与词卡 patch 同思路。
-- 需在 `user_app_data` 与整包 upsert 相关迁移之后执行。

create or replace function public.jp_learn_patch_sentence_task_payload(p_task_id text, p_patch jsonb)
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
  if p_task_id is null or length(trim(p_task_id)) = 0 then raise exception 'p_task_id required'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be object'; end if;

  if p_patch ? 'zh' and jsonb_typeof(p_patch->'zh') = 'string' then
    p_safe := p_safe || jsonb_build_object('zh', p_patch->'zh');
  end if;
  if p_patch ? 'jpAnswer' and jsonb_typeof(p_patch->'jpAnswer') = 'string' then
    p_safe := p_safe || jsonb_build_object('jpAnswer', p_patch->'jpAnswer');
  end if;
  if p_patch ? 'teachingNote' and jsonb_typeof(p_patch->'teachingNote') = 'string' then
    p_safe := p_safe || jsonb_build_object('teachingNote', p_patch->'teachingNote');
  end if;
  if p_patch ? 'sourceType' and jsonb_typeof(p_patch->'sourceType') = 'string' then
    if (p_patch->>'sourceType') not in ('translation', 'listening') then
      raise exception 'invalid sourceType';
    end if;
    p_safe := p_safe || jsonb_build_object('sourceType', p_patch->'sourceType');
  end if;
  if p_patch ? 'tokens' and jsonb_typeof(p_patch->'tokens') = 'array' then
    if exists (
      select 1 from jsonb_array_elements(p_patch->'tokens') as t(tok)
      where jsonb_typeof(t.tok) <> 'string'
    ) then
      raise exception 'tokens must be array of strings';
    end if;
    p_safe := p_safe || jsonb_build_object('tokens', p_patch->'tokens');
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

  if p_safe = '{}'::jsonb then raise exception 'p_patch has no allowed keys'; end if;

  perform set_config('statement_timeout', '600s', true);
  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then raise exception 'no cloud row: upload full snapshot first'; end if;

  arr := coalesce(cur->'sentenceTasks', '[]'::jsonb);
  if jsonb_typeof(arr) <> 'array' then raise exception 'invalid payload.sentenceTasks'; end if;

  select exists (select 1 from jsonb_array_elements(arr) x(e) where x.e->>'id' = p_task_id) into found;
  if not found then raise exception 'sentence task id not found in cloud payload'; end if;

  select coalesce(jsonb_agg(y.merged order by y.ord), '[]'::jsonb) into new_arr
  from (
    select t.ord,
      case when t.elem->>'id' = p_task_id then t.elem || p_safe else t.elem end as merged
    from jsonb_array_elements(arr) with ordinality as t(elem, ord)
  ) y;

  cur := jsonb_set(cur, '{sentenceTasks}', new_arr, true);
  update public.user_app_data set payload = cur, updated_at = now() where user_id = uid returning updated_at into out_time;
  return out_time;
end;
$$;

comment on function public.jp_learn_patch_sentence_task_payload(text, jsonb) is 'Patch whitelisted sentence task fields in payload.sentenceTasks.';

revoke all on function public.jp_learn_patch_sentence_task_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_sentence_task_payload(text, jsonb) to authenticated;


create or replace function public.jp_learn_patch_grammar_task_payload(p_task_id text, p_patch jsonb)
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
  if p_task_id is null or length(trim(p_task_id)) = 0 then raise exception 'p_task_id required'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be object'; end if;

  if p_patch ? 'prompt' and jsonb_typeof(p_patch->'prompt') = 'string' then
    p_safe := p_safe || jsonb_build_object('prompt', p_patch->'prompt');
  end if;
  if p_patch ? 'zhPrompt' and jsonb_typeof(p_patch->'zhPrompt') = 'string' then
    p_safe := p_safe || jsonb_build_object('zhPrompt', p_patch->'zhPrompt');
  end if;
  if p_patch ? 'explanation' and jsonb_typeof(p_patch->'explanation') = 'string' then
    p_safe := p_safe || jsonb_build_object('explanation', p_patch->'explanation');
  end if;
  if p_patch ? 'knowledgePoint' and jsonb_typeof(p_patch->'knowledgePoint') = 'string' then
    p_safe := p_safe || jsonb_build_object('knowledgePoint', p_patch->'knowledgePoint');
  end if;
  if p_patch ? 'sourceSentence' and jsonb_typeof(p_patch->'sourceSentence') = 'string' then
    p_safe := p_safe || jsonb_build_object('sourceSentence', p_patch->'sourceSentence');
  end if;
  if p_patch ? 'answerId' and jsonb_typeof(p_patch->'answerId') = 'string' then
    p_safe := p_safe || jsonb_build_object('answerId', p_patch->'answerId');
  end if;
  if p_patch ? 'choices' and jsonb_typeof(p_patch->'choices') = 'array' then
    p_safe := p_safe || jsonb_build_object('choices', p_patch->'choices');
  end if;
  if p_patch ? 'wrongReasonByChoiceId' and jsonb_typeof(p_patch->'wrongReasonByChoiceId') = 'object' then
    p_safe := p_safe || jsonb_build_object('wrongReasonByChoiceId', p_patch->'wrongReasonByChoiceId');
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

  if p_safe = '{}'::jsonb then raise exception 'p_patch has no allowed keys'; end if;

  perform set_config('statement_timeout', '600s', true);
  select payload into cur from public.user_app_data where user_id = uid for update;
  if cur is null then raise exception 'no cloud row: upload full snapshot first'; end if;

  arr := coalesce(cur->'grammarTasks', '[]'::jsonb);
  if jsonb_typeof(arr) <> 'array' then raise exception 'invalid payload.grammarTasks'; end if;

  select exists (select 1 from jsonb_array_elements(arr) x(e) where x.e->>'id' = p_task_id) into found;
  if not found then raise exception 'grammar task id not found in cloud payload'; end if;

  select coalesce(jsonb_agg(y.merged order by y.ord), '[]'::jsonb) into new_arr
  from (
    select t.ord,
      case when t.elem->>'id' = p_task_id then t.elem || p_safe else t.elem end as merged
    from jsonb_array_elements(arr) with ordinality as t(elem, ord)
  ) y;

  cur := jsonb_set(cur, '{grammarTasks}', new_arr, true);
  update public.user_app_data set payload = cur, updated_at = now() where user_id = uid returning updated_at into out_time;
  return out_time;
end;
$$;

comment on function public.jp_learn_patch_grammar_task_payload(text, jsonb) is 'Patch whitelisted grammar task fields in payload.grammarTasks.';

revoke all on function public.jp_learn_patch_grammar_task_payload(text, jsonb) from public;
grant execute on function public.jp_learn_patch_grammar_task_payload(text, jsonb) to authenticated;
