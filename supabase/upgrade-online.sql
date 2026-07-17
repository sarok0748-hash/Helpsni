-- HELPSNI ONLINE UPGRADE — nesmaže existující tabulky ani uživatele.
create extension if not exists pgcrypto;

alter table public.profiles add column if not exists bank_account text;
alter table public.profiles add column if not exists verified boolean not null default false;

alter table public.jobs add column if not exists payment_status text not null default 'unpaid';
alter table public.jobs add column if not exists payment_method text;

alter table public.messages alter column body drop not null;
alter table public.messages add column if not exists image_data text;
alter table public.messages add column if not exists read_at timestamptz;

-- Rozšíření povolených stavů zakázky.
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in ('open','accepted','in_progress','completed','archived','cancelled'));
alter table public.jobs drop constraint if exists jobs_payment_status_check;
alter table public.jobs add constraint jobs_payment_status_check check (payment_status in ('unpaid','reserved','released','refunded'));
alter table public.jobs drop constraint if exists jobs_payment_method_check;
alter table public.jobs add constraint jobs_payment_method_check check (payment_method is null or payment_method in ('apple_pay','google_pay','card'));

-- Automatický profil po registraci.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,full_name,city,role)
  values(new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''),split_part(new.email,'@',1)),
    coalesce(nullif(new.raw_user_meta_data->>'city',''),'Neuvedeno'),
    case when new.raw_user_meta_data->>'role' in ('customer','worker') then new.raw_user_meta_data->>'role' else 'customer' end)
  on conflict(id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.messages enable row level security;
alter table public.reviews enable row level security;

-- Smazání starých i novějších politik, aby nevznikaly konflikty.
drop policy if exists "profiles visible to authenticated" on public.profiles;
drop policy if exists "profiles visible to signed users" on public.profiles;
drop policy if exists "users insert own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;
drop policy if exists "authenticated can view jobs" on public.jobs;
drop policy if exists "signed users view jobs" on public.jobs;
drop policy if exists "customers create own jobs" on public.jobs;
drop policy if exists "customers update own jobs" on public.jobs;
drop policy if exists "customers edit own open jobs" on public.jobs;
drop policy if exists "workers accept open jobs" on public.jobs;
drop policy if exists "assigned worker updates assigned jobs" on public.jobs;
drop policy if exists "customers delete own open jobs" on public.jobs;
drop policy if exists "participants read messages" on public.messages;
drop policy if exists "participants send messages" on public.messages;
drop policy if exists "participants mark messages read" on public.messages;
drop policy if exists "reviews readable" on public.reviews;
drop policy if exists "participants create reviews" on public.reviews;
drop policy if exists "participants create valid reviews" on public.reviews;

create policy "profiles visible to signed users" on public.profiles for select to authenticated using(true);
create policy "users insert own profile" on public.profiles for insert to authenticated with check(auth.uid()=id);
create policy "users update own profile" on public.profiles for update to authenticated using(auth.uid()=id) with check(auth.uid()=id);

create policy "signed users view jobs" on public.jobs for select to authenticated using(true);
create policy "customers create own jobs" on public.jobs for insert to authenticated with check(auth.uid()=customer_id and worker_id is null and status='open');
create policy "customers edit own open jobs" on public.jobs for update to authenticated using(auth.uid()=customer_id and status='open') with check(auth.uid()=customer_id and status='open' and worker_id is null);
create policy "customers delete own open jobs" on public.jobs for delete to authenticated using(auth.uid()=customer_id and status='open');

create policy "participants read messages" on public.messages for select to authenticated using(exists(select 1 from public.jobs j where j.id=job_id and (j.customer_id=auth.uid() or j.worker_id=auth.uid())));
create policy "participants send messages" on public.messages for insert to authenticated with check(auth.uid()=sender_id and exists(select 1 from public.jobs j where j.id=job_id and j.status in ('accepted','in_progress','completed','archived') and (j.customer_id=auth.uid() or j.worker_id=auth.uid())));

create policy "reviews readable" on public.reviews for select to authenticated using(true);
create policy "participants create valid reviews" on public.reviews for insert to authenticated with check(auth.uid()=author_id and exists(select 1 from public.jobs j where j.id=job_id and j.status='archived' and ((j.customer_id=auth.uid() and target_id=j.worker_id) or (j.worker_id=auth.uid() and target_id=j.customer_id))));

create or replace function public.accept_job(job_uuid uuid)
returns public.jobs language plpgsql security definer set search_path=public as $$
declare result public.jobs;
begin
  update public.jobs set worker_id=auth.uid(),status='accepted',accepted_at=now()
  where id=job_uuid and status='open' and worker_id is null and customer_id<>auth.uid()
  returning * into result;
  if result.id is null then raise exception 'Zakázka už není dostupná.'; end if;
  return result;
end; $$;

create or replace function public.start_job(job_uuid uuid)
returns public.jobs language plpgsql security definer set search_path=public as $$
declare result public.jobs;
begin
  update public.jobs set status='in_progress' where id=job_uuid and worker_id=auth.uid() and status='accepted' returning * into result;
  if result.id is null then raise exception 'Zakázku nelze zahájit.'; end if;
  return result;
end; $$;

create or replace function public.complete_job(job_uuid uuid)
returns public.jobs language plpgsql security definer set search_path=public as $$
declare result public.jobs;
begin
  update public.jobs set status='completed',completed_at=now() where id=job_uuid and worker_id=auth.uid() and status='in_progress' returning * into result;
  if result.id is null then raise exception 'Zakázku nelze dokončit.'; end if;
  return result;
end; $$;

create or replace function public.archive_job(job_uuid uuid)
returns public.jobs language plpgsql security definer set search_path=public as $$
declare result public.jobs;
begin
  update public.jobs set status='archived',payment_status=case when payment_status='reserved' then 'released' else payment_status end
  where id=job_uuid and customer_id=auth.uid() and status='completed' returning * into result;
  if result.id is null then raise exception 'Zakázku nelze potvrdit.'; end if;
  return result;
end; $$;

create or replace function public.reserve_job_payment(job_uuid uuid,payment_method_value text)
returns public.jobs language plpgsql security definer set search_path=public as $$
declare result public.jobs;
begin
  if payment_method_value not in ('apple_pay','google_pay','card') then raise exception 'Neplatná platební metoda.'; end if;
  update public.jobs set payment_status='reserved',payment_method=payment_method_value
  where id=job_uuid and customer_id=auth.uid() and status in ('accepted','in_progress') and payment_status='unpaid' returning * into result;
  if result.id is null then raise exception 'Platbu nelze rezervovat.'; end if;
  return result;
end; $$;

create or replace function public.mark_job_messages_read(job_uuid uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.jobs j where j.id=job_uuid and (j.customer_id=auth.uid() or j.worker_id=auth.uid())) then raise exception 'Přístup odepřen.'; end if;
  update public.messages set read_at=coalesce(read_at,now()) where job_id=job_uuid and sender_id<>auth.uid() and read_at is null;
end; $$;

grant execute on function public.accept_job(uuid) to authenticated;
grant execute on function public.start_job(uuid) to authenticated;
grant execute on function public.complete_job(uuid) to authenticated;
grant execute on function public.archive_job(uuid) to authenticated;
grant execute on function public.reserve_job_payment(uuid,text) to authenticated;
grant execute on function public.mark_job_messages_read(uuid) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='jobs') then alter publication supabase_realtime add table public.jobs; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='messages') then alter publication supabase_realtime add table public.messages; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='reviews') then alter publication supabase_realtime add table public.reviews; end if;
end $$;
