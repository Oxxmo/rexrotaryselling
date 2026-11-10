-- ============================================================
--  Feuille de route — 1/ Socle : tables, droits (RLS), calculs
-- ------------------------------------------------------------
--  Onglet « Feuille de route » de RexSeller : feuille prospective
--  hebdomadaire de chaque commercial de l'agence de Poitiers,
--  préparée le vendredi et revue au point individuel.
--
--  Accès : réutilise exactement le mécanisme du Rex Commando
--  (table commando_membres, fonctions commando_est_membre /
--  commando_est_responsable) :
--    * non-membre : zéro ligne, aucune écriture ;
--    * commercial : sa propre feuille, ses pistes, ses RDV ;
--    * responsable (manager) : tout voir et tout éditer ; seul à
--      remplir « décidé au point » et à marquer un besoin traité.
--
--  Clé d'une semaine : la date du LUNDI de la semaine couverte.
--  Dans une feuille, S+1 = sa propre semaine (celle qui suit le
--  point du vendredi), S+2 = la suivante, S+3 = celle d'après.
--
--  Ne modifie aucune table existante.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Fonctions d'accès et utilitaires de dates
-- ------------------------------------------------------------
-- Manager : responsable du commando, ou propriétaire de la base
-- (migrations, service_role : auth.uid() est null).
create or replace function public.fdr_est_manager()
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or public.commando_est_responsable(auth.uid());
$$;

-- Droit sur les données d'un commercial : soi-même (membre de
-- l'équipe) ou le manager.
create or replace function public.fdr_acces(_commercial uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.fdr_est_manager()
      or (_commercial = auth.uid() and public.commando_est_membre(auth.uid()));
$$;

-- Lundi de la semaine d'une date, et semaine en cours (heure de Paris).
create or replace function public.fdr_lundi(_d date)
returns date language sql immutable as $$
  select _d - (extract(isodow from _d)::int - 1);
$$;
create or replace function public.fdr_semaine_courante()
returns date language sql stable as $$
  select public.fdr_lundi((now() at time zone 'Europe/Paris')::date);
$$;
-- Mois d'une semaine : celui de son jeudi (convention ISO).
create or replace function public.fdr_mois_de(_lundi date)
returns date language sql immutable as $$
  select date_trunc('month', _lundi + 3)::date;
$$;

revoke all on function public.fdr_est_manager()   from public;
revoke all on function public.fdr_acces(uuid)      from public;
grant execute on function public.fdr_est_manager() to authenticated;
grant execute on function public.fdr_acces(uuid)   to authenticated;
grant execute on function public.fdr_lundi(date), public.fdr_semaine_courante(), public.fdr_mois_de(date) to authenticated;

-- ------------------------------------------------------------
-- 2) Feuilles : un commercial × une semaine
-- ------------------------------------------------------------
create table if not exists public.fdr_feuilles (
  id                  uuid primary key default gen_random_uuid(),
  commercial_id       uuid not null references public.profiles(id) on delete cascade,
  semaine             date not null check (extract(isodow from semaine) = 1),
  -- D. Portefeuille
  visites             text,                         -- visites clients prévues
  recos               jsonb not null default '[]'::jsonb   -- [{a_qui, pour_qui}]
                        check (jsonb_typeof(recos) = 'array'),
  -- E. Plan d'attaque : trous à combler + thème commando du lundi
  trous_cible         text,
  trous_canal         text,
  trous_creneaux      text,
  trous_objectif_rdv  int check (trous_objectif_rdv is null or trous_objectif_rdv >= 0),
  theme_commando      text,
  -- C. Prévisions : « mois ajusté » déclaré (facultatif), affiché à côté du calculé
  mois_ajuste_declare numeric(8,1) check (mois_ajuste_declare is null or mois_ajuste_declare >= 0),
  mois_ajuste_note    text,
  -- Gel : la semaine passée est figée (instantané) lors de « Préparer le point »
  statut              text not null default 'courante' check (statut in ('courante','figee')),
  instantane          jsonb,
  fige_le             timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now(),
  unique (commercial_id, semaine)
);
comment on table public.fdr_feuilles is 'Feuille de route : un commercial × une semaine (lundi). Créée au point du vendredi précédent.';
create index if not exists fdr_feuilles_semaine_idx on public.fdr_feuilles(semaine);

