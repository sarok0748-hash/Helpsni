-- HELPSNI TAXI — carrier registration RPC
-- Creates the carrier and owner membership atomically for the logged-in user.

create or replace function public.register_carrier(
  p_legal_name text,
  p_business_name text default null,
  p_ico text default null,
  p_dic text default null,
  p_email text default null,
  p_phone text default null,
  p_street text default null,
  p_city text default null,
  p_postal_code text default null
)
returns public.carriers
language plpgsql
security definer
set search_path = public
as $$
declare
  new_carrier public.carriers;
begin
  if auth.uid() is null then
    raise exception 'Přihlášení je povinné';
  end if;

  if nullif(trim(coalesce(p_legal_name,'')), '') is null then
    raise exception 'Název dopravce je povinný';
  end if;

  if exists (
    select 1 from public.carrier_members cm
    where cm.user_id = auth.uid()
      and cm.status = 'active'
  ) then
    raise exception 'Tento účet již má aktivního dopravce';
  end if;

  insert into public.carriers (
    legal_name, business_name, ico, dic, email, phone,
    street, city, postal_code, status
  )
  values (
    trim(p_legal_name),
    nullif(trim(coalesce(p_business_name,'')), ''),
    nullif(trim(coalesce(p_ico,'')), ''),
    nullif(trim(coalesce(p_dic,'')), ''),
    nullif(trim(coalesce(p_email,'')), ''),
    nullif(trim(coalesce(p_phone,'')), ''),
    nullif(trim(coalesce(p_street,'')), ''),
    nullif(trim(coalesce(p_city,'')), ''),
    nullif(trim(coalesce(p_postal_code,'')), ''),
    'pending'
  )
  returning * into new_carrier;

  insert into public.carrier_members (carrier_id, user_id, member_role, status)
  values (new_carrier.id, auth.uid(), 'owner', 'active');

  return new_carrier;
exception
  when unique_violation then
    raise exception 'Dopravce s tímto IČO již existuje';
end;
$$;

revoke all on function public.register_carrier(text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.register_carrier(text,text,text,text,text,text,text,text,text) to authenticated;