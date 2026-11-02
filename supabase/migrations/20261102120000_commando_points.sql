-- ============================================================
--  Rex Commando — 13/ Système de points
-- ------------------------------------------------------------
--  Chaque action du commando rapporte des points, cumulés sans limite
--  dans un relevé (commando_points, une ligne par événement, jamais
--  modifiée). Les mini-jeux (fiches, pronostic, badges) restent en place :
--  ils rapportent eux aussi des points. Le barème est dans
--  commando_parametres.jeux.points (modifiable dans Paramètres) :
--    appel 1 · rdv 10 (repris si annulé) · rdv_honore 25 (validé par le
--    responsable) · premier_rdv 15 · pronostic 10 · badge 20 (en fin de
--    semaine : Ouvreur, Marathonien, Sniper, Fidèle).
--  Le responsable peut ajuster à la main (bonus ou malus, motivé). Le type
--  « depense » est réservé à un usage futur des points.
--  L'attribution est idempotente (référence unique par type) : elle est
--  rejouée à chaque résolution des jeux (toutes les 5 min et à la demande).
-- ============================================================

create table if not exists public.commando_points (
  id            uuid primary key default gen_random_uuid(),
  commercial_id uuid not null references auth.users(id) on delete cascade,
  semaine_id    uuid references public.commando_semaines(id) on delete set null,
  type          text not null check (type in ('appel','rdv','rdv_annule','rdv_honore','premier_rdv','pronostic','badge','ajustement','depense')),
  points        int  not null,
  reference     text not null,                       -- appel:<id>, pronostic:<id>, badge:<semaine>:<badge>, …
  appel_id      uuid references public.commando_appels(id) on delete cascade,      -- un appel supprimé emporte ses points
  pronostic_id  uuid references public.commando_pronostics(id) on delete cascade,
  libelle       text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (type, reference)
);
create index if not exists commando_points_commercial_idx on public.commando_points (commercial_id, semaine_id);
create index if not exists commando_points_created_idx on public.commando_points (created_at desc);
alter table public.commando_points enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commando_points' and policyname = 'commando_points_select') then
    -- La ligue est transparente : tout membre voit le relevé de tous.
    create policy commando_points_select on public.commando_points
      for select to authenticated using (public.commando_est_membre(auth.uid()));
  end if;
end $$;
comment on table public.commando_points is 'Relevé de points du commando (une ligne par événement, référence unique par type).';

update public.commando_parametres
   set jeux = jeux || jsonb_build_object('points', '{"actif": true, "appel": 1, "rdv": 10, "rdv_honore": 25, "premier_rdv": 15, "pronostic": 10, "badge": 20}'::jsonb)
 where not (jeux ? 'points');

-- Barème courant, valeurs par défaut comprises.
create or replace function public.commando_points_bareme()
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select '{"actif": true, "appel": 1, "rdv": 10, "rdv_honore": 25, "premier_rdv": 15, "pronostic": 10, "badge": 20}'::jsonb
         || coalesce((select jeux->'points' from public.commando_parametres where id), '{}'::jsonb)
$$;
revoke all on function public.commando_points_bareme() from public, anon;
grant execute on function public.commando_points_bareme() to authenticated;

-- Badges d'une semaine (même logique que la ligue) : usage interne.
create or replace function public.commando_badges_semaine(_semaine_id uuid)
returns table (badge text, commercial_id uuid)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_sem record; v_lundi date; v_fenetre int := coalesce((p->>'semaines_fidele')::int, 4);
begin
  select * into v_sem from public.commando_semaines where id = _semaine_id;
  if v_sem.id is null then return; end if;
  v_lundi := public.commando_lundi(v_sem.semaine);
  return query
  with par as (
    select m.user_id,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id) as appels,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as rdv,
      (select min(a.created_at) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as premier_rdv,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.statut = 'rdv'
         and a.rdv_statut = 'honore' and a.rdv_valide_le is not null
         and a.date_rdv >= (v_lundi - v_fenetre * 7)::timestamptz and a.date_rdv < v_lundi::timestamptz) as honores_valides,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.statut = 'rdv'
         and a.rdv_statut = 'honore' and a.rdv_valide_le is not null) as honores_valides_total
    from public.commando_membres m
  )
  select 'ouvreur'::text, (select user_id from par where par.premier_rdv is not null order by par.premier_rdv limit 1)
  union all select 'marathonien', (select user_id from par where par.appels > 0 order by par.appels desc, par.rdv desc limit 1)
  union all select 'sniper', (select user_id from par where par.appels >= 10 order by par.rdv::numeric / par.appels desc, par.rdv desc limit 1)
  union all select 'fidele', (select user_id from par where par.honores_valides > 0 order by par.honores_valides desc, par.honores_valides_total desc limit 1);
