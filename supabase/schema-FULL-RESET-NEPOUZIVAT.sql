-- HELPSNI ONLINE MVP (Supabase)
-- UPOZORNĚNÍ: Tento instalační skript smaže testovací tabulky Helpsni a vytvoří je znovu.
-- Spusťte jen tehdy, pokud v nich nemáte data, která chcete zachovat.

create extension if not exists pgcrypto;

drop table if exists public.messages cascade;
drop table if exists public.reviews cascade;
drop table if exists public.jobs cascade;
drop table if exists public.profiles cascade;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  full_name text not null,
  phone text,
  avatar_url text,
  role text not null default 'customer' check (role in ('customer','worker','admin')),
  city text not null,
  bank_account text,
  verified boolean not null default false
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  worker_id uuid references public.profiles(id) on delete set null,
  title text not null,
  description text not null,
  category text not null,
  city text not null,
  address text not null,
  price numeric(12,2) not null check (price > 0),
  status text not null default 'open' check (status in ('open','accepted','in_progress','completed','archived','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','reserved','released','refunded')),
  payment_method text check (payment_method in ('apple_pay','google_pay','card'))
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text,
  image_data text,
  read_at timestamptz,
  check ((body is not null and char_length(body) between 1 and 2000) or image_data is not null)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  unique(job_id, author_id),
  check (author_id <> target_id)
);

-- Profil se automaticky vytvoří po registraci uživatele.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, city, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1)),
    coalesce(nullif(new.raw_user_meta_data->>'city',''), 'Neuvedeno'),
    case when new.raw_user_meta_data->>'role' in ('customer','worker') then new.raw_user_meta_data->>'role' else 'customer' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.messages enable row level security;
alter table public.reviews enable row level security;

create policy "profiles visible to signed users"
on public.profiles for select to authenticated using (true);

create policy "users update own profile"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "signed users view jobs"
on public.jobs for select to authenticated using (true);

create policy "customers create own jobs"
on public.jobs for insert to authenticated
with check (auth.uid() = customer_id and worker_id is null and status = 'open');

create policy "customers edit own open jobs"
on public.jobs for update to authenticated
using (auth.uid() = customer_id)
with check (auth.uid() = customer_id);

create policy "assigned worker updates assigned jobs"
on public.jobs for update to authenticated
using (auth.uid() = worker_id)
with check (auth.uid() = worker_id);

create policy "customers delete own open jobs"
on public.jobs for delete to authenticated
using (auth.uid() = customer_id and status = 'open');

-- Atomické přijetí zakázky: uspěje jen první pracovník.
create or replace function public.accept_job(job_uuid uuid)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  accepted_job public.jobs;
begin
  update public.jobs
  set worker_id = auth.uid(), status = 'accepted', accepted_at = now()
  where id = job_uuid
    and status = 'open'
    and worker_id is null
    and customer_id <> auth.uid()
  returning * into accepted_job;

  if accepted_job.id is null then
    raise exception 'Zakázka už není dostupná.';
  end if;

  return accepted_job;
end;
$$;
grant execute on function public.accept_job(uuid) to authenticated;

create policy "participants read messages"
on public.messages for select to authenticated using (
  exists (
    select 1 from public.jobs j
    where j.id = job_id and (j.customer_id = auth.uid() or j.worker_id = auth.uid())
  )
);

create policy "participants send messages"
on public.messages for insert to authenticated with check (
  auth.uid() = sender_id and exists (
    select 1 from public.jobs j
    where j.id = job_id
      and j.status in ('accepted','in_progress','completed','archived')
      and (j.customer_id = auth.uid() or j.worker_id = auth.uid())
  )
);

create policy "participants mark messages read"
on public.messages for update to authenticated
using (
  exists (
    select 1 from public.jobs j
    where j.id = job_id and (j.customer_id = auth.uid() or j.worker_id = auth.uid())
  )
)
with check (
  exists (
    select 1 from public.jobs j
    where j.id = job_id and (j.customer_id = auth.uid() or j.worker_id = auth.uid())
  )
);

create policy "reviews readable"
on public.reviews for select to authenticated using (true);

create policy "participants create valid reviews"
on public.reviews for insert to authenticated with check (
  auth.uid() = author_id and exists (
    select 1 from public.jobs j
    where j.id = job_id
      and j.status = 'archived'
      and (
        (j.customer_id = auth.uid() and target_id = j.worker_id)
        or
        (j.worker_id = auth.uid() and target_id = j.customer_id)
      )
  )
);

-- Realtime pro zakázky, chat a hodnocení (bez chyby při opakovaném spuštění).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='jobs') then
    alter publication supabase_realtime add table public.jobs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='reviews') then
    alter publication supabase_realtime add table public.reviews;
  end if;
end $$;