-- ------------------------------------------------------------
-- 3) Pistes : entité persistante, jamais ressaisie
-- ------------------------------------------------------------
create table if not exists public.fdr_pistes (
  id                     uuid primary key default gen_random_uuid(),
  commercial_id          uuid not null references public.profiles(id) on delete cascade,
  compte                 text not null check (btrim(compte) <> ''),
  type                   text check (type in ('NC','CA','UP','RNV')),
  gammes                 text[] not null default '{}'
                           check (gammes <@ array['copieur_mps','it','ged','telephonie','sauvegarde']),
  montant                numeric(8,1) check (montant is null or montant >= 0),   -- k€ HT
  etape                  text check (etape in ('r1','r2','audit','signature')),
  prochaine_action       text,
  prochaine_action_date  date,
  signature_prevue       text check (signature_prevue in ('s1','mois','apres')),
  blocage                text,
  chaude                 boolean not null default false,
  decide_au_point        text,                   -- manager uniquement
  statut                 text not null default 'en_cours'
                           check (statut in ('en_cours','signee','perdue','reportee')),
  clos_semaine           date,                   -- semaine (lundi) de la signature / perte
  created_at             timestamptz not null default now(),
  created_by             uuid references public.profiles(id) on delete set null,
  updated_at             timestamptz not null default now()
);
comment on table public.fdr_pistes is 'Pistes commerciales persistantes. Une piste signée ou perdue n''apparaît plus sur les feuilles des semaines suivantes.';
create index if not exists fdr_pistes_commercial_idx on public.fdr_pistes(commercial_id, statut);

create table if not exists public.fdr_pistes_historique (
  id       bigint generated always as identity primary key,
  piste_id uuid not null references public.fdr_pistes(id) on delete cascade,
  champ    text not null check (champ in ('etape','statut')),
  ancien   text,
  nouveau  text,
  par      uuid references public.profiles(id) on delete set null,
  le       timestamptz not null default now()
);
create index if not exists fdr_pistes_historique_piste_idx on public.fdr_pistes_historique(piste_id, le);

-- ------------------------------------------------------------
-- 4) RDV posés : rattachés à une semaine absolue (le décalage
--    S+2 → S+1 se fait donc tout seul). Libellé et type
--    facultatifs : un RDV « sans détail » n'a ni l'un ni l'autre.
-- ------------------------------------------------------------
create table if not exists public.fdr_rdv (
  id            uuid primary key default gen_random_uuid(),
  commercial_id uuid not null references public.profiles(id) on delete cascade,
  semaine       date not null check (extract(isodow from semaine) = 1),
  date_rdv      date,
  libelle       text,
  type          text check (type in ('CA','NC','Audit')),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  check (date_rdv is null or public.fdr_lundi(date_rdv) = semaine)
);
create index if not exists fdr_rdv_commercial_idx on public.fdr_rdv(commercial_id, semaine);

-- ------------------------------------------------------------
-- 5) Engagements de la semaine (3 au plus) ; « tenu / non tenu »
--    est renseigné au point suivant (bloc A de la feuille N+1).
-- ------------------------------------------------------------
create table if not exists public.fdr_engagements (
  id               uuid primary key default gen_random_uuid(),
  feuille_id       uuid not null references public.fdr_feuilles(id) on delete cascade,
  ordre            smallint not null check (ordre between 1 and 3),
  texte            text not null check (btrim(texte) <> ''),
  echeance         date,
  fait             boolean not null default false,
  tenu             text check (tenu in ('tenu','non_tenu')),
  tenu_commentaire text,
  updated_at       timestamptz not null default now(),
  unique (feuille_id, ordre)
);