end $$;
revoke all on function public.commando_badges_semaine(uuid) from public, anon, authenticated;

-- Attribution idempotente des points (interne : résolution des jeux, cron).
create or replace function public.commando_points_crediter()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b jsonb := public.commando_points_bareme();
  p jsonb := (select jeux from public.commando_parametres where id);
  n_total int := 0; n int;
begin
  if not coalesce((b->>'actif')::boolean, true) then return jsonb_build_object('actif', false); end if;

  -- 1) Un appel enregistré.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'appel', (b->>'appel')::int, 'appel:' || a.id, 'Appel passé', a.created_at, a.id
    from public.commando_appels a
   where a.semaine_id is not null and (b->>'appel')::int <> 0
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 2) Un RDV pris (repris s'il est annulé).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv', (b->>'rdv')::int, 'appel:' || a.id, 'RDV pris', a.created_at, a.id
    from public.commando_appels a
   where a.statut = 'rdv' and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv_annule', -x.points, 'appel:' || a.id, 'RDV annulé : points repris', a.id
    from public.commando_appels a
    join public.commando_points x on x.type = 'rdv' and x.reference = 'appel:' || a.id
   where a.statut = 'rdv' and a.rdv_statut = 'annule' and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 3) Un RDV honoré, validé par le responsable.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'rdv_honore', (b->>'rdv_honore')::int, 'appel:' || a.id, 'RDV honoré (validé)', a.rdv_valide_le, a.id
    from public.commando_appels a
   where a.statut = 'rdv' and a.rdv_statut = 'honore' and a.rdv_valide_le is not null and a.semaine_id is not null
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 4) Premier RDV d'un créneau de jeu (indépendant des fiches, qui peuvent être plafonnées).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select c.commercial_id, c.semaine_id, 'premier_rdv', (b->>'premier_rdv')::int, 'appel:' || c.id, 'Premier RDV de l''heure', c.created_at, c.id
    from (select distinct on (public.commando_creneau(a.created_at)) a.*
            from public.commando_appels a
           where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule' and a.semaine_id is not null
             and public.commando_jeux_heure_ok(a.created_at, p)
           order by public.commando_creneau(a.created_at), a.created_at) c
   where coalesce((p->>'premier_rdv')::boolean, true)
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 5) Un pronostic tenu.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, pronostic_id)
  select x.commercial_id, x.semaine_id, 'pronostic', (b->>'pronostic')::int, 'pronostic:' || x.id, 'Pronostic tenu (' || x.annonce || ' RDV)', x.resolu_le, x.id
    from public.commando_pronostics x
   where x.reussi
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  -- 6) Badges des semaines terminées (le lundi suivant au plus tôt).
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle)
  select bd.commercial_id, s.id, 'badge', (b->>'badge')::int, 'badge:' || s.semaine || ':' || bd.badge,
         'Badge ' || initcap(bd.badge) || ' (' || s.semaine || ')'
    from public.commando_semaines s
    cross join lateral public.commando_badges_semaine(s.id) bd
   where s.statut = 'publiee' and bd.commercial_id is not null
     and public.commando_lundi(s.semaine) + 7 <= (now() at time zone 'Europe/Paris')::date
     and coalesce((p->>'ligue')::boolean, true)
  on conflict (type, reference) do nothing;
  get diagnostics n = row_count; n_total := n_total + n;

  return jsonb_build_object('nouvelles_lignes', n_total);
