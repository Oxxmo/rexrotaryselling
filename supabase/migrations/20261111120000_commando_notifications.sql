-- ============================================================
--  Rex Commando — notifications sur téléphone (Web Push)
-- ------------------------------------------------------------
--  Même principe que Flash Live PO : chaque appareil s'abonne
--  (commando_push), la base dépose les messages dans une file
--  (commando_notifications) et appelle l'Edge Function
--  « commando-notifier » (pg_net + secret Vault), qui les envoie.
--  Les clés VAPID sont créées par la fonction et gardées dans Vault
--  (« commando_vapid ») : la clé privée ne quitte jamais le serveur.
--
--  Messages (jamais de nom de client, comme sur Live PO) :
--    rdv              à toute l'équipe sauf l'auteur, de 8 h à 20 h ;
--    vote_ouvert      aux commerciaux ;
--    vote_rappel      aux commerciaux qui n'ont pas voté, 30 min avant la clôture ;
--    listes_publiees  à toute l'équipe ;
--    debut_commando   aux commerciaux, le lundi à 13 h 50 si la semaine est publiée ;
--    veille           au responsable (veille terminée ou en erreur) ;
--    test             à soi-même (bouton « Tester »).
-- ============================================================

create table if not exists public.commando_push (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  actif           boolean not null default true,
  cree_le         timestamptz not null default now(),
  dernier_ok_le   timestamptz,
  derniere_erreur text
);
comment on table public.commando_push is 'Abonnements Web Push des membres du commando (un par appareil).';
create index if not exists commando_push_user_idx on public.commando_push(user_id) where actif;

create table if not exists public.commando_notifications (
  id          bigint generated always as identity primary key,
  type        text not null check (type in ('rdv','vote_ouvert','vote_rappel','listes_publiees','debut_commando','veille','test')),
  titre       text not null,
  corps       text not null,
  url         text,
  cible       jsonb not null default '{}'::jsonb,   -- {"roles":[…], "users":[…], "sauf":[…], "non_votants": "<semaine_id>"}
  cree_le     timestamptz not null default now(),
  etat        text not null default 'en_attente' check (etat in ('en_attente','envoyee','echec','sans_destinataire')),
  tentatives  int not null default 0,
  envoye_le   timestamptz,
  resultat    jsonb
);
comment on table public.commando_notifications is 'File des notifications du commando, envoyées par l''Edge Function commando-notifier.';
create index if not exists commando_notifications_attente_idx on public.commando_notifications(cree_le) where etat = 'en_attente';

alter table public.commando_push enable row level security;
alter table public.commando_notifications enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_push' and policyname = 'commando_push_select') then
    create policy commando_push_select on public.commando_push for select to authenticated
      using ( user_id = (select auth.uid()) );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_notifications' and policyname = 'commando_notifications_select') then
    create policy commando_notifications_select on public.commando_notifications for select to authenticated
      using ( (select public.commando_est_responsable(auth.uid())) );
  end if;
end $$;
revoke all on public.commando_push, public.commando_notifications from anon, authenticated;
grant select on public.commando_push, public.commando_notifications to authenticated;

