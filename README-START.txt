HELPSNI ONLINE — RYCHLÉ SPUŠTĚNÍ

1) Supabase → SQL Editor → New query.
2) Vlož celý obsah supabase/upgrade-online.sql a klikni Run.
   Tento upgrade NESMAŽE existující uživatele ani tabulky.
3) Ve Vercelu nastav Environment Variables:
   SUPABASE_URL = https://ffiuzcrjunzthgredrqu.supabase.co
   SUPABASE_PUBLISHABLE_KEY = celý klíč sb_publishable_...
4) Nahraj obsah ZIPu na GitHub. Vercel nasadí novou verzi.
5) Táta se zaregistruje jako zákazník, ty jako pracovník. Zakázky a chat se synchronizují přes Supabase.

Poznámka: Pokud proměnné ve Vercelu chybí, aplikace zobrazí bezpečný formulář pro Publishable key.