-- ------------------------------------------------------------
-- 6) Besoins de Scott : un besoin non traité reste visible sur
--    les feuilles suivantes jusqu'à ce que le manager le traite.
-- ------------------------------------------------------------
create table if not exists public.fdr_besoins (
  id         uuid primary key default gen_random_uuid(),
  feuille_id uuid not null references public.fdr_feuilles(id) on delete cascade,
  texte      text not null check (btrim(texte) <> ''),
  traite     boolean not null default false,
  traite_le  timestamptz,
  traite_par uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fdr_besoins_feuille_idx on public.fdr_besoins(feuille_id);

-- ------------------------------------------------------------
-- 7) Prévision « mois initial » : saisie une fois, puis figée
--    (seul le manager peut la corriger).
-- ------------------------------------------------------------
create table if not exists public.fdr_previsions_mois (
  commercial_id uuid not null references public.profiles(id) on delete cascade,
  mois          date not null check (extract(day from mois) = 1),
  montant       numeric(8,1) not null check (montant >= 0),
  saisi_le      timestamptz not null default now(),
  saisi_par     uuid references public.profiles(id) on delete set null,
  primary key (commercial_id, mois)
);

-- ------------------------------------------------------------
-- 8) Gardes (déclencheurs) : ce que la RLS ne sait pas exprimer
--    colonne par colonne.
-- ------------------------------------------------------------
create or replace function public.fdr_feuille_figee(_feuille uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select statut = 'figee' from public.fdr_feuilles where id = _feuille), false);
$$;
revoke all on function public.fdr_feuille_figee(uuid) from public;
grant execute on function public.fdr_feuille_figee(uuid) to authenticated;

-- Pistes : « décidé au point » réservé au manager ; semaine de
-- clôture tenue à jour avec le statut ; horodatage.
create or replace function public.fdr_pistes_garde()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.fdr_est_manager() then
    if tg_op = 'INSERT' and new.decide_au_point is not null then
      raise exception 'Seul le manager renseigne « décidé au point ».' using errcode = '42501';
    elsif tg_op = 'UPDATE' and new.decide_au_point is distinct from old.decide_au_point then
      raise exception 'Seul le manager renseigne « décidé au point ».' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  -- Semaine de clôture : celle où la piste passe signée / perdue.
  if new.statut not in ('signee','perdue') then
    new.clos_semaine := null;
  elsif tg_op = 'UPDATE' and old.statut is distinct from new.statut then
    new.clos_semaine := public.fdr_semaine_courante();
  else
    new.clos_semaine := coalesce(new.clos_semaine,
                                 case when tg_op = 'UPDATE' then old.clos_semaine end,
                                 public.fdr_semaine_courante());
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_fdr_pistes_garde on public.fdr_pistes;
create trigger trg_fdr_pistes_garde before insert or update on public.fdr_pistes
  for each row execute function public.fdr_pistes_garde();

-- Historique des changements d'étape et de statut.
create or replace function public.fdr_pistes_historiser()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.etape is not null then
      insert into public.fdr_pistes_historique (piste_id, champ, ancien, nouveau, par) values (new.id, 'etape', null, new.etape, auth.uid());
    end if;
    if new.statut <> 'en_cours' then
      insert into public.fdr_pistes_historique (piste_id, champ, ancien, nouveau, par) values (new.id, 'statut', null, new.statut, auth.uid());
    end if;
  else
    if new.etape is distinct from old.etape then
      insert into public.fdr_pistes_historique (piste_id, champ, ancien, nouveau, par) values (new.id, 'etape', old.etape, new.etape, auth.uid());
    end if;
    if new.statut is distinct from old.statut then
      insert into public.fdr_pistes_historique (piste_id, champ, ancien, nouveau, par) values (new.id, 'statut', old.statut, new.statut, auth.uid());
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_fdr_pistes_historiser on public.fdr_pistes;
create trigger trg_fdr_pistes_historiser after insert or update on public.fdr_pistes
  for each row execute function public.fdr_pistes_historiser();

