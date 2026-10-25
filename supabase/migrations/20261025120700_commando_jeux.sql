-- ============================================================
--  Rex Commando — 8/ Jeux du commando
-- ------------------------------------------------------------
--  Trois jeux pendant les créneaux d'appel (une heure chacun) :
--
--   1. « Premier RDV de l'heure » : le premier commercial qui enregistre
--      un RDV dans le créneau reçoit N fiches « premium » du secteur libre
--      (5 par défaut) ; chaque RDV suivant vaut 1 fiche.
--   4. « Pronostic » : au début du créneau, chacun annonce son nombre de
--      RDV (1 à 5). Tenir ou dépasser son pronostic débloque une fiche
--      mystère (la meilleure fiche disponible du secteur libre).
--   5. « Ligue » : classement en direct et badges (Ouvreur, Marathonien,
--      Sniper, Fidèle). Le Fidèle est celui qui a le plus de RDV honorés
--      VALIDÉS PAR LE RESPONSABLE sur les 4 semaines précédentes ; il
--      reçoit 10 fiches à la publication de la semaine.
--
--  Les récompenses sont toujours des fiches d'entreprises (jamais de
--  l'argent) : des entreprises du secteur libre, affectées au commercial
--  et visibles dans « Ma liste ». Un RDV annulé reprend sa récompense.
--  Le responsable valide les RDV honorés (bloc « RDV à valider »).
--  Tout est calculé à partir des appels enregistrés ; rien d'autre à
--  saisir à part le pronostic.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Paramètres et colonnes
-- ------------------------------------------------------------
alter table public.commando_parametres
  add column if not exists jeux jsonb not null default
    '{"premier_rdv": true, "pronostic": true, "ligue": true,
      "fiches_premier_rdv": 5, "fiches_rdv": 1, "fiches_fidele": 10,
      "max_fiches_semaine": 15, "semaines_fidele": 4, "delai_pronostic_min": 20}'::jsonb;
comment on column public.commando_parametres.jeux is
  'Jeux du commando : activation (premier_rdv, pronostic, ligue), nombre de fiches par récompense, plafond par commercial et par semaine, fenêtre du Fidèle (semaines), délai pour pronostiquer (minutes après le début du créneau).';

alter table public.commando_appels
  add column if not exists rdv_valide_le timestamptz,
  add column if not exists rdv_valide_par uuid references public.profiles(id) on delete set null;
comment on column public.commando_appels.rdv_valide_le is 'RDV honoré ou annulé, validé par le responsable (seuls les RDV validés comptent pour le badge Fidèle).';

create table if not exists public.commando_recompenses (
  id            uuid primary key default gen_random_uuid(),
  commercial_id uuid not null references public.profiles(id) on delete cascade,
  semaine_id    uuid references public.commando_semaines(id) on delete set null,
  type          text not null check (type in ('premier_rdv','rdv_bonus','fiche_mystere','fidele')),
  siret         text not null references public.commando_entreprises(siret) on delete cascade,
  appel_id      uuid references public.commando_appels(id) on delete set null,
  pronostic_id  uuid,
  creneau       timestamptz,
  statut        text not null default 'attribuee' check (statut in ('attribuee','reprise')),
  created_at    timestamptz not null default now()
);
create unique index if not exists commando_recompenses_siret_active_idx
  on public.commando_recompenses(siret) where statut = 'attribuee';
create index if not exists commando_recompenses_commercial_idx on public.commando_recompenses(commercial_id, semaine_id);

create table if not exists public.commando_pronostics (
  id            uuid primary key default gen_random_uuid(),
  commercial_id uuid not null references public.profiles(id) on delete cascade,
  semaine_id    uuid references public.commando_semaines(id) on delete set null,
  creneau       timestamptz not null,
  annonce       int not null check (annonce between 1 and 5),
  rdv_realises  int,
  reussi        boolean,
  resolu_le     timestamptz,
  created_at    timestamptz not null default now(),
  unique (commercial_id, creneau)
);

-- Créneau d'une heure (heure de Paris) auquel appartient un instant.
create or replace function public.commando_creneau(_ts timestamptz)
returns timestamptz
language sql immutable set search_path = public, pg_temp as $$
  select (date_trunc('hour', _ts at time zone 'Europe/Paris')) at time zone 'Europe/Paris'