end $$;
revoke all on function public.commando_points_crediter() from public, anon, authenticated;

-- Solde d'un commercial : total (toutes semaines) et semaine donnée.
create or replace function public.commando_points_solde(_commercial uuid, _semaine_id uuid)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'total',   coalesce((select sum(points) from public.commando_points where commercial_id = _commercial), 0),
    'semaine', coalesce((select sum(points) from public.commando_points where commercial_id = _commercial and semaine_id = _semaine_id), 0),
    'gagnes',  coalesce((select sum(points) from public.commando_points where commercial_id = _commercial and points > 0), 0),
    'bareme',  public.commando_points_bareme())
$$;
revoke all on function public.commando_points_solde(uuid, uuid) from public, anon;
grant execute on function public.commando_points_solde(uuid, uuid) to authenticated;

-- Ajustement manuel par le responsable (bonus ou malus, motivé).
create or replace function public.commando_points_ajuster(_commercial uuid, _points int, _libelle text, _semaine_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  if _points is null or _points = 0 or abs(_points) > 1000 then raise exception 'Points : entre -1000 et 1000, différent de 0'; end if;
  if coalesce(trim(_libelle), '') = '' then raise exception 'Un motif est obligatoire'; end if;
  if not public.commando_est_membre(_commercial) then raise exception 'Commercial inconnu'; end if;
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_by)
  values (_commercial, _semaine_id, 'ajustement', _points, gen_random_uuid()::text, trim(_libelle), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'solde', public.commando_points_solde(_commercial, _semaine_id));
end $$;
revoke all on function public.commando_points_ajuster(uuid, int, text, uuid) from public, anon;
grant execute on function public.commando_points_ajuster(uuid, int, text, uuid) to authenticated;

-- Résolution des jeux : inchangée, plus l'attribution des points.
create or replace function public.commando_jeux_resoudre()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  r record; v_cnt int;
  n_premier int := 0; n_bonus int := 0; n_mystere int := 0; n_reprises int := 0;
begin
  update public.commando_recompenses x set statut = 'reprise'
    from public.commando_appels a
   where a.id = x.appel_id and x.statut = 'attribuee' and a.rdv_statut = 'annule';
  get diagnostics n_reprises = row_count;

  if coalesce((p->>'premier_rdv')::boolean, true) then
    for r in
      select distinct on (c.creneau) c.id, c.commercial_id, c.semaine_id, c.creneau
        from (select a.*, public.commando_creneau(a.created_at) as creneau
                from public.commando_appels a
               where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
                 and a.semaine_id is not null and a.created_at > now() - interval '7 days'
                 and public.commando_jeux_heure_ok(a.created_at, p)) c
       order by c.creneau, c.created_at
    loop
      if not exists (select 1 from public.commando_recompenses x where x.type = 'premier_rdv' and x.creneau = r.creneau) then
        n_premier := n_premier + public.commando_jeux_attribuer(r.commercial_id, r.semaine_id, 'premier_rdv',
                       coalesce((p->>'fiches_premier_rdv')::int, 5), r.id, null, r.creneau);
      end if;
    end loop;
    for r in
      select a.id, a.commercial_id, a.semaine_id, public.commando_creneau(a.created_at) as creneau
        from public.commando_appels a
       where a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule'
         and a.semaine_id is not null and a.created_at > now() - interval '7 days'
         and public.commando_jeux_heure_ok(a.created_at, p)
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

  perform public.commando_points_crediter();
  return jsonb_build_object('premier_rdv', n_premier, 'rdv_bonus', n_bonus, 'fiche_mystere', n_mystere, 'reprises', n_reprises);
end $$;