-- Feuilles : une feuille figée n'est plus modifiable par le commercial ;
-- le gel lui-même est réservé au manager (et à la fonction de bascule).
create or replace function public.fdr_feuilles_garde()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.statut <> 'courante' and not public.fdr_est_manager() then
      raise exception 'Une feuille est créée « courante ».' using errcode = '42501';
    end if;
  elsif not public.fdr_est_manager() then
    if old.statut = 'figee' then
      raise exception 'Cette feuille est figée (semaine passée).' using errcode = '42501';
    end if;
    if new.statut is distinct from old.statut or new.instantane is distinct from old.instantane
       or new.fige_le is distinct from old.fige_le or new.commercial_id <> old.commercial_id
       or new.semaine <> old.semaine then
      raise exception 'Modification réservée au manager.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_fdr_feuilles_garde on public.fdr_feuilles;
create trigger trg_fdr_feuilles_garde before insert or update on public.fdr_feuilles
  for each row execute function public.fdr_feuilles_garde();

-- Engagements : sur une feuille figée, le commercial ne peut plus que
-- renseigner « tenu / non tenu » (au point suivant).
create or replace function public.fdr_engagements_garde()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.fdr_est_manager() then
    if tg_op = 'DELETE' then
      if public.fdr_feuille_figee(old.feuille_id) then
        raise exception 'Cette feuille est figée (semaine passée).' using errcode = '42501';
      end if;
      return old;
    end if;
    if public.fdr_feuille_figee(new.feuille_id) then
      if tg_op = 'INSERT' or new.texte is distinct from old.texte or new.echeance is distinct from old.echeance
         or new.fait is distinct from old.fait or new.ordre <> old.ordre or new.feuille_id <> old.feuille_id then
        raise exception 'Cette feuille est figée : seul « tenu / non tenu » reste modifiable.' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_fdr_engagements_garde on public.fdr_engagements;
create trigger trg_fdr_engagements_garde before insert or update or delete on public.fdr_engagements
  for each row execute function public.fdr_engagements_garde();

-- Besoins : « traité » réservé au manager ; le commercial ne supprime
-- qu'un besoin non traité d'une feuille non figée.
create or replace function public.fdr_besoins_garde()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.fdr_est_manager() then
    if tg_op = 'DELETE' then
      if old.traite or public.fdr_feuille_figee(old.feuille_id) then
        raise exception 'Ce besoin ne peut plus être supprimé.' using errcode = '42501';
      end if;
      return old;
    end if;
    if (tg_op = 'INSERT' and new.traite) or (tg_op = 'UPDATE' and new.traite is distinct from old.traite) then
      raise exception 'Seul le manager marque un besoin comme traité.' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and public.fdr_feuille_figee(new.feuille_id) then
      raise exception 'Cette feuille est figée (semaine passée).' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.texte is distinct from old.texte or new.feuille_id <> old.feuille_id)
       and (old.traite or public.fdr_feuille_figee(old.feuille_id)) then
      raise exception 'Ce besoin ne peut plus être modifié.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'INSERT' or new.traite is distinct from old.traite then
    new.traite_le  := case when new.traite then now() end;
    new.traite_par := case when new.traite then auth.uid() end;
  end if;
  return new;
end $$;
drop trigger if exists trg_fdr_besoins_garde on public.fdr_besoins;
create trigger trg_fdr_besoins_garde before insert or update or delete on public.fdr_besoins
  for each row execute function public.fdr_besoins_garde();

create or replace function public.fdr_previsions_garde()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.saisi_le  := now();
  new.saisi_par := coalesce(auth.uid(), new.saisi_par);
  return new;
end $$;
drop trigger if exists trg_fdr_previsions_garde on public.fdr_previsions_mois;
create trigger trg_fdr_previsions_garde before insert or update on public.fdr_previsions_mois
  for each row execute function public.fdr_previsions_garde();