$$;

-- Lundi d'une semaine ISO « AAAA-Www ».
create or replace function public.commando_lundi(_semaine text)
returns date
language sql immutable set search_path = public, pg_temp as $$
  select to_date(_semaine || '-1', 'IYYY-"W"IW-ID')
$$;

-- ------------------------------------------------------------
-- 2) Attribution de fiches du secteur libre
-- ------------------------------------------------------------
-- Les meilleures fiches disponibles : secteur libre, éligibles, non
-- attribuées, non appelées depuis 8 semaines ; vertes d'abord (ciblage de
-- la semaine), puis dirigeant connu, effectif élevé, ancienneté.
-- Plafond par commercial et par semaine (paramètre max_fiches_semaine).
create or replace function public.commando_jeux_attribuer(
  _commercial uuid, _semaine uuid, _type text, _n int, _appel uuid, _pronostic uuid, _creneau timestamptz)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_max int := coalesce((p->>'max_fiches_semaine')::int, 15);
  v_deja int; v_n int;
begin
  select count(*) into v_deja from public.commando_recompenses
   where commercial_id = _commercial and semaine_id = _semaine and statut = 'attribuee';
  v_n := least(coalesce(_n, 0), greatest(0, v_max - v_deja));
  if v_n <= 0 then return 0; end if;
  insert into public.commando_recompenses (commercial_id, semaine_id, type, siret, appel_id, pronostic_id, creneau)
  select _commercial, _semaine, _type, c.siret, _appel, _pronostic, _creneau
    from (
      select v.siret,
             coalesce(ci.rang, 3) as rang_couleur,
             (jsonb_array_length(coalesce(v.dirigeants, '[]'::jsonb)) > 0) as a_dirigeant,
             case v.tranche_effectif when '21' then 0 when '12' then 1 when '11' then 2 when '03' then 3 when '02' then 4 else 5 end as rang_tranche,
             (v.anciennete = 'plus_5') as ancienne
        from public.commando_entreprises_v v
        join public.commando_secteurs s on s.code = v.secteur_code and s.commercial_id is null
        left join lateral (
          select case ci.couleur when 'vert' then 0 when 'orange' then 1 when 'rouge' then 2 else 3 end as rang
            from public.commando_ciblages ci
            join public.commando_thematiques t on t.id = ci.thematique_id and t.statut = 'retenue'
           where ci.siret = v.siret and ci.semaine_id = _semaine
           order by 1 limit 1) ci on true
       where v.eligible
         and not exists (select 1 from public.commando_recompenses r where r.siret = v.siret and r.statut = 'attribuee')
         and not exists (select 1 from public.commando_appels a where a.siret = v.siret and a.created_at > now() - interval '8 weeks')
       order by rang_couleur, a_dirigeant desc, rang_tranche, ancienne desc, random()
       limit v_n
    ) c;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.commando_jeux_attribuer(uuid, uuid, text, int, uuid, uuid, timestamptz) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Résolution des jeux (appelée à la demande et par pg_cron)
-- ------------------------------------------------------------
create or replace function public.commando_jeux_resoudre()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  r record; v_cnt int;
  n_premier int := 0; n_bonus int := 0; n_mystere int := 0; n_reprises int := 0;
