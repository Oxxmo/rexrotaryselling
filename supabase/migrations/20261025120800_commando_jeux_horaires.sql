-- ============================================================
--  Rex Commando — 9/ Horaires des jeux (créneaux de l'après-midi)
-- ------------------------------------------------------------
--  Le commando se déroule l'après-midi : 14h–15h, 15h–16h, 16h–17h.
--  Le paramètre jeux.heures (heures de Paris, par défaut [14, 15, 16])
--  limite les jeux à ces créneaux : un RDV pris en dehors ne rapporte
--  ni fiches ni « premier RDV de l'heure », et le pronostic est fermé.
--  Les RDV comptent toujours pour la ligue et les statistiques.
-- ============================================================

update public.commando_parametres
   set jeux = jeux || '{"heures": [14, 15, 16]}'::jsonb
 where not (jeux ? 'heures');

-- Vrai si l'instant tombe dans un créneau de jeu (heure de Paris).
create or replace function public.commando_jeux_heure_ok(_ts timestamptz, _jeux jsonb)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(_jeux->'heures', '[14,15,16]'::jsonb) @> to_jsonb(extract(hour from (_ts at time zone 'Europe/Paris'))::int)
$$;

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

  return jsonb_build_object('premier_rdv', n_premier, 'rdv_bonus', n_bonus, 'fiche_mystere', n_mystere, 'reprises', n_reprises);
end $$;

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
  if not public.commando_jeux_heure_ok(now(), p) then raise exception 'Le pronostic se fait pendant les créneaux du commando'; end if;
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
