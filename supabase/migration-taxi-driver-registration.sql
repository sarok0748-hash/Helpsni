create table if not exists public.driver_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  city text,
  license_type text,
  vehicle_option text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','archived')),
  notes text
);

create index if not exists driver_applications_status_idx on public.driver_applications(status);
create index if not exists driver_applications_user_id_idx on public.driver_applications(user_id);

alter table public.driver_applications enable row level security;

drop policy if exists "driver applications select own" on public.driver_applications;
create policy "driver applications select own" on public.driver_applications for select to authenticated using (user_id = auth.uid());

drop policy if exists "driver applications update own pending" on public.driver_applications;
create policy "driver applications update own pending" on public.driver_applications for update to authenticated using (user_id = auth.uid() and status = 'pending') with check (user_id = auth.uid() and status = 'pending');

create or replace function public.set_driver_application_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists driver_applications_updated_at on public.driver_applications;
create trigger driver_applications_updated_at before update on public.driver_applications for each row execute function public.set_driver_application_updated_at();

create or replace function public.register_driver(
  p_first_name text, p_last_name text, p_email text,
  p_phone text default null, p_city text default null,
  p_license_type text default null, p_vehicle_option text default null
)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid(); application_id uuid;
begin
  if uid is null then raise exception 'Uživatel není přihlášen.'; end if;
  if nullif(trim(p_first_name), '') is null or nullif(trim(p_last_name), '') is null then raise exception 'Jméno a příjmení jsou povinné.'; end if;
  if exists (select 1 from public.driver_applications where user_id = uid and status in ('pending','approved')) then raise exception 'Tento účet už má registraci řidiče.'; end if;
  if exists (select 1 from public.drivers where user_id = uid) then raise exception 'Tento účet je již veden jako řidič.'; end if;
  insert into public.driver_applications (user_id,first_name,last_name,email,phone,city,license_type,vehicle_option)
  values (uid,trim(p_first_name),trim(p_last_name),lower(trim(p_email)),nullif(trim(p_phone),''),nullif(trim(p_city),''),nullif(trim(p_license_type),''),nullif(trim(p_vehicle_option),''))
  returning id into application_id;
  return application_id;
end;
$$;

revoke all on function public.register_driver(text,text,text,text,text,text,text) from public;
grant execute on function public.register_driver(text,text,text,text,text,text,text) to authenticated;