begin
  -- Récompenses reprises : le RDV a été annulé.
  update public.commando_recompenses x set statut = 'reprise'
    from public.commando_appels a
   where a.id = x.appel_id and x.statut = 'attribuee' and a.rdv_statut = 'annule';
  get diagnostics n_reprises = row_count;

  if coalesce((p->>'premier_rdv')::boolean, true) then
    -- Premier RDV de chaque créneau (7 derniers jours).
    for r in
      select distinct on (c.creneau) c.id, c.commercial_id, c.semaine_id, c.creneau
        from (select a.*, public.commando_creneau(a.created_at) as creneau
                from public.commando_appels a
               where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
                 and a.semaine_id is not null and a.created_at > now() - interval '7 days') c
       order by c.creneau, c.created_at
    loop
      if not exists (select 1 from public.commando_recompenses x where x.type = 'premier_rdv' and x.creneau = r.creneau) then
        n_premier := n_premier + public.commando_jeux_attribuer(r.commercial_id, r.semaine_id, 'premier_rdv',
                       coalesce((p->>'fiches_premier_rdv')::int, 5), r.id, null, r.creneau);
      end if;
    end loop;
    -- Chaque autre RDV vaut une fiche.
    for r in
      select a.id, a.commercial_id, a.semaine_id, public.commando_creneau(a.created_at) as creneau
        from public.commando_appels a
       where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
         and a.semaine_id is not null and a.created_at > now() - interval '7 days'
         and not exists (select 1 from public.commando_recompenses x where x.appel_id = a.id)
       order by a.created_at
    loop
      n_bonus := n_bonus + public.commando_jeux_attribuer(r.commercial_id, r.semaine_id, 'rdv_bonus',
                   coalesce((p->>'fiches_rdv')::int, 1), r.id, null, r.creneau);
    end loop;
  end if;

  if coalesce((p->>'pronostic')::boolean, true) then
    for r in
      select * from public.commando_pronostics
       where resolu_le is null and creneau + interval '1 hour' <= now()
    loop
      select count(*) into v_cnt from public.commando_appels a
       where a.commercial_id = r.commercial_id and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
         and public.commando_creneau(a.created_at) = r.creneau;
      update public.commando_pronostics set rdv_realises = v_cnt, reussi = (v_cnt >= r.annonce), resolu_le = now() where id = r.id;
      if v_cnt >= r.annonce then
        n_mystere := n_mystere + public.commando_jeux_attribuer(r.commercial_id, r.semaine_id, 'fiche_mystere', 1, null, r.id, r.creneau);
      end if;
    end loop;
  end if;

  return jsonb_build_object('premier_rdv', n_premier, 'rdv_bonus', n_bonus, 'fiche_mystere', n_mystere, 'reprises', n_reprises);
end $$;
revoke all on function public.commando_jeux_resoudre() from public, anon;
grant execute on function public.commando_jeux_resoudre() to authenticated;

