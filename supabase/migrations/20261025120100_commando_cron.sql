-- ============================================================
--  Rex Commando — 2/ Mise à jour hebdomadaire de la base
-- ------------------------------------------------------------
--  Chaque dimanche soir, pg_cron appelle l'Edge Function
--  « commando-import » via pg_net, avec un secret partagé lu dans
--  Vault. Le même secret est fourni à la fonction par
--  `supabase secrets set COMMANDO_CRON_SECRET=…`.
--
--  Mise en place du secret (une fois, dans l'éditeur SQL) :
--    select vault.create_secret('<valeur aléatoire>', 'commando_cron_secret',
--                               'Secret partagé pg_cron → commando-import');
-- ============================================================

alter table public.commando_parametres
  add column if not exists functions_base_url text not null
    default 'https://chryjpudxhfboutymyvf.supabase.co/functions/v1';

create or replace function public.commando_cron_import()
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url    text := (select functions_base_url from public.commando_parametres where id);
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'commando_cron_secret' limit 1);
begin
  if v_url is null or v_secret is null then
    raise warning 'commando_cron_import : URL des fonctions ou secret Vault manquant, import non lancé';
    return;
  end if;
  perform net.http_post(
    url     := v_url || '/commando-import',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-commando-secret', v_secret),
    body    := '{"declencheur":"cron"}'::jsonb,
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'commando_cron_import : %', sqlerrm;
end $$;
revoke all on function public.commando_cron_import() from public, anon, authenticated;

-- Dimanche 20 h UTC (21 h en hiver, 22 h en été, heure de Paris).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_import_hebdo')
      where exists (select 1 from cron.job where jobname = 'commando_import_hebdo');
    perform cron.schedule('commando_import_hebdo', '0 20 * * 0', 'select public.commando_cron_import()');
  end if;
end $$;
