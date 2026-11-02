-- ============================================================
--  Rex Commando — 14/ Mails de suivi
-- ------------------------------------------------------------
--  Après un appel, le commercial envoie un mail court et percutant depuis
--  SA messagerie (lien mailto, rien ne part de l'outil). La veille rédige
--  pour chaque thématique deux variantes (commando_thematiques.mails) :
--    « rdv »   : RDV confirmé (date, ce que le client peut préparer) ;
--    « suite » : suite à notre échange (deux créneaux proposés).
--  L'ouverture du mail est tracée sur l'appel (mail_prepare_le, variante),
--  comptée dans les indicateurs et la ligue, et rapporte des points
--  (barème « mail », 5 par défaut).
-- ============================================================
alter table public.commando_thematiques add column if not exists mails jsonb not null default '{}'::jsonb;
comment on column public.commando_thematiques.mails is 'Mails de suivi rédigés par la veille : {rdv: {objet, corps}, suite: {objet, corps}}.';

alter table public.commando_appels
  add column if not exists mail_prepare_le timestamptz,
  add column if not exists mail_variante text check (mail_variante is null or mail_variante in ('rdv', 'suite'));
comment on column public.commando_appels.mail_prepare_le is 'Mail de suivi ouvert dans la messagerie du commercial (lien mailto).';

-- Type « mail » dans le relevé de points.
alter table public.commando_points drop constraint if exists commando_points_type_check;
alter table public.commando_points add constraint commando_points_type_check
  check (type in ('appel','rdv','rdv_annule','rdv_honore','premier_rdv','pronostic','badge','mail','ajustement','depense'));

update public.commando_parametres
   set jeux = jsonb_set(jeux, '{points,mail}', '5'::jsonb, true)
 where jeux ? 'points' and not (jeux->'points' ? 'mail');

create or replace function public.commando_points_bareme()
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select '{"actif": true, "appel": 1, "rdv": 10, "rdv_honore": 25, "premier_rdv": 15, "pronostic": 10, "badge": 20, "mail": 5}'::jsonb
         || coalesce((select jeux->'points' from public.commando_parametres where id), '{}'::jsonb)
$$;

-- Le commercial ouvre le mail de suivi : tracé sur son dernier appel de l'entreprise (7 jours).
create or replace function public.commando_mail_preparer(_siret text, _variante text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_appel record; v_deja boolean;
begin
  if not public.commando_est_membre(auth.uid()) then
    raise exception 'Réservé aux membres du commando' using errcode = '42501';
  end if;
  if _variante not in ('rdv', 'suite') then raise exception 'Variante invalide (rdv ou suite)'; end if;
  select * into v_appel from public.commando_appels a
   where a.siret = _siret and a.commercial_id = auth.uid() and a.created_at > now() - interval '7 days'
   order by a.created_at desc limit 1;
  if v_appel.id is null then
    raise exception 'Enregistrez d''abord le résultat de l''appel : le mail de suivi s''y rattache.';
  end if;
  v_deja := v_appel.mail_prepare_le is not null;
  update public.commando_appels set mail_prepare_le = coalesce(mail_prepare_le, now()), mail_variante = _variante where id = v_appel.id;
  perform public.commando_points_crediter();
  return jsonb_build_object('appel_id', v_appel.id, 'deja', v_deja, 'variante', _variante,
                            'points', public.commando_points_solde(auth.uid(), v_appel.semaine_id));
end $$;
revoke all on function public.commando_mail_preparer(text, text) from public, anon;
grant execute on function public.commando_mail_preparer(text, text) to authenticated;

-- Indicateurs : mails envoyés dans chaque bloc.
create or replace function public.commando_stats_bloc(_appels bigint, _rdv bigint, _honores bigint, _mails bigint, _seuil int)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'appels', coalesce(_appels, 0), 'rdv', coalesce(_rdv, 0), 'honores', coalesce(_honores, 0), 'mails', coalesce(_mails, 0),
    'taux', case when coalesce(_appels, 0) = 0 then null else round(coalesce(_rdv, 0)::numeric / _appels, 3) end,
    'echantillon_insuffisant', coalesce(_appels, 0) < _seuil);
$$;

create or replace function public.commando_stats(_depuis date default null, _jusqua date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seuil int; v_objectif int; v_res jsonb; v_sem_courante text := public.commando_semaine_cible(current_date);
begin
  if auth.uid() is not null and not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  select seuil_echantillon, objectif_rdv_semaine into v_seuil, v_objectif from public.commando_parametres where id;
  v_seuil := coalesce(v_seuil, 30); v_objectif := coalesce(v_objectif, 5);

  create temp table _ap on commit drop as
    select a.id, a.siret, a.commercial_id, a.statut, a.created_at, a.couleur_au_moment as couleur,
           a.regle_index_au_moment as regle_index, a.thematique_id,
           coalesce(s.semaine, public.commando_semaine_iso(a.created_at::date)) as semaine,
           t.titre, (t.regles -> a.regle_index_au_moment ->> 'raison') as raison,
           (t.regles -> a.regle_index_au_moment ->> 'couleur') as couleur_regle,
           pr.full_name as commercial_nom,
           (a.statut = 'rdv' and coalesce(a.rdv_statut, 'prevu') <> 'annule') as rdv_pris,
           (a.statut = 'rdv' and a.rdv_statut = 'honore') as rdv_honore,
           (a.mail_prepare_le is not null) as mail_envoye
      from public.commando_appels a
      left join public.commando_semaines s on s.id = a.semaine_id
      left join public.commando_thematiques t on t.id = a.thematique_id
      left join public.profiles pr on pr.id = a.commercial_id
     where (_depuis is null or a.created_at::date >= _depuis)
       and (_jusqua is null or a.created_at::date <= _jusqua);

  select jsonb_build_object(
    'periode', jsonb_build_object('depuis', _depuis, 'jusqua', _jusqua),
    'seuil', v_seuil, 'objectif', v_objectif, 'semaine_courante', v_sem_courante,
    'total', (select public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) from _ap),
    'par_couleur', (select coalesce(jsonb_agg(jsonb_build_object('couleur', couleur) || b order by case couleur when 'vert' then 1 when 'orange' then 2 when 'rouge' then 3 else 4 end), '[]'::jsonb)
                      from (select couleur, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b from _ap group by couleur) x),
    'par_thematique', (select coalesce(jsonb_agg(jsonb_build_object('thematique_id', thematique_id, 'titre', titre, 'semaine', semaine) || b order by semaine desc, titre), '[]'::jsonb)
                         from (select thematique_id, max(titre) titre, max(semaine) semaine, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b from _ap group by thematique_id) x),
    'par_regle', (select coalesce(jsonb_agg(jsonb_build_object('thematique_id', thematique_id, 'titre', titre, 'semaine', semaine, 'regle_index', regle_index, 'raison', raison, 'couleur_regle', couleur_regle) || b order by semaine desc, titre, regle_index), '[]'::jsonb)
                    from (select thematique_id, max(titre) titre, max(semaine) semaine, regle_index, max(raison) raison, max(couleur_regle) couleur_regle,
                                 public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b
                            from _ap where regle_index is not null group by thematique_id, regle_index) x),
    'par_commercial', (select coalesce(jsonb_agg(jsonb_build_object('commercial_id', commercial_id, 'nom', commercial_nom) || b order by commercial_nom), '[]'::jsonb)
                         from (select commercial_id, max(commercial_nom) commercial_nom, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b from _ap group by commercial_id) x),
    'par_semaine', (select coalesce(jsonb_agg(jsonb_build_object('semaine', semaine) || b order by semaine desc), '[]'::jsonb)
                      from (select semaine, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b from _ap group by semaine) x),
    'par_commercial_semaine', (select coalesce(jsonb_agg(jsonb_build_object('semaine', semaine, 'commercial_id', commercial_id, 'nom', commercial_nom) || b order by semaine desc, commercial_nom), '[]'::jsonb)
                                 from (select semaine, commercial_id, max(commercial_nom) commercial_nom, public.commando_stats_bloc(count(*), count(*) filter (where rdv_pris), count(*) filter (where rdv_honore), count(*) filter (where mail_envoye), v_seuil) b from _ap group by semaine, commercial_id) x),
    -- RDV de la semaine courante par commercial membre (y compris à zéro), face à l'objectif
    'semaine_courante_par_commercial', (select coalesce(jsonb_agg(jsonb_build_object('commercial_id', m.user_id, 'nom', pr.full_name,
                                                 'appels', (select count(*) from _ap a where a.commercial_id = m.user_id and a.semaine = v_sem_courante),
                                                 'rdv', (select count(*) from _ap a where a.commercial_id = m.user_id and a.semaine = v_sem_courante and a.rdv_pris),
                                                 'mails', (select count(*) from _ap a where a.commercial_id = m.user_id and a.semaine = v_sem_courante and a.mail_envoye),
                                                 'objectif', v_objectif) order by pr.full_name), '[]'::jsonb)
                                          from public.commando_membres m join public.profiles pr on pr.id = m.user_id where m.role = 'commercial')
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_stats(date, date) from public, anon;
grant execute on function public.commando_stats(date, date) to authenticated;

-- Points : étape « mail ».
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

  -- 6 bis) Un mail de suivi préparé et ouvert dans la messagerie du commercial.
  insert into public.commando_points (commercial_id, semaine_id, type, points, reference, libelle, created_at, appel_id)
  select a.commercial_id, a.semaine_id, 'mail', (b->>'mail')::int, 'appel:' || a.id, 'Mail de suivi envoyé', a.mail_prepare_le, a.id
    from public.commando_appels a
   where a.mail_prepare_le is not null and a.semaine_id is not null and (b->>'mail')::int <> 0
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

-- Ligue : mails envoyés par commercial.
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
      (select count(*) from public.commando_appels a where a.commercial_id = m.user_id and a.semaine_id = _semaine_id and a.mail_prepare_le is not null) as mails,
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
        'points_semaine', points_semaine, 'points_total', points_total, 'mails', mails,
        'badges', (select coalesce(jsonb_agg(b.badge), '[]'::jsonb) from badges b where b.commercial_id = par.user_id)
      ) order by points_semaine desc, rdv desc, appels desc), '[]'::jsonb) from par),
    'creneaux', (select coalesce(jsonb_agg(jsonb_build_object('creneau', creneau, 'commercial_id', commercial_id, 'a', created_at, 'rdv', rdv_creneau) order by creneau desc), '[]'::jsonb) from creneaux),
    'total_rdv', (select coalesce(sum(rdv), 0) from par),
    'total_appels', (select coalesce(sum(appels), 0) from par),
    'total_mails', (select coalesce(sum(mails), 0) from par),
    'total_points_semaine', (select coalesce(sum(points_semaine), 0) from par),
    'fidele', (select b.commercial_id from badges b where b.badge = 'fidele'),
    'a_valider', (select count(*) from public.commando_appels a where a.statut = 'rdv' and a.rdv_valide_le is null
                    and coalesce(a.rdv_statut, 'prevu') <> 'annule' and a.date_rdv < now())
  ) into v_res;
  return v_res;
end $$;
revoke all on function public.commando_ligue(uuid) from public, anon;
grant execute on function public.commando_ligue(uuid) to authenticated;