-- ------------------------------------------------------------
-- 1) Abonnement d'un appareil
-- ------------------------------------------------------------
create or replace function public.commando_push_abonner(_endpoint text, _p256dh text, _auth text, _ua text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_membre(auth.uid()) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  if coalesce(_endpoint, '') !~ '^https://' or coalesce(_p256dh, '') = '' or coalesce(_auth, '') = '' then
    raise exception 'Abonnement incomplet';
  end if;
  insert into public.commando_push (user_id, endpoint, p256dh, auth, user_agent, actif)
  values (auth.uid(), _endpoint, _p256dh, _auth, left(_ua, 300), true)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, actif = true, derniere_erreur = null;
  return jsonb_build_object('appareils', (select count(*) from public.commando_push where user_id = auth.uid() and actif));
end $$;
revoke all on function public.commando_push_abonner(text, text, text, text) from public, anon;
grant execute on function public.commando_push_abonner(text, text, text, text) to authenticated;

create or replace function public.commando_push_desabonner(_endpoint text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.commando_push set actif = false where endpoint = _endpoint and user_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.commando_push_desabonner(text) from public, anon;
grant execute on function public.commando_push_desabonner(text) to authenticated;

-- ------------------------------------------------------------
-- 2) Destinataires d'une notification (Edge Function, service_role)
-- ------------------------------------------------------------
create or replace function public.commando_notif_destinataires(_id bigint)
returns table (id uuid, user_id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public, pg_temp as $$
  with n as (select cible from public.commando_notifications where commando_notifications.id = _id),
  gens as (
    select m.user_id from public.commando_membres m, n
     where m.role in (select jsonb_array_elements_text(coalesce(n.cible->'roles', '[]'::jsonb)))
    union
    select (x)::uuid from n, jsonb_array_elements_text(coalesce(n.cible->'users', '[]'::jsonb)) x
  ),
  filtres as (
    select g.user_id from gens g, n
     where not (g.user_id::text in (select jsonb_array_elements_text(coalesce(n.cible->'sauf', '[]'::jsonb))))
       and (n.cible->>'non_votants' is null or not exists (
             select 1 from public.commando_vote_participations vp
              where vp.semaine_id = (n.cible->>'non_votants')::uuid and vp.commercial_id = g.user_id))
  )
  select p.id, p.user_id, p.endpoint, p.p256dh, p.auth
    from public.commando_push p join filtres f on f.user_id = p.user_id
   where p.actif;
$$;
revoke all on function public.commando_notif_destinataires(bigint) from public, anon, authenticated;
grant execute on function public.commando_notif_destinataires(bigint) to service_role;

-- Clés VAPID dans Vault (créées une fois par l'Edge Function).
create or replace function public.commando_vapid_lire()
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'commando_vapid' limit 1;
$$;
revoke all on function public.commando_vapid_lire() from public, anon, authenticated;
grant execute on function public.commando_vapid_lire() to service_role;

create or replace function public.commando_vapid_creer(_valeur text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'commando_vapid') then return false; end if;
  perform vault.create_secret(_valeur, 'commando_vapid', 'Clés VAPID des notifications Rex Commando');
  return true;
end $$;
revoke all on function public.commando_vapid_creer(text) from public, anon, authenticated;
grant execute on function public.commando_vapid_creer(text) to service_role;

-- ------------------------------------------------------------
-- 3) Déposer une notification et réveiller l'Edge Function.
--    Ne fait jamais échouer l'action qui l'a déclenchée.
-- ------------------------------------------------------------
create or replace function public.commando_notif_appeler(_id bigint)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url    text := (select functions_base_url from public.commando_parametres where id);
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'commando_cron_secret' limit 1);
begin
  update public.commando_notifications set tentatives = tentatives + 1 where id = _id;
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url     := v_url || '/commando-notifier',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-commando-secret', v_secret),
    body    := jsonb_build_object('action', 'envoyer', 'id', _id),
    timeout_milliseconds := 15000);
exception when others then
  raise warning 'commando_notif_appeler : %', sqlerrm;
end $$;
revoke all on function public.commando_notif_appeler(bigint) from public, anon, authenticated;

create or replace function public.commando_notifier(_type text, _titre text, _corps text, _url text, _cible jsonb)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  insert into public.commando_notifications (type, titre, corps, url, cible)
  values (_type, left(_titre, 120), left(_corps, 400), _url, coalesce(_cible, '{}'::jsonb))
  returning id into v_id;
  perform public.commando_notif_appeler(v_id);
  return v_id;
exception when others then
  raise warning 'commando_notifier : %', sqlerrm;
  return null;
end $$;
revoke all on function public.commando_notifier(text, text, text, text, jsonb) from public, anon, authenticated;

