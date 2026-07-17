HELPSNI ONLINE – NASTAVENÍ

1) V Supabase otevři SQL Editor a spusť celý soubor supabase/schema.sql.
   POZOR: instalační skript smaže staré testovací tabulky Helpsni.

2) V Supabase otevři Settings → API Keys a zkopíruj Publishable key
   (začíná sb_publishable_...). Nikdy nepoužívej Secret key.

3) Otevři config.js a nahraď text:
   VLOZ_SEM_PUBLISHABLE_KEY_ZE_SUPABASE
   celým Publishable key.

4) Nahraj všechny soubory na GitHub. Vercel: Framework Preset = Other,
   bez npm, bez Build Command a bez Environment Variables.

5) V Supabase Authentication → URL Configuration nastav Site URL na adresu webu
   a případně vypni Confirm email jen pro rychlé testování.

Potom budou účty, zakázky i chat společné mezi mobilem a PC.
