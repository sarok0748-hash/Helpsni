create table if not exists public.driver_application_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  application_id uuid not null references public.driver_applications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type text not null,
  file_name text not null,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  expires_at date,
  rejection_reason text
);

create index if not exists driver_application_documents_app_idx on public.driver_application_documents(application_id);
create index if not exists driver_application_documents_user_idx on public.driver_application_documents(user_id);

alter table public.driver_application_documents enable row level security;

drop policy if exists "driver application documents select own" on public.driver_application_documents;
create policy "driver application documents select own"
on public.driver_application_documents for select to authenticated
using (user_id = auth.uid());

drop policy if exists "driver application documents insert own" on public.driver_application_documents;
create policy "driver application documents insert own"
on public.driver_application_documents for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists "driver application documents delete own pending" on public.driver_application_documents;
create policy "driver application documents delete own pending"
on public.driver_application_documents for delete to authenticated
using (user_id = auth.uid() and status = 'pending');

create or replace function public.set_driver_application_documents_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists driver_application_documents_updated_at on public.driver_application_documents;
create trigger driver_application_documents_updated_at
before update on public.driver_application_documents
for each row execute function public.set_driver_application_documents_updated_at();

insert into storage.buckets (id, name, public)
values ('taxi-driver-documents','taxi-driver-documents',false)
on conflict (id) do update set public=false;

drop policy if exists "driver documents upload own" on storage.objects;
create policy "driver documents upload own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'taxi-driver-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "driver documents read own" on storage.objects;
create policy "driver documents read own"
on storage.objects for select to authenticated
using (
  bucket_id = 'taxi-driver-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "driver documents delete own" on storage.objects;
create policy "driver documents delete own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'taxi-driver-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);