-- ------------------------------------------------------------
-- 4) Pronostic du créneau en cours
-- ------------------------------------------------------------
create or replace function public.commando_pronostic(_semaine_id uuid, _annonce int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_creneau timestamptz := public.commando_creneau(now());
  v_delai int := coalesce((p->>'delai_pronostic_min')::int, 20);
  v_id uuid;
begin
  if not public.commando_est_membre(auth.uid()) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  if not coalesce((p->>'pronostic')::boolean, true) then raise exception 'Le jeu du pronostic est désactivé'; end if;
  if _annonce is null or _annonce < 1 or _annonce > 5 then raise exception 'Le pronostic va de 1 à 5 RDV'; end if;
  if now() > v_creneau + make_interval(mins => v_delai) then
    raise exception 'Trop tard : le pronostic se fait dans les % premières minutes du créneau', v_delai;
  end if;
  if exists (select 1 from public.commando_appels a where a.commercial_id = auth.uid() and a.statut = 'rdv'
               and public.commando_creneau(a.created_at) = v_creneau) then
    raise exception 'Vous avez déjà un RDV sur ce créneau : le pronostic se fait avant';
  end if;
  insert into public.commando_pronostics (commercial_id, semaine_id, creneau, annonce)
  values (auth.uid(), _semaine_id, v_creneau, _annonce)
  on conflict (commercial_id, creneau) do update set annonce = excluded.annonce, semaine_id = excluded.semaine_id
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'creneau', v_creneau, 'annonce', _annonce);
end $$;
revoke all on function public.commando_pronostic(uuid, int) from public, anon;
grant execute on function public.commando_pronostic(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- 5) État des jeux pour l'appelant (carte « Jeux de l'heure » de Ma liste)
-- ------------------------------------------------------------
create or replace function public.commando_jeux_etat(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_uid uuid := auth.uid();
  v_creneau timestamptz := public.commando_creneau(now());
  v_delai int := coalesce((p->>'delai_pronostic_min')::int, 20);
  v_sem text := (select semaine from public.commando_semaines where id = _semaine_id);
  v_res jsonb;
begin
  if not public.commando_est_membre(v_uid) then return '{}'::jsonb; end if;
  perform public.commando_jeux_resoudre();
  select jsonb_build_object(
    'actifs', jsonb_build_object('premier_rdv', coalesce((p->>'premier_rdv')::boolean, true),
                                 'pronostic', coalesce((p->>'pronostic')::boolean, true),
                                 'ligue', coalesce((p->>'ligue')::boolean, true)),
    'creneau', jsonb_build_object(
      'debut', v_creneau, 'fin', v_creneau + interval '1 hour',
      'peut_pronostiquer', now() <= v_creneau + make_interval(mins => v_delai)
                           and not exists (select 1 from public.commando_appels a where a.commercial_id = v_uid and a.statut = 'rdv' and public.commando_creneau(a.created_at) = v_creneau),
      'delai_min', v_delai,
      'pronostic', (select jsonb_build_object('annonce', annonce, 'rdv_realises', rdv_realises, 'reussi', reussi, 'resolu', resolu_le is not null)
                      from public.commando_pronostics where commercial_id = v_uid and creneau = v_creneau),
      'mes_rdv', (select count(*) from public.commando_appels a where a.commercial_id = v_uid and a.statut = 'rdv'
                    and coalesce(a.rdv_statut, 'prevu') <> 'annule' and public.commando_creneau(a.created_at) = v_creneau),
      'premier_rdv', (select jsonb_build_object('commercial_id', a.commercial_id, 'a', a.created_at)
                        from public.commando_appels a
                       where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule' and public.commando_creneau(a.created_at) = v_creneau
                       order by a.created_at limit 1)),
    'pronostics_jour', (select coalesce(jsonb_agg(jsonb_build_object('creneau', creneau, 'annonce', annonce, 'rdv_realises', rdv_realises, 'reussi', reussi, 'resolu', resolu_le is not null) order by creneau), '[]'::jsonb)
                          from public.commando_pronostics where commercial_id = v_uid and creneau::date = (now() at time zone 'Europe/Paris')::date and creneau <> v_creneau),
    'nb_recompenses_semaine', (select count(*) from public.commando_recompenses where commercial_id = v_uid and semaine_id = _semaine_id and statut = 'attribuee'),
    'max_fiches_semaine', coalesce((p->>'max_fiches_semaine')::int, 15),
    'recompenses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'recompense', r.type, 'recompense_le', r.created_at,
        'siret', v.siret, 'raison_sociale', v.raison_sociale, 'enseigne', v.enseigne, 'naf_code', v.naf_code, 'naf_libelle', v.naf_libelle,
        'tranche_effectif', v.tranche_effectif, 'annee_effectif', v.annee_effectif, 'anciennete', v.anciennete, 'date_creation_ul', v.date_creation_ul,
        'dirigeants', v.dirigeants, 'adresse', v.adresse, 'code_postal', v.code_postal, 'commune', v.commune, 'secteur_code', v.secteur_code,
        'est_nouvelle', (v.nouvelle_semaine is not null and v.nouvelle_semaine = v_sem), 'telephone', v.telephone, 'email', v.email,
        'thematique_id', ch.thematique_id, 'thematique_titre', ch.titre, 'couleur', ch.couleur, 'regle_index', ch.regle_index, 'raison', ch.raison,
        'dernier_appel_le', d.created_at, 'dernier_appel_statut', d.statut, 'dernier_appel_par', d.commercial_id,
        'bloquee_jusqua', null, 'deja_appelee', (d.created_at is not null and d.created_at > r.created_at), 'nb_appels', coalesce(nb.n, 0)
      ) order by (d.created_at is not null and d.created_at > r.created_at), r.created_at desc), '[]'::jsonb)
        from public.commando_recompenses r
        join public.commando_entreprises_v v on v.siret = r.siret
        left join lateral (
          select ci.thematique_id, t.titre, ci.couleur, ci.regle_index, ci.raison
            from public.commando_ciblages ci join public.commando_thematiques t on t.id = ci.thematique_id and t.statut = 'retenue'
           where ci.siret = v.siret and ci.semaine_id = _semaine_id
           order by case ci.couleur when 'vert' then 1 when 'orange' then 2 when 'rouge' then 3 else 4 end, t.ordre limit 1) ch on true
        left join lateral (select a.created_at, a.statut, a.commercial_id from public.commando_appels a where a.siret = v.siret order by a.created_at desc limit 1) d on true
        left join lateral (select count(*) as n from public.commando_appels a where a.siret = v.siret) nb on true
       where r.commercial_id = v_uid and r.statut = 'attribuee'
         and (r.semaine_id = _semaine_id or d.created_at is null or d.created_at <= r.created_at))
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_jeux_etat(uuid) from public, anon;
grant execute on function public.commando_jeux_etat(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6) Ligue : classement, badges, créneaux, Fidèle
-- ------------------------------------------------------------
create or replace function public.commando_ligue(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_sem record;
  v_lundi date;
  v_fenetre int := coalesce((p->>'semaines_fidele')::int, 4);
  v_res jsonb;
begin
  if not public.commando_est_membre(auth.uid()) then return '{}'::jsonb; end if;
  select * into v_sem from public.commando_semaines where id = _semaine_id;
  if v_sem.id is null then return '{}'::jsonb; end if;
  v_lundi := public.commando_lundi(v_sem.semaine);
  perform public.commando_jeux_resoudre();

  with membres as (
    select m.user_id, m.role from public.commando_membres m
  ),
  par as (
    select m.user_id, m.role,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id) as appels,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as rdv,
      (select min(a.created_at) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as premier_rdv,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.statut = 'rdv'
         and a.rdv_statut = 'honore' and a.rdv_valide_le is not null
         and a.date_rdv >= (v_lundi - v_fenetre * 7)::timestamptz and a.date_rdv < v_lundi::timestamptz) as honores_valides,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.statut = 'rdv'
         and a.rdv_statut = 'honore' and a.rdv_valide_le is not null) as honores_valides_total,
      (select count(*) from public.commando_recompenses r where r.commercial_id = m.user_id and r.semaine_id = _semaine_id and r.statut = 'attribuee') as fiches_gagnees,
      (select count(*) from public.commando_pronostics x where x.commercial_id = m.user_id and x.semaine_id = _semaine_id and x.reussi) as pronostics_reussis
    from membres m
  ),
  badges as (
    select
      (select user_id from par where premier_rdv is not null order by premier_rdv limit 1) as ouvreur,
      (select user_id from par where appels > 0 order by appels desc, rdv desc limit 1) as marathonien,
      (select user_id from par where appels >= 10 order by rdv::numeric / appels desc, rdv desc limit 1) as sniper,
      (select user_id from par where honores_valides > 0 order by honores_valides desc, honores_valides_total desc limit 1) as fidele
  ),
  creneaux as (
    select c.creneau, c.commercial_id, c.created_at,
           (select count(*) from public.commando_appels a2 where a2.semaine_id = _semaine_id and a2.statut = 'rdv'
              and coalesce(a2.rdv_statut, 'prevu') <> 'annule' and public.commando_creneau(a2.created_at) = c.creneau) as rdv_creneau
      from (select distinct on (public.commando_creneau(a.created_at)) public.commando_creneau(a.created_at) as creneau, a.commercial_id, a.created_at
              from public.commando_appels a
             where a.semaine_id = _semaine_id and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
             order by public.commando_creneau(a.created_at), a.created_at) c
  )
  select jsonb_build_object(
    'semaine', v_sem.semaine, 'lundi', v_lundi, 'fenetre_fidele', v_fenetre,
    'actif', coalesce((p->>'ligue')::boolean, true),
    'classement', (select coalesce(jsonb_agg(jsonb_build_object(
        'commercial_id', user_id, 'role', role, 'appels', appels, 'rdv', rdv,
        'taux', case when appels > 0 then round(rdv::numeric / appels, 3) else null end,
        'premier_rdv', premier_rdv, 'honores_valides', honores_valides, 'fiches_gagnees', fiches_gagnees, 'pronostics_reussis', pronostics_reussis,
        'badges', (select coalesce(jsonb_agg(b), '[]'::jsonb) from (
            select 'ouvreur' as b from badges where ouvreur = par.user_id union all
            select 'marathonien' from badges where marathonien = par.user_id union all
            select 'sniper' from badges where sniper = par.user_id union all
            select 'fidele' from badges where fidele = par.user_id) x)
      ) order by rdv desc, appels desc), '[]'::jsonb) from par),
    'creneaux', (select coalesce(jsonb_agg(jsonb_build_object('creneau', creneau, 'commercial_id', commercial_id, 'a', created_at, 'rdv', rdv_creneau) order by creneau desc), '[]'::jsonb) from creneaux),
    'total_rdv', (select coalesce(sum(rdv), 0) from par),
    'total_appels', (select coalesce(sum(appels), 0) from par),
    'fidele', (select fidele from badges),
    'a_valider', (select count(*) from public.commando_appels a where a.statut = 'rdv' and a.rdv_valide_le is null
                    and coalesce(a.rdv_statut, 'prevu') <> 'annule' and a.date_rdv < now())
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_ligue(uuid) from public, anon;
grant execute on function public.commando_ligue(uuid) to authenticated;

-- Validation d'un RDV par le responsable (honoré ou annulé).
create or replace function public.commando_rdv_valider(_appel_id uuid, _statut text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if _statut not in ('honore', 'annule') then raise exception 'Statut invalide (honore ou annule)'; end if;
  update public.commando_appels
     set rdv_statut = _statut, rdv_valide_le = now(), rdv_valide_par = auth.uid()
   where id = _appel_id and statut = 'rdv';
  if not found then raise exception 'RDV introuvable'; end if;
  perform public.commando_jeux_resoudre();
end $$;
revoke all on function public.commando_rdv_valider(uuid, text) from public, anon;
grant execute on function public.commando_rdv_valider(uuid, text) to authenticated;

-- Fidèle : à la publication d'une semaine, le commercial qui a le plus de
-- RDV honorés validés sur la fenêtre reçoit ses fiches (une fois par semaine).
create or replace function public.commando_jeux_fidele(_semaine_id uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_sem record; v_lundi date; v_fenetre int := coalesce((p->>'semaines_fidele')::int, 4);
  v_fidele uuid;
begin
  if not coalesce((p->>'ligue')::boolean, true) then return 0; end if;
  select * into v_sem from public.commando_semaines where id = _semaine_id;
  if v_sem.id is null then return 0; end if;
  if exists (select 1 from public.commando_recompenses where semaine_id = _semaine_id and type = 'fidele') then return 0; end if;
  v_lundi := public.commando_lundi(v_sem.semaine);
  select a.commercial_id into v_fidele
    from public.commando_appels a
    join public.commando_membres m on m.user_id = a.commercial_id
   where a.statut = 'rdv' and a.rdv_statut = 'honore' and a.rdv_valide_le is not null
     and a.date_rdv >= (v_lundi - v_fenetre * 7)::timestamptz and a.date_rdv < v_lundi::timestamptz
   group by a.commercial_id
   order by count(*) desc, min(a.date_rdv)
   limit 1;
  if v_fidele is null then return 0; end if;
  return public.commando_jeux_attribuer(v_fidele, _semaine_id, 'fidele', coalesce((p->>'fiches_fidele')::int, 10), null, null, null);
end $$;
revoke all on function public.commando_jeux_fidele(uuid) from public, anon, authenticated;

create or replace function public.commando_semaine_publiee_trg()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.statut = 'publiee' and (old.statut is distinct from 'publiee') then
    perform public.commando_jeux_fidele(new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_commando_semaine_publiee on public.commando_semaines;
create trigger trg_commando_semaine_publiee
  after update of statut on public.commando_semaines
  for each row execute function public.commando_semaine_publiee_trg();

-- ------------------------------------------------------------
-- 7) Sécurité (RLS) : lecture seule, écriture par les fonctions
-- ------------------------------------------------------------
alter table public.commando_recompenses enable row level security;
alter table public.commando_pronostics enable row level security;
drop policy if exists commando_recompenses_select on public.commando_recompenses;
create policy commando_recompenses_select on public.commando_recompenses for select to authenticated
  using ( (select public.commando_est_membre(auth.uid()))
          and (commercial_id = auth.uid() or (select public.commando_est_responsable(auth.uid()))) );
drop policy if exists commando_pronostics_select on public.commando_pronostics;
create policy commando_pronostics_select on public.commando_pronostics for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
grant select on public.commando_recompenses, public.commando_pronostics to authenticated;

-- ------------------------------------------------------------
-- 8) Résolution périodique (pronostics en fin de créneau)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('commando_jeux_resolution')
      where exists (select 1 from cron.job where jobname = 'commando_jeux_resolution');
    perform cron.schedule('commando_jeux_resolution', '*/5 * * * *', 'select public.commando_jeux_resoudre()');
  end if;
end $$;
