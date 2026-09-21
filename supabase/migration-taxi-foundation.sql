-- HELPSNI TAXI — FOUNDATION MIGRATION
-- Non-destructive migration. Does not drop or alter the legacy Helpsni marketplace tables.
-- Apply after reviewing in Supabase SQL Editor.
--
-- Target model:
-- auth.users -> carrier_members -> carriers -> vehicles / drivers / documents
-- Existing profiles/jobs/messages/reviews remain untouched for now.

create extension if not exists pgcrypto;

-- =========================================================
-- 1. Carriers
-- =========================================================

create table if not exists public.carriers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  legal_name text not null,
  business_name text,
  ico text,
  dic text,
  email text,
  phone text,

  street text,
  city text,
  postal_code text,
  country text not null default 'CZ',

  status text not null default 'pending'
    check (status in ('pending','active','suspended','rejected','archived')),

  notes text
);

create unique index if not exists carriers_ico_unique
  on public.carriers (ico)
  where ico is not null and ico <> '';

create index if not exists carriers_status_idx
  on public.carriers (status);

-- =========================================================
-- 2. Carrier membership
-- One account can belong to a carrier. This also gives us a
-- clean path to multiple staff/admin users later.
-- =========================================================

create table if not exists public.carrier_members (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  carrier_id uuid not null references public.carriers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  member_role text not null default 'owner'
    check (member_role in ('owner','admin','member')),

  status text not null default 'active'
    check (status in ('active','invited','suspended')),

  unique (carrier_id, user_id)
);

create index if not exists carrier_members_user_idx
  on public.carrier_members (user_id);

create index if not exists carrier_members_carrier_idx
  on public.carrier_members (carrier_id);

-- =========================================================
-- 3. Vehicles
-- =========================================================

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  carrier_id uuid not null references public.carriers(id) on delete cascade,

  registration_plate text not null,
  brand text,
  model text,
  color text,
  model_year integer,
  vin text,

  status text not null default 'active'
    check (status in ('active','inactive','maintenance','archived')),

  notes text,

  unique (carrier_id, registration_plate)
);

create index if not exists vehicles_carrier_idx
  on public.vehicles (carrier_id);

-- =========================================================
-- 4. Drivers
-- A driver can optionally have a platform login later.
-- =========================================================

create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  carrier_id uuid not null references public.carriers(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,

  first_name text not null,
  last_name text not null,
  phone text,
  email text,

  status text not null default 'active'
    check (status in ('active','inactive','suspended','archived')),

  notes text,

  unique (carrier_id, id)
);

create index if not exists drivers_carrier_idx
  on public.drivers (carrier_id);

create index if not exists drivers_user_idx
  on public.drivers (user_id)
  where user_id is not null;

-- =========================================================
-- 5. Driver ↔ vehicle assignment
-- Historical assignments are retained.
-- =========================================================

create table if not exists public.driver_vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  carrier_id uuid not null references public.carriers(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,

  valid_from timestamptz not null default now(),
  valid_to timestamptz,

  notes text,

  check (valid_to is null or valid_to > valid_from)
);

create index if not exists dva_carrier_idx
  on public.driver_vehicle_assignments (carrier_id);

create index if not exists dva_driver_idx
  on public.driver_vehicle_assignments (driver_id);

create index if not exists dva_vehicle_idx
  on public.driver_vehicle_assignments (vehicle_id);

-- =========================================================
-- 6. Documents
-- Files themselves will live in private Supabase Storage.
-- storage_path is never exposed publicly.
-- =========================================================

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  carrier_id uuid not null references public.carriers(id) on delete cascade,

  driver_id uuid references public.drivers(id) on delete cascade,
  vehicle_id uuid references public.vehicles(id) on delete cascade,

  document_type text not null,
  file_name text not null,
  storage_path text not null,

  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),

  expires_at date,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,

  rejection_reason text,

  check (
    (driver_id is not null and vehicle_id is null)
    or
    (driver_id is null and vehicle_id is not null)
    or
    (driver_id is null and vehicle_id is null)
  )
);

create index if not exists documents_carrier_idx
  on public.documents (carrier_id);

create index if not exists documents_driver_idx
  on public.documents (driver_id)
  where driver_id is not null;

create index if not exists documents_vehicle_idx
  on public.documents (vehicle_id)
  where vehicle_id is not null;

create index if not exists documents_expiry_idx
  on public.documents (expires_at)
  where expires_at is not null;

-- =========================================================
-- 7. Updated-at trigger
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists carriers_set_updated_at on public.carriers;
create trigger carriers_set_updated_at
before update on public.carriers
for each row execute function public.set_updated_at();

drop trigger if exists vehicles_set_updated_at on public.vehicles;
create trigger vehicles_set_updated_at
before update on public.vehicles
for each row execute function public.set_updated_at();

drop trigger if exists drivers_set_updated_at on public.drivers;
create trigger drivers_set_updated_at
before update on public.drivers
for each row execute function public.set_updated_at();

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

-- =========================================================
-- 8. RLS helper functions
-- SECURITY DEFINER avoids recursive RLS evaluation on
-- carrier_members while checking membership.
-- =========================================================

create or replace function public.is_carrier_member(target_carrier_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.carrier_members cm
    where cm.carrier_id = target_carrier_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
  );
$$;

create or replace function public.is_carrier_manager(target_carrier_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.carrier_members cm
    where cm.carrier_id = target_carrier_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.member_role in ('owner','admin')
  );
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

grant execute on function public.is_carrier_member(uuid) to authenticated;
grant execute on function public.is_carrier_manager(uuid) to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- =========================================================
-- 9. RLS
-- =========================================================

