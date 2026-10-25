-- ============================================================
--  Rex Commando — 6/ Veille IA en étapes courtes
-- ------------------------------------------------------------
--  Les Edge Functions sont limitées à 150 s (offre gratuite) ou 400 s
--  (offres payantes) par processus. Une veille complète (recherche web +
--  5 thématiques) dépasse ce délai. Elle est donc découpée en étapes de
--  moins de 90 s (recherche, puis une thématique à la fois), chacune
--  exécutée par un appel distinct de « commando-veille ».
--
--  L'état d'avancement est conservé dans commando_generations.etat
--  (jsonb) ; un job pg_cron relance l'étape suivante toutes les 20 s
--  (après un délai qui laisse l'ancien processus s'éteindre), détecte
--  les étapes interrompues et les relance une fois.
-- ============================================================

alter table public.commando_generations
  add column if not exists etat jsonb not null default '{}'::jsonb;

comment on column public.commando_generations.etat is
  'Avancement de la veille en étapes : phase, etape, total, libelle, en_vol, phase_debut, relance_apres, tentatives, propositions, ecrites, urls, usage.';

-- Lecture du secret partagé par l'Edge Function (clé service_role uniquement) :
-- sert aux relances internes entre étapes.
create or replace function public.commando_cron_secret()
returns text
language sql security definer set search_path = public, pg_temp as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'commando_cron_secret' limit 1
$$;
revoke all on function public.commando_cron_secret() from public, anon, authenticated;
grant execute on function public.commando_cron_secret() to service_role;

-- Relance des étapes en attente et détection des étapes interrompues.
create or replace function public.commando_veille_relancer()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url    text := (select functions_base_url from public.commando_parametres where id);
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'commando_cron_secret' limit 1);
  g record;
  n int := 0;
begin
  if v_url is null or v_secret is null then return 0; end if;

  -- 1) Étape « en vol » depuis trop longtemps : le processus a été coupé.
  for g in
    select id, etat from public.commando_generations
     where statut = 'en_cours'
       and coalesce(etat->>'en_vol', 'false') = 'true'
       and coalesce((etat->>'phase_debut')::timestamptz, lancee_le) < now() - interval '170 seconds'
  loop
    if coalesce((g.etat->>'tentatives')::int, 0) >= 2 then
      update public.commando_generations
         set statut = 'erreur', terminee_le = now(),
             erreur = 'Étape « ' || coalesce(g.etat->>'libelle', '?') || ' » interrompue deux fois (durée maximale de la fonction dépassée).',
             etat = etat || jsonb_build_object('en_vol', false)
       where id = g.id;
    else
      update public.commando_generations
         set etat = etat || jsonb_build_object('en_vol', false, 'tentatives', coalesce((g.etat->>'tentatives')::int, 0) + 1,
                                               'relance_apres', (now() + interval '25 seconds')::text,
                                               'note', 'étape interrompue, nouvelle tentative')
       where id = g.id;
    end if;
  end loop;

  -- 2) Étapes en attente dont le délai de relance est écoulé.
  for g in
    select id from public.commando_generations
     where statut = 'en_cours'
       and coalesce(etat->>'en_vol', 'false') <> 'true'
       and coalesce((etat->>'relance_apres')::timestamptz, lancee_le) <= now()
       and coalesce(etat->>'phase', '') <> ''
  loop
    -- Marqué « en vol » tout de suite pour ne pas relancer deux fois.
    update public.commando_generations
       set etat = etat || jsonb_build_object('en_vol', true, 'phase_debut', now()::text)
     where id = g.id;
    perform net.http_post(
      url     := v_url || '/commando-veille',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-commando-secret', v_secret),
      body    := jsonb_build_object('generation_id', g.id, 'interne', true),
      timeout_milliseconds := 15000);
    n := n + 1;
  end loop;
  return n;
exception when others then
  raise warning 'commando_veille_relancer : %', sqlerrm;
  return n;
end $$;
revoke all on function public.commando_veille_relancer() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_veille_relance')
      where exists (select 1 from cron.job where jobname = 'commando_veille_relance');
    perform cron.schedule('commando_veille_relance', '20 seconds', 'select public.commando_veille_relancer()');
  end if;
end $$;

-- Le job toutes les 20 s remplit cron.job_run_details : purge quotidienne
-- des exécutions de plus de 7 jours.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_nettoyage_cron')
      where exists (select 1 from cron.job where jobname = 'commando_nettoyage_cron');
    perform cron.schedule('commando_nettoyage_cron', '0 3 * * *',
      $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$);
  end if;
end $$;
