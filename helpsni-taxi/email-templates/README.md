# Helpsni Auth e-mail template

Branded confirmation e-mail for the Helpsni registration flow.

## Supabase variable

The confirmation button uses:

`{{ .ConfirmationURL }}`

This is the Supabase Auth confirmation URL and must remain unchanged.

## Hosted Supabase

The project `ffiuzcrjunzthgredrqu` is currently on the Supabase Free plan and was created on 15 July 2026. Supabase currently blocks custom Auth templates on new Free-plan projects when the default Supabase SMTP service is used.

After a custom SMTP provider is configured, this HTML can be used as the **Confirm signup** template.

The template is intentionally self-contained with inline CSS for broad email-client compatibility.