alter table public.carriers enable row level security;
alter table public.carrier_members enable row level security;
alter table public.vehicles enable row level security;
alter table public.drivers enable row level security;
alter table public.driver_vehicle_assignments enable row level security;
alter table public.documents enable row level security;

-- Carriers
drop policy if exists "taxi carriers select own" on public.carriers;
create policy "taxi carriers select own"
on public.carriers
for select to authenticated
using (
  public.is_carrier_member(id)
  or public.is_platform_admin()
);

drop policy if exists "taxi carriers insert authenticated" on public.carriers;
create policy "taxi carriers insert authenticated"
on public.carriers
for insert to authenticated
with check (true);

drop policy if exists "taxi carriers update manager" on public.carriers;
create policy "taxi carriers update manager"
on public.carriers
for update to authenticated
using (
  public.is_carrier_manager(id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(id)
  or public.is_platform_admin()
);

-- Carrier members
drop policy if exists "taxi carrier members select own" on public.carrier_members;
create policy "taxi carrier members select own"
on public.carrier_members
for select to authenticated
using (
  user_id = auth.uid()
  or public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi carrier members insert manager" on public.carrier_members;
create policy "taxi carrier members insert manager"
on public.carrier_members
for insert to authenticated
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
  -- Initial carrier creation is handled by the registration flow,
  -- which will use a dedicated RPC in the next migration.
);

drop policy if exists "taxi carrier members update manager" on public.carrier_members;
create policy "taxi carrier members update manager"
on public.carrier_members
for update to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi carrier members delete manager" on public.carrier_members;
create policy "taxi carrier members delete manager"
on public.carrier_members
for delete to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

-- Vehicles
drop policy if exists "taxi vehicles select own" on public.vehicles;
create policy "taxi vehicles select own"
on public.vehicles
for select to authenticated
using (
  public.is_carrier_member(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi vehicles insert manager" on public.vehicles;
create policy "taxi vehicles insert manager"
on public.vehicles
for insert to authenticated
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi vehicles update manager" on public.vehicles;
create policy "taxi vehicles update manager"
on public.vehicles
for update to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi vehicles delete manager" on public.vehicles;
create policy "taxi vehicles delete manager"
on public.vehicles
for delete to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

-- Drivers
drop policy if exists "taxi drivers select own" on public.drivers;
create policy "taxi drivers select own"
on public.drivers
for select to authenticated
using (
  public.is_carrier_member(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi drivers insert manager" on public.drivers;
create policy "taxi drivers insert manager"
on public.drivers
for insert to authenticated
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi drivers update manager" on public.drivers;
create policy "taxi drivers update manager"
on public.drivers
for update to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi drivers delete manager" on public.drivers;
create policy "taxi drivers delete manager"
on public.drivers
for delete to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

-- Driver / vehicle assignments
drop policy if exists "taxi assignments select own" on public.driver_vehicle_assignments;
create policy "taxi assignments select own"
on public.driver_vehicle_assignments
for select to authenticated
using (
  public.is_carrier_member(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi assignments insert manager" on public.driver_vehicle_assignments;
create policy "taxi assignments insert manager"
on public.driver_vehicle_assignments
for insert to authenticated
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi assignments update manager" on public.driver_vehicle_assignments;
create policy "taxi assignments update manager"
on public.driver_vehicle_assignments
for update to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi assignments delete manager" on public.driver_vehicle_assignments;
create policy "taxi assignments delete manager"
on public.driver_vehicle_assignments
for delete to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

-- Documents
drop policy if exists "taxi documents select own" on public.documents;
create policy "taxi documents select own"
on public.documents
for select to authenticated
using (
  public.is_carrier_member(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi documents insert manager" on public.documents;
create policy "taxi documents insert manager"
on public.documents
for insert to authenticated
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi documents update manager" on public.documents;
create policy "taxi documents update manager"
on public.documents
for update to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
)
with check (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

drop policy if exists "taxi documents delete manager" on public.documents;
create policy "taxi documents delete manager"
on public.documents
for delete to authenticated
using (
  public.is_carrier_manager(carrier_id)
  or public.is_platform_admin()
);

-- =========================================================
-- 10. Private document bucket
-- The application will use signed URLs rather than public files.
-- =========================================================

insert into storage.buckets (id, name, public)
values ('taxi-documents', 'taxi-documents', false)
on conflict (id) do update set public = false;

drop policy if exists "taxi documents storage select" on storage.objects;
create policy "taxi documents storage select"
on storage.objects
for select to authenticated
using (
  bucket_id = 'taxi-documents'
  and (
    public.is_carrier_member((storage.foldername(name))[1]::uuid)
    or public.is_platform_admin()
  )
);

drop policy if exists "taxi documents storage insert" on storage.objects;
create policy "taxi documents storage insert"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'taxi-documents'
  and (
    public.is_carrier_manager((storage.foldername(name))[1]::uuid)
    or public.is_platform_admin()
  )
);

drop policy if exists "taxi documents storage update" on storage.objects;
create policy "taxi documents storage update"
on storage.objects
for update to authenticated
using (
  bucket_id = 'taxi-documents'
  and (
    public.is_carrier_manager((storage.foldername(name))[1]::uuid)
    or public.is_platform_admin()
  )
)
with check (
  bucket_id = 'taxi-documents'
  and (
    public.is_carrier_manager((storage.foldername(name))[1]::uuid)
    or public.is_platform_admin()
  )
);

drop policy if exists "taxi documents storage delete" on storage.objects;
create policy "taxi documents storage delete"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'taxi-documents'
  and (
    public.is_carrier_manager((storage.foldername(name))[1]::uuid)
    or public.is_platform_admin()
  )
);
