-- 日语学习 App：每用户一条 JSON 快照（与本地 AppData 同形）。
-- 在 Supabase Dashboard → SQL Editor 中粘贴执行，或使用 Supabase CLI migrate。

create table if not exists public.user_app_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_app_data is 'Per-user full AppData JSON snapshot for cloud backup (Iter 23).';

alter table public.user_app_data enable row level security;

create policy "user_app_data_select_own"
  on public.user_app_data for select
  using (auth.uid() = user_id);

create policy "user_app_data_insert_own"
  on public.user_app_data for insert
  with check (auth.uid() = user_id);

create policy "user_app_data_update_own"
  on public.user_app_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_app_data_delete_own"
  on public.user_app_data for delete
  using (auth.uid() = user_id);