-- Relance des messages restés en attente (Edge Function injoignable).
create or replace function public.commando_notif_relancer()
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id from public.commando_notifications
            where etat = 'en_attente' and cree_le < now() - interval '2 minutes' and cree_le > now() - interval '2 hours'
              and tentatives < 3
  loop
    perform public.commando_notif_appeler(r.id); n := n + 1;
  end loop;
  update public.commando_notifications set etat = 'echec', resultat = coalesce(resultat, '{}'::jsonb) || '{"erreur": "pas d''envoi après 3 tentatives"}'::jsonb
   where etat = 'en_attente' and (tentatives >= 3 or cree_le <= now() - interval '2 hours') and cree_le < now() - interval '10 minutes';
  return n;
end $$;
revoke all on function public.commando_notif_relancer() from public, anon, authenticated;

-- Prénom d'un membre (pour les messages).
create or replace function public.commando_prenom(_uid uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(nullif(initcap(lower(split_part(trim(full_name), ' ', 1))), ''), 'Un commercial')
    from public.profiles where id = _uid;
$$;
revoke all on function public.commando_prenom(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4) Événements
-- ------------------------------------------------------------
-- RDV pris : toute l'équipe sauf l'auteur, de 8 h à 20 h (heure de Paris).
create or replace function public.commando_notif_rdv(_appel_id uuid, _maintenant timestamptz default now())
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a record; loc timestamp := _maintenant at time zone 'Europe/Paris'; v_n int; v_sujet text;
begin
  select * into a from public.commando_appels where id = _appel_id;
  if a.id is null or a.statut <> 'rdv' or extract(hour from loc) < 8 or extract(hour from loc) >= 20 then return null; end if;
  select count(*) into v_n from public.commando_appels
   where statut = 'rdv' and coalesce(rdv_statut, 'prevu') <> 'annule'
     and (created_at at time zone 'Europe/Paris')::date = loc::date;
  select titre into v_sujet from public.commando_thematiques where id = a.thematique_id;
  return public.commando_notifier('rdv',
    '🎉 RDV pour ' || public.commando_prenom(a.commercial_id) || ' !',
    case when v_sujet is not null then 'Sujet : ' || v_sujet || '. ' else '' end
      || case when v_n > 1 then v_n || 'e RDV de l''équipe aujourd''hui.' else 'Premier RDV de l''équipe aujourd''hui !' end,
    './#commando/ligue',
    jsonb_build_object('roles', jsonb_build_array('commercial', 'responsable'), 'sauf', jsonb_build_array(a.commercial_id)));
end $$;
revoke all on function public.commando_notif_rdv(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.commando_notif_rdv_trg()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.commando_notif_rdv(new.id);
  return new;
exception when others then
  raise warning 'commando_notif_rdv_trg : %', sqlerrm;
  return new;
end $$;
create or replace trigger trg_commando_notif_rdv
  after insert on public.commando_appels
  for each row when (new.statut = 'rdv') execute function public.commando_notif_rdv_trg();

-- Vote ouvert, listes publiées.
create or replace function public.commando_notif_semaine_trg()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sujets text;
begin
  if new.vote_ouvert_le is not null and new.vote_clos_le is null and new.statut = 'brouillon'
     and (old.vote_ouvert_le is null or old.vote_clos_le is not null) then
    perform public.commando_notifier('vote_ouvert', '🗳️ À vous de voter !',
      'Choisissez vos ' || coalesce(new.vote_nb_choix, 3) || ' sujets préférés pour le commando, avant '
        || to_char(new.vote_fin at time zone 'Europe/Paris', 'HH24"h"MI') || '.',
      './#commando/vote', jsonb_build_object('roles', jsonb_build_array('commercial')));
  end if;
  if new.statut = 'publiee' and old.statut is distinct from 'publiee' then
    select string_agg(titre, ' · ' order by ordre) into v_sujets
      from public.commando_thematiques where semaine_id = new.id and statut = 'retenue';
    perform public.commando_notifier('listes_publiees', '📞 Les listes de la semaine sont prêtes',
      coalesce(v_sujets, 'Les sujets sont retenus') || '. Ouvrez « Ma liste » et appuyez sur Démarrer.',
      './#commando/liste', jsonb_build_object('roles', jsonb_build_array('commercial', 'responsable')));
  end if;
  return new;
exception when others then
  raise warning 'commando_notif_semaine_trg : %', sqlerrm;
  return new;
end $$;
create or replace trigger trg_commando_notif_semaine
  after update on public.commando_semaines
  for each row execute function public.commando_notif_semaine_trg();

-- Veille terminée ou en erreur : au responsable.
create or replace function public.commando_notif_veille_trg()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nb int;
begin
  if old.statut = 'en_cours' and new.statut in ('terminee', 'erreur') and new.type in ('veille', 'regeneration') then
    select count(*) into v_nb from public.commando_thematiques where semaine_id = new.semaine_id and statut <> 'ecartee';
    perform public.commando_notifier('veille',
      case when new.statut = 'terminee' then '🔎 Veille terminée' else '⚠️ Veille en erreur' end,
      case when new.statut = 'terminee' then v_nb || ' sujets proposés pour la semaine.'
           else 'La veille n''a pas abouti : relancez-la depuis l''onglet Semaine.' end,
      './#commando/semaine', jsonb_build_object('roles', jsonb_build_array('responsable')));
  end if;
  return new;
exception when others then
  raise warning 'commando_notif_veille_trg : %', sqlerrm;
  return new;
end $$;
create or replace trigger trg_commando_notif_veille
  after update of statut on public.commando_generations
  for each row execute function public.commando_notif_veille_trg();

-- Rappel de vote (30 min avant la clôture) et début du commando (lundi 13 h 50).
create or replace function public.commando_notif_horaires(_maintenant timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record; loc timestamp := _maintenant at time zone 'Europe/Paris'; v_out jsonb := '[]'::jsonb;
  v_publiee record;
begin
  for s in select * from public.commando_semaines
            where vote_ouvert_le is not null and vote_clos_le is null
              and vote_fin between _maintenant + interval '20 minutes' and _maintenant + interval '35 minutes'
              and vote_ouvert_le < _maintenant - interval '20 minutes'
  loop
    if not exists (select 1 from public.commando_notifications where type = 'vote_rappel' and cible->>'non_votants' = s.id::text) then
      perform public.commando_notifier('vote_rappel', '⏳ Plus que 30 minutes pour voter',
        'Le vote des sujets se termine à ' || to_char(s.vote_fin at time zone 'Europe/Paris', 'HH24"h"MI') || '.',
        './#commando/vote', jsonb_build_object('roles', jsonb_build_array('commercial'), 'non_votants', s.id));
      v_out := v_out || jsonb_build_array('vote_rappel');
    end if;
  end loop;

  if extract(isodow from loc) = 1 and loc::time >= '13:50' and loc::time < '14:00'
     and not exists (select 1 from public.commando_notifications
                      where type = 'debut_commando' and cible->>'jour' = loc::date::text) then
    select * into v_publiee from public.commando_semaines
     where semaine = public.commando_semaine_cible(loc::date) and statut = 'publiee';
    if v_publiee.id is not null then
      perform public.commando_notifier('debut_commando', '⏰ Commando dans 10 minutes',
        'Ouvrez RexSeller, puis « Démarrer le commando » : vos rappels du jour passent en premier.',
        './#commando/liste', jsonb_build_object('roles', jsonb_build_array('commercial'), 'jour', loc::date));
      v_out := v_out || jsonb_build_array('debut_commando');
    end if;
  end if;
  return v_out;
end $$;
revoke all on function public.commando_notif_horaires(timestamptz) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('commando_notifs', '*/5 * * * *', 'select public.commando_notif_horaires(); select public.commando_notif_relancer();');
  end if;
end $$;