-- État des jeux : ajoute le solde de points du commercial.
create or replace function public.commando_jeux_etat(_semaine_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p jsonb := (select jeux from public.commando_parametres where id);
  v_uid uuid := auth.uid();
  v_creneau timestamptz := public.commando_creneau(now());
  v_delai int := coalesce((p->>'delai_pronostic_min')::int, 20);
  v_sem text := (select semaine from public.commando_semaines where id = _semaine_id);
  v_heures jsonb := coalesce(p->'heures', '[14,15,16]'::jsonb);
  v_heure_ok boolean := public.commando_jeux_heure_ok(now(), p);
  v_res jsonb;
begin
  if not public.commando_est_membre(v_uid) then return '{}'::jsonb; end if;
  perform public.commando_jeux_resoudre();
  select jsonb_build_object(
    'actifs', jsonb_build_object('premier_rdv', coalesce((p->>'premier_rdv')::boolean, true),
                                 'pronostic', coalesce((p->>'pronostic')::boolean, true),
                                 'ligue', coalesce((p->>'ligue')::boolean, true)),
    'heures', v_heures,
    'points', public.commando_points_solde(v_uid, _semaine_id),
    'creneau', jsonb_build_object(
      'debut', v_creneau, 'fin', v_creneau + interval '1 hour',
      'en_jeu', v_heure_ok,
      'peut_pronostiquer', v_heure_ok and now() <= v_creneau + make_interval(mins => v_delai)
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

-- Ligue : classement par points de la semaine, puis RDV, puis appels ;
-- points de la semaine et total par commercial ; badges via la fonction commune.
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

  with par as (
    select m.user_id, m.role,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id) as appels,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as rdv,
      (select min(a.created_at) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id
         and a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as premier_rdv,
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.statut = 'rdv'
         and a.rdv_statut = 'honore' and a.rdv_valide_le is not null
         and a.date_rdv >= (v_lundi - v_fenetre * 7)::timestamptz and a.date_rdv < v_lundi::timestamptz) as honores_valides,
      (select count(*) from public.commando_recompenses r where r.commercial_id = m.user_id and r.semaine_id = _semaine_id and r.statut = 'attribuee') as fiches_gagnees,
      (select count(*) from public.commando_pronostics x where x.commercial_id = m.user_id and x.semaine_id = _semaine_id and x.reussi) as pronostics_reussis,
      coalesce((select sum(x.points) from public.commando_points x where x.commercial_id = m.user_id and x.semaine_id = _semaine_id), 0) as points_semaine,
      coalesce((select sum(x.points) from public.commando_points x where x.commercial_id = m.user_id), 0) as points_total
    from public.commando_membres m
  ),
  badges as (select * from public.commando_badges_semaine(_semaine_id)),
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
    'bareme', public.commando_points_bareme(),
    'classement', (select coalesce(jsonb_agg(jsonb_build_object(
        'commercial_id', user_id, 'role', role, 'appels', appels, 'rdv', rdv,
        'taux', case when appels > 0 then round(rdv::numeric / appels, 3) else null end,
        'premier_rdv', premier_rdv, 'honores_valides', honores_valides, 'fiches_gagnees', fiches_gagnees, 'pronostics_reussis', pronostics_reussis,
        'points_semaine', points_semaine, 'points_total', points_total,
        'badges', (select coalesce(jsonb_agg(b.badge), '[]'::jsonb) from badges b where b.commercial_id = par.user_id)
      ) order by points_semaine desc, rdv desc, appels desc), '[]'::jsonb) from par),
    'creneaux', (select coalesce(jsonb_agg(jsonb_build_object('creneau', creneau, 'commercial_id', commercial_id, 'a', created_at, 'rdv', rdv_creneau) order by creneau desc), '[]'::jsonb) from creneaux),
    'total_rdv', (select coalesce(sum(rdv), 0) from par),
    'total_appels', (select coalesce(sum(appels), 0) from par),
    'total_points_semaine', (select coalesce(sum(points_semaine), 0) from par),
    'fidele', (select b.commercial_id from badges b where b.badge = 'fidele'),
    'a_valider', (select count(*) from public.commando_appels a where a.statut = 'rdv' and a.rdv_valide_le is null
                    and coalesce(a.rdv_statut, 'prevu') <> 'annule' and a.date_rdv < now())
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_ligue(uuid) from public, anon;
grant execute on function public.commando_ligue(uuid) to authenticated;