drop trigger if exists trg_fdr_rdv_auteur on public.fdr_rdv;
create or replace function public.fdr_rdv_auteur()
returns trigger language plpgsql as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  if new.date_rdv is not null then new.semaine := public.fdr_lundi(new.date_rdv); end if;
  return new;
end $$;
create trigger trg_fdr_rdv_auteur before insert or update on public.fdr_rdv
  for each row execute function public.fdr_rdv_auteur();

-- ------------------------------------------------------------
-- 9) Droits (RLS) — toute policy passe par fdr_acces()
-- ------------------------------------------------------------
alter table public.fdr_feuilles          enable row level security;
alter table public.fdr_pistes            enable row level security;
alter table public.fdr_pistes_historique enable row level security;
alter table public.fdr_rdv               enable row level security;
alter table public.fdr_engagements       enable row level security;
alter table public.fdr_besoins           enable row level security;
alter table public.fdr_previsions_mois   enable row level security;

revoke all on public.fdr_feuilles, public.fdr_pistes, public.fdr_pistes_historique, public.fdr_rdv,
  public.fdr_engagements, public.fdr_besoins, public.fdr_previsions_mois from anon;

-- Feuille d'un commercial : accès via son propriétaire.
create or replace function public.fdr_acces_feuille(_feuille uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.fdr_acces(commercial_id) from public.fdr_feuilles where id = _feuille), false);
$$;
revoke all on function public.fdr_acces_feuille(uuid) from public;
grant execute on function public.fdr_acces_feuille(uuid) to authenticated;

-- --- feuilles : lecture/création/modification par le propriétaire ou le manager ;
--     suppression par le manager uniquement ---
drop policy if exists fdr_feuilles_select on public.fdr_feuilles;
create policy fdr_feuilles_select on public.fdr_feuilles for select to authenticated
  using ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_feuilles_insert on public.fdr_feuilles;
create policy fdr_feuilles_insert on public.fdr_feuilles for insert to authenticated
  with check ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_feuilles_update on public.fdr_feuilles;
create policy fdr_feuilles_update on public.fdr_feuilles for update to authenticated
  using ( public.fdr_acces(commercial_id) ) with check ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_feuilles_delete on public.fdr_feuilles;
create policy fdr_feuilles_delete on public.fdr_feuilles for delete to authenticated
  using ( (select public.fdr_est_manager()) );

-- --- pistes et RDV : tout pour le propriétaire et le manager ---
drop policy if exists fdr_pistes_all on public.fdr_pistes;
create policy fdr_pistes_all on public.fdr_pistes for all to authenticated
  using ( public.fdr_acces(commercial_id) ) with check ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_rdv_all on public.fdr_rdv;
create policy fdr_rdv_all on public.fdr_rdv for all to authenticated
  using ( public.fdr_acces(commercial_id) ) with check ( public.fdr_acces(commercial_id) );

-- --- historique : lecture seule (écrit par le déclencheur) ---
drop policy if exists fdr_historique_select on public.fdr_pistes_historique;
create policy fdr_historique_select on public.fdr_pistes_historique for select to authenticated
  using ( public.fdr_acces((select commercial_id from public.fdr_pistes p where p.id = piste_id)) );
revoke insert, update, delete on public.fdr_pistes_historique from authenticated;

-- --- engagements, besoins : via la feuille ---
drop policy if exists fdr_engagements_all on public.fdr_engagements;
create policy fdr_engagements_all on public.fdr_engagements for all to authenticated
  using ( public.fdr_acces_feuille(feuille_id) ) with check ( public.fdr_acces_feuille(feuille_id) );
drop policy if exists fdr_besoins_all on public.fdr_besoins;
create policy fdr_besoins_all on public.fdr_besoins for all to authenticated
  using ( public.fdr_acces_feuille(feuille_id) ) with check ( public.fdr_acces_feuille(feuille_id) );

