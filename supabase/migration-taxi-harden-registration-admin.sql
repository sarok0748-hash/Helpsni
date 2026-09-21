-- HELPSNI TAXI — harden registration/admin boundaries
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;

drop policy if exists "taxi platform admins select" on public.platform_admins;
create policy "taxi platform admins select"
on public.platform_admins for select to authenticated
using (user_id = auth.uid() or public.is_platform_admin());

drop policy if exists "taxi carriers insert authenticated" on public.carriers;