-- --- prévision « mois initial » : lecture et première saisie par le
--     propriétaire ; correction et suppression par le manager ---
drop policy if exists fdr_previsions_select on public.fdr_previsions_mois;
create policy fdr_previsions_select on public.fdr_previsions_mois for select to authenticated
  using ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_previsions_insert on public.fdr_previsions_mois;
create policy fdr_previsions_insert on public.fdr_previsions_mois for insert to authenticated
  with check ( public.fdr_acces(commercial_id) );
drop policy if exists fdr_previsions_update on public.fdr_previsions_mois;
create policy fdr_previsions_update on public.fdr_previsions_mois for update to authenticated
  using ( (select public.fdr_est_manager()) ) with check ( (select public.fdr_est_manager()) );
drop policy if exists fdr_previsions_delete on public.fdr_previsions_mois;
create policy fdr_previsions_delete on public.fdr_previsions_mois for delete to authenticated
  using ( (select public.fdr_est_manager()) );

-- ------------------------------------------------------------
-- 10) Calculs : une ligne par feuille (vue en security_invoker,
--     donc soumise aux mêmes droits que les tables).
--     - Prévision S+1  : pistes en cours, signature prévue S+1
--     - Mois ajusté    : pistes en cours, signature S+1 ou dans le mois
--     - Mois initial   : saisie figée du mois de la feuille
--     - RDV posés      : S+1/S+2/S+3 par type (+ sans détail)
-- ------------------------------------------------------------
create or replace view public.fdr_feuilles_resume
with (security_invoker = true) as
select
  f.id, f.commercial_id, f.semaine, f.statut,
  public.fdr_mois_de(f.semaine) as mois,
  coalesce((select sum(p.montant) from public.fdr_pistes p
             where p.commercial_id = f.commercial_id and p.statut = 'en_cours'
               and p.signature_prevue = 's1'), 0)::numeric(8,1)            as prevision_s1,
  coalesce((select sum(p.montant) from public.fdr_pistes p
             where p.commercial_id = f.commercial_id and p.statut = 'en_cours'
               and p.signature_prevue in ('s1','mois')), 0)::numeric(8,1)  as mois_ajuste_calcule,
  f.mois_ajuste_declare, f.mois_ajuste_note,
  (select m.montant from public.fdr_previsions_mois m
    where m.commercial_id = f.commercial_id and m.mois = public.fdr_mois_de(f.semaine)) as mois_initial,
  (select count(*) from public.fdr_pistes p
    where p.commercial_id = f.commercial_id and p.statut = 'en_cours' and p.chaude)::int as pistes_chaudes,
  (select count(*) from public.fdr_besoins b join public.fdr_feuilles fb on fb.id = b.feuille_id
    where fb.commercial_id = f.commercial_id and fb.semaine <= f.semaine and not b.traite)::int as besoins_non_traites,
  (select jsonb_object_agg(k, jsonb_build_object(
            'total', n_total, 'CA', n_ca, 'NC', n_nc, 'Audit', n_audit, 'sans_detail', n_sd))
     from (select 's' || s.k as k,
                  count(r.id) as n_total,
                  count(r.id) filter (where r.type = 'CA')    as n_ca,
                  count(r.id) filter (where r.type = 'NC')    as n_nc,
                  count(r.id) filter (where r.type = 'Audit') as n_audit,
                  count(r.id) filter (where r.type is null)   as n_sd
             from generate_series(1, 3) as s(k)
             left join public.fdr_rdv r
               on r.commercial_id = f.commercial_id and r.semaine = f.semaine + (s.k - 1) * 7
            group by s.k) c)                                                   as rdv
from public.fdr_feuilles f;
comment on view public.fdr_feuilles_resume is 'Prévisions et compteurs calculés d''une feuille (S+1 = semaine de la feuille).';
revoke all on public.fdr_feuilles_resume from anon;
grant select on public.fdr_feuilles_resume to authenticated;
