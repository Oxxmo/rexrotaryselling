-- ============================================================
--  Rex Commando — 1/ Socle : tables, accès (RLS), données initiales
-- ------------------------------------------------------------
--  Onglet « Rex Commando » de RexSeller : commando d'appels du
--  lundi matin de l'agence de Poitiers.
--
--  Règles d'accès :
--    * seules les personnes listées dans commando_membres voient
--      les tables commando_* (zéro ligne pour les autres) ;
--    * rôle « responsable » : console, paramétrage, publication ;
--    * rôle « commercial » : listes, fiches, résultats d'appel.
--
--  Ne modifie ni profiles, ni rendez_vous, ni tickets.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Membres du commando + fonctions d'accès (utilisées par la RLS)
-- ------------------------------------------------------------
create table if not exists public.commando_membres (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  role       text not null check (role in ('responsable','commercial')),
  created_at timestamptz not null default now()
);
comment on table public.commando_membres is 'Personnes ayant accès à l''onglet Rex Commando, avec leur rôle (responsable | commercial).';

-- SECURITY DEFINER : lecture de commando_membres sans repasser par la
-- RLS (évite toute récursion), search_path figé.
create or replace function public.commando_est_membre(_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.commando_membres where user_id = _uid);
$$;
create or replace function public.commando_est_responsable(_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.commando_membres where user_id = _uid and role = 'responsable');
$$;
revoke all on function public.commando_est_membre(uuid) from public;
revoke all on function public.commando_est_responsable(uuid) from public;
grant execute on function public.commando_est_membre(uuid) to authenticated;
grant execute on function public.commando_est_responsable(uuid) to authenticated;

-- Semaine ISO d'une date (ex. 2026-W44).
create or replace function public.commando_semaine_iso(_d date)
returns text language sql immutable as $$
  select to_char(_d, 'IYYY-"W"IW');
$$;
-- Semaine « du commando » pour une date d'import : l'import du dimanche
-- soir prépare la semaine qui commence le lendemain.
create or replace function public.commando_semaine_cible(_d date)
returns text language sql immutable as $$
  select public.commando_semaine_iso(case when extract(isodow from _d) = 7 then _d + 1 else _d end);
$$;

-- ------------------------------------------------------------
-- 2) Secteurs et codes postaux
-- ------------------------------------------------------------
create table if not exists public.commando_secteurs (
  code          text primary key,                 -- 63, 64, 65, NO (provisoire, modifiable)
  nom           text not null,
  commercial_id uuid references public.profiles(id) on delete set null,  -- null = secteur libre
  ordre         int  not null default 0
);
comment on table public.commando_secteurs is 'Secteurs du commando. commercial_id null = secteur libre (distribué par le responsable).';

create table if not exists public.commando_codes_postaux (
  code_postal  text primary key,
  ville        text not null,
  secteur_code text not null references public.commando_secteurs(code) on update cascade
);
create index if not exists commando_codes_postaux_secteur_idx on public.commando_codes_postaux(secteur_code);

-- ------------------------------------------------------------
-- 3) Base d'entreprises (alimentée uniquement par l'import)
-- ------------------------------------------------------------
create table if not exists public.commando_entreprises (
  siret             text primary key check (siret ~ '^[0-9]{14}$'),
  siren             text not null check (siren ~ '^[0-9]{9}$'),
  raison_sociale    text not null default '',
  enseigne          text,
  nature_juridique  text,
  naf_code          text,                 -- ex. 43.22A
  naf_libelle       text,
  -- Effectif retenu pour le ciblage : celui de l'établissement s'il est
  -- renseigné, sinon celui de l'unité légale quand elle n'a qu'un seul
  -- établissement ouvert ; null = non renseigné (exclu par défaut).
  tranche_effectif  text,                 -- code INSEE (02, 03, 11, 12, 21…)
  annee_effectif    int,                  -- année de la tranche (déclaratif, parfois ancien)
  tranche_source    text check (tranche_source in ('etablissement','unite_legale')),
  tranche_effectif_etab text,             -- brut : tranche de l'établissement (NN = non renseigné)
  tranche_effectif_ul   text,             -- brut : tranche de l'unité légale
  annee_effectif_ul     int,
  nb_etablissements_ouverts int,
  date_creation_ul  date,                 -- création de l'unité légale (base de l'ancienneté)
  date_creation_etab date,
  adresse           text,
  code_postal       text not null,
  commune           text,
  dirigeants        jsonb not null default '[]'::jsonb,   -- [{nom, prenom, qualite}]
  est_siege         boolean not null default false,
  est_client        boolean not null default false,
  nouvelle_semaine  text,                 -- semaine ISO où l'établissement est apparu (null = import initial)
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  archived_at       timestamptz,          -- établissement fermé ou disparu : archivé, jamais supprimé
  archive_raison    text,
  exclu_le          timestamptz,          -- exclu à la main par le responsable
  exclu_par         uuid references public.profiles(id) on delete set null,
  exclu_raison      text,
  updated_at        timestamptz not null default now()
);
comment on table public.commando_entreprises is 'Établissements actifs des codes postaux du commando (source : API Recherche d''entreprises). Jamais supprimés : archivés.';
create index if not exists commando_entreprises_cp_idx    on public.commando_entreprises(code_postal);
create index if not exists commando_entreprises_siren_idx on public.commando_entreprises(siren);
create index if not exists commando_entreprises_naf_idx   on public.commando_entreprises(naf_code);
create index if not exists commando_entreprises_actives_idx on public.commando_entreprises(code_postal) where archived_at is null;

drop trigger if exists trg_commando_entreprises_touch on public.commando_entreprises;
create trigger trg_commando_entreprises_touch
  before update on public.commando_entreprises
  for each row execute function public.touch_updated_at();

-- Coordonnées saisies par l'équipe (absentes de l'open data) + opposition RGPD.
create table if not exists public.commando_contacts (
  siret         text primary key references public.commando_entreprises(siret) on delete cascade,
  telephone     text,
  email         text,
  opposition    boolean not null default false,   -- « ne plus contacter » : exclusion définitive
  opposition_le timestamptz,
  note          text,
  updated_by    uuid references public.profiles(id) on delete set null,
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_commando_contacts_touch on public.commando_contacts;
create trigger trg_commando_contacts_touch
  before update on public.commando_contacts
  for each row execute function public.touch_updated_at();

-- Liste des SIREN clients (fournie par le responsable) : exclus des appels.
create table if not exists public.commando_clients_siren (
  siren       text primary key check (siren ~ '^[0-9]{9}$'),
  importe_le  timestamptz not null default now(),
  importe_par uuid references public.profiles(id) on delete set null
);

-- ------------------------------------------------------------
-- 4) Rapports d'import
-- ------------------------------------------------------------
create table if not exists public.commando_imports (
  id            uuid primary key default gen_random_uuid(),
  lance_le      timestamptz not null default now(),
  termine_le    timestamptz,
  declencheur   text not null check (declencheur in ('cron','manuel')),
  statut        text not null default 'en_cours' check (statut in ('en_cours','terminee','erreur')),
  dry_run       boolean not null default false,
  initial       boolean not null default false,     -- premier import : rien n'est « nouveau »
  codes_postaux text[] not null default '{}',       -- périmètre réellement traité
  semaine_cible text,
  compteurs     jsonb not null default '{}'::jsonb, -- par secteur : vues, ajoutees, reactivees, archivees, exclues{raison}
  anomalies     jsonb not null default '[]'::jsonb, -- ex. code postal inconnu
  erreur        text,
  lance_par     uuid references public.profiles(id) on delete set null
);
create index if not exists commando_imports_lance_idx on public.commando_imports(lance_le desc);

-- ------------------------------------------------------------
-- 5) Paramètres (ligne unique)
-- ------------------------------------------------------------
create table if not exists public.commando_parametres (
  id                       boolean primary key default true check (id),
  fiche_rex                text,                    -- fiche validée (seule utilisée par la veille)
  fiche_rex_brouillon      text,                    -- brouillon rédigé par la veille, à corriger
  fiche_rex_validee_le     timestamptz,
  site_rex                 text not null default 'https://www.rexrotary.fr',
  concurrents              jsonb not null default '[]'::jsonb,   -- ["Nom", …]
  consignes                text not null default
    E'- Offre d''entrée : un audit gratuit de 30 minutes plutôt qu''une vente directe.\n- Conclusion : proposer deux créneaux précis plutôt qu''une question ouverte.\n- Ton : apporter de la clarté, ne pas faire peur.\n- Angle signature : les copieurs connectés sont une faille réseau souvent oubliée.',
  tranches_incluses        text[] not null default '{02,03,11,12}',
  inclure_effectif_inconnu boolean not null default false,
  bornes_anciennete        jsonb not null default '{"moins_3": 3, "plus_5": 5}'::jsonb,
  delai_rappel_refus_semaines       int not null default 8,
  delai_rappel_injoignable_semaines int not null default 2,
  limite_generations_semaine        int not null default 5,
  modele                   text not null default 'claude-sonnet-5-5',
  secteur_libre_visible_par text not null default 'responsable' check (secteur_libre_visible_par in ('responsable','equipe')),
  objectif_rdv_semaine     int not null default 5,
  seuil_echantillon        int not null default 30,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references public.profiles(id) on delete set null
);
drop trigger if exists trg_commando_parametres_touch on public.commando_parametres;
create trigger trg_commando_parametres_touch
  before update on public.commando_parametres
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 6) Semaines, générations IA, thématiques, ciblages, appels
-- ------------------------------------------------------------
create table if not exists public.commando_semaines (
  id         uuid primary key default gen_random_uuid(),
  semaine    text not null unique check (semaine ~ '^[0-9]{4}-W[0-9]{2}$'),
  statut     text not null default 'brouillon' check (statut in ('brouillon','publiee')),
  publiee_le timestamptz,
  publiee_par uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.commando_generations (
  id             uuid primary key default gen_random_uuid(),
  semaine_id     uuid not null references public.commando_semaines(id) on delete cascade,
  type           text not null default 'veille' check (type in ('veille','regeneration','fiche_rex')),
  statut         text not null default 'en_cours' check (statut in ('en_cours','terminee','erreur')),
  modele         text,
  prompt_version int,
  prompt_envoye  text,
  reponse_brute  jsonb,
  urls_recherche jsonb not null default '[]'::jsonb,  -- URL réellement renvoyées par la recherche web
  jetons_entree  int,
  jetons_sortie  int,
  jetons_cache   int,
  nb_recherches  int,
  cout_estime    numeric(10,4),
  duree_ms       int,
  erreur         text,
  lancee_par     uuid references public.profiles(id) on delete set null,
  lancee_le      timestamptz not null default now(),
  terminee_le    timestamptz
);
create index if not exists commando_generations_semaine_idx on public.commando_generations(semaine_id);

create table if not exists public.commando_thematiques (
  id                 uuid primary key default gen_random_uuid(),
  semaine_id         uuid not null references public.commando_semaines(id) on delete cascade,
  generation_id      uuid references public.commando_generations(id) on delete set null,
  origine            text not null default 'ia' check (origine in ('ia','manuelle')),
  statut             text not null default 'proposee' check (statut in ('proposee','retenue','ecartee')),
  ordre              int not null default 0,
  cle                text,                       -- « id » du JSON de la veille
  titre              text not null,
  offre_rex          text not null default '',
  pourquoi_maintenant text not null default '',
  sources            jsonb not null default '[]'::jsonb,   -- [{url, titre, date, verifiee}]
  concurrence        jsonb not null default '{}'::jsonb,   -- {constat, angle_rex, sources[]}
  regles             jsonb not null default '[]'::jsonb,   -- [{couleur, si{…}, raison}]
  trames             jsonb not null default '{}'::jsonb,   -- {vert, orange, rouge}
  objections         jsonb not null default '[]'::jsonb,
  hypotheses         jsonb not null default '[]'::jsonb,
  alertes            jsonb not null default '[]'::jsonb,   -- ex. « aucune source de moins de 14 jours »
  modifiee_par       uuid references public.profiles(id) on delete set null,
  modifiee_le        timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists commando_thematiques_semaine_idx on public.commando_thematiques(semaine_id);

-- Instantané des couleurs à la publication (figé : sert à mesurer l'efficacité).
create table if not exists public.commando_ciblages (
  thematique_id uuid not null references public.commando_thematiques(id) on delete cascade,
  siret         text not null references public.commando_entreprises(siret) on delete cascade,
  semaine_id    uuid not null references public.commando_semaines(id) on delete cascade,
  couleur       text check (couleur in ('vert','orange','rouge')),   -- null = non classée
  regle_index   int,
  raison        text,
  secteur_code  text,
  primary key (thematique_id, siret)
);
create index if not exists commando_ciblages_semaine_siret_idx on public.commando_ciblages(semaine_id, siret);

create table if not exists public.commando_appels (
  id            uuid primary key default gen_random_uuid(),
  siret         text not null references public.commando_entreprises(siret) on delete cascade,
  semaine_id    uuid references public.commando_semaines(id) on delete set null,
  thematique_id uuid references public.commando_thematiques(id) on delete set null,
  commercial_id uuid not null references public.profiles(id) on delete cascade,
  statut        text not null check (statut in ('injoignable','rappeler','refus','rdv')),
  date_rappel   date,                                   -- pour « rappeler »
  date_rdv      timestamptz,                            -- pour « rdv »
  rdv_statut    text check (rdv_statut in ('prevu','honore','annule','reporte')),
  note          text,
  couleur_au_moment     text check (couleur_au_moment in ('vert','orange','rouge')),
  regle_index_au_moment int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (statut <> 'rdv' or date_rdv is not null)
);
create index if not exists commando_appels_siret_idx on public.commando_appels(siret, created_at desc);
create index if not exists commando_appels_commercial_idx on public.commando_appels(commercial_id, semaine_id);
create index if not exists commando_appels_rdv_idx on public.commando_appels(date_rdv) where statut = 'rdv';
drop trigger if exists trg_commando_appels_touch on public.commando_appels;
create trigger trg_commando_appels_touch
  before update on public.commando_appels
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 6 bis) Fonctions d'import (appelées par l'Edge Function avec la clé
--        service_role ; jamais exposées aux utilisateurs)
-- ------------------------------------------------------------
-- Insère ou met à jour un lot d'établissements. Idempotent : relancé deux
-- fois, il ne crée aucun doublon (clé = siret). Les champs d'historique
-- (first_seen_at, nouvelle_semaine) ne sont posés qu'à la création.
create or replace function public.commando_import_upsert(_rows jsonb, _semaine text, _initial boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ajoutees int := 0;
  v_reactivees int := 0;
  v_mises_a_jour int := 0;
begin
  create temp table _lot on commit drop as
    select
      r->>'siret'            as siret,
      r->>'siren'            as siren,
      coalesce(r->>'raison_sociale','') as raison_sociale,
      r->>'enseigne'         as enseigne,
      r->>'nature_juridique' as nature_juridique,
      r->>'naf_code'         as naf_code,
      r->>'naf_libelle'      as naf_libelle,
      r->>'tranche_effectif' as tranche_effectif,
      (r->>'annee_effectif')::int as annee_effectif,
      r->>'tranche_source'   as tranche_source,
      r->>'tranche_effectif_etab' as tranche_effectif_etab,
      r->>'tranche_effectif_ul'   as tranche_effectif_ul,
      (r->>'annee_effectif_ul')::int as annee_effectif_ul,
      (r->>'nb_etablissements_ouverts')::int as nb_etablissements_ouverts,
      (r->>'date_creation_ul')::date   as date_creation_ul,
      (r->>'date_creation_etab')::date as date_creation_etab,
      r->>'adresse'          as adresse,
      r->>'code_postal'      as code_postal,
      r->>'commune'          as commune,
      coalesce(r->'dirigeants','[]'::jsonb) as dirigeants,
      coalesce((r->>'est_siege')::boolean,false) as est_siege,
      coalesce((r->>'est_client')::boolean,false) as est_client
    from jsonb_array_elements(_rows) r;

  -- Réactivations (archivées qui réapparaissent) et mises à jour.
  select count(*) into v_reactivees
    from _lot l join public.commando_entreprises e on e.siret = l.siret where e.archived_at is not null;
  select count(*) into v_mises_a_jour
    from _lot l join public.commando_entreprises e on e.siret = l.siret where e.archived_at is null;

  insert into public.commando_entreprises as e (
    siret, siren, raison_sociale, enseigne, nature_juridique, naf_code, naf_libelle,
    tranche_effectif, annee_effectif, tranche_source, tranche_effectif_etab, tranche_effectif_ul,
    annee_effectif_ul, nb_etablissements_ouverts, date_creation_ul, date_creation_etab,
    adresse, code_postal, commune, dirigeants, est_siege, est_client, nouvelle_semaine)
  select l.siret, l.siren, l.raison_sociale, l.enseigne, l.nature_juridique, l.naf_code,
    -- libellé fourni, sinon nomenclature embarquée (commando_naf) si elle existe
    coalesce(nullif(l.naf_libelle, ''), (select n.libelle from public.commando_naf n where n.code = l.naf_code)),
    l.tranche_effectif, l.annee_effectif, l.tranche_source, l.tranche_effectif_etab, l.tranche_effectif_ul,
    l.annee_effectif_ul, l.nb_etablissements_ouverts, l.date_creation_ul, l.date_creation_etab,
    l.adresse, l.code_postal, l.commune, l.dirigeants, l.est_siege, l.est_client,
    case when _initial then null else _semaine end
  from _lot l
  on conflict (siret) do update set
    siren = excluded.siren, raison_sociale = excluded.raison_sociale, enseigne = excluded.enseigne,
    nature_juridique = excluded.nature_juridique, naf_code = excluded.naf_code, naf_libelle = excluded.naf_libelle,
    tranche_effectif = excluded.tranche_effectif, annee_effectif = excluded.annee_effectif,
    tranche_source = excluded.tranche_source, tranche_effectif_etab = excluded.tranche_effectif_etab,
    tranche_effectif_ul = excluded.tranche_effectif_ul, annee_effectif_ul = excluded.annee_effectif_ul,
    nb_etablissements_ouverts = excluded.nb_etablissements_ouverts,
    date_creation_ul = excluded.date_creation_ul, date_creation_etab = excluded.date_creation_etab,
    adresse = excluded.adresse, code_postal = excluded.code_postal, commune = excluded.commune,
    dirigeants = excluded.dirigeants, est_siege = excluded.est_siege, est_client = excluded.est_client,
    last_seen_at = now(),
    -- une entreprise archivée qui réapparaît est réactivée et redevient « nouvelle »
    nouvelle_semaine = case when e.archived_at is not null and not _initial then _semaine else e.nouvelle_semaine end,
    archived_at = null, archive_raison = null;

  get diagnostics v_ajoutees = row_count;
  v_ajoutees := v_ajoutees - v_reactivees - v_mises_a_jour;
  return jsonb_build_object('ajoutees', v_ajoutees, 'reactivees', v_reactivees, 'mises_a_jour', v_mises_a_jour);
end $$;
revoke all on function public.commando_import_upsert(jsonb, text, boolean) from public, anon, authenticated;

-- Clôture d'un import : archive les établissements des codes postaux traités
-- qui n'ont pas été revus (fermés ou sortis du périmètre), jamais supprimés.
create or replace function public.commando_import_archiver(_codes text[], _depuis timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_par_secteur jsonb;
begin
  with a as (
    update public.commando_entreprises
       set archived_at = now(), archive_raison = 'non_revu'
     where code_postal = any(_codes) and archived_at is null and last_seen_at < _depuis
    returning code_postal
  )
  select coalesce(jsonb_object_agg(s.secteur_code, s.n), '{}'::jsonb) into v_par_secteur
    from (select coalesce(cp.secteur_code, '?') as secteur_code, count(*) as n
            from a left join public.commando_codes_postaux cp on cp.code_postal = a.code_postal
           group by 1) s;
  return jsonb_build_object('par_secteur', v_par_secteur);
end $$;
revoke all on function public.commando_import_archiver(text[], timestamptz) from public, anon, authenticated;

-- Applique la liste des SIREN clients à la base (responsable).
create or replace function public.commando_appliquer_clients()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_on int; v_off int;
begin
  if not public.commando_est_responsable(auth.uid()) then
    raise exception 'Réservé au responsable du commando' using errcode = '42501';
  end if;
  update public.commando_entreprises e set est_client = true
   where not e.est_client and exists (select 1 from public.commando_clients_siren c where c.siren = e.siren);
  get diagnostics v_on = row_count;
  update public.commando_entreprises e set est_client = false
   where e.est_client and not exists (select 1 from public.commando_clients_siren c where c.siren = e.siren);
  get diagnostics v_off = row_count;
  return jsonb_build_object('marquees_client', v_on, 'retirees_client', v_off);
end $$;
revoke all on function public.commando_appliquer_clients() from public, anon;
grant execute on function public.commando_appliquer_clients() to authenticated;

-- Compteurs de la base par code postal (console). Membres uniquement.
create or replace function public.commando_stats_base()
returns table (code_postal text, actives bigint, archivees bigint, clients bigint,
               oppositions bigint, effectif_inconnu bigint, nouvelles bigint)
language sql stable security definer set search_path = public as $$
  select e.code_postal,
         count(*) filter (where e.archived_at is null),
         count(*) filter (where e.archived_at is not null),
         count(*) filter (where e.archived_at is null and e.est_client),
         count(*) filter (where e.archived_at is null and c.opposition),
         count(*) filter (where e.archived_at is null and e.tranche_effectif is null),
         count(*) filter (where e.archived_at is null and e.nouvelle_semaine = public.commando_semaine_cible(current_date))
    from public.commando_entreprises e
    left join public.commando_contacts c on c.siret = e.siret
   where public.commando_est_membre(auth.uid())
   group by e.code_postal;
$$;
revoke all on function public.commando_stats_base() from public, anon;
grant execute on function public.commando_stats_base() to authenticated;

-- ------------------------------------------------------------
-- 7) Row-Level Security
--    Toute policy commence par l'appartenance au commando.
-- ------------------------------------------------------------
alter table public.commando_membres        enable row level security;
alter table public.commando_secteurs       enable row level security;
alter table public.commando_codes_postaux  enable row level security;
alter table public.commando_entreprises    enable row level security;
alter table public.commando_contacts       enable row level security;
alter table public.commando_clients_siren  enable row level security;
alter table public.commando_imports        enable row level security;
alter table public.commando_parametres     enable row level security;
alter table public.commando_semaines       enable row level security;
alter table public.commando_generations    enable row level security;
alter table public.commando_thematiques    enable row level security;
alter table public.commando_ciblages       enable row level security;
alter table public.commando_appels         enable row level security;

-- Les utilisateurs anonymes n'ont rien à faire ici.
revoke all on public.commando_membres, public.commando_secteurs, public.commando_codes_postaux,
  public.commando_entreprises, public.commando_contacts, public.commando_clients_siren,
  public.commando_imports, public.commando_parametres, public.commando_semaines,
  public.commando_generations, public.commando_thematiques, public.commando_ciblages,
  public.commando_appels from anon;

-- --- membres : lecture par les membres, gestion par le responsable ---
drop policy if exists commando_membres_select on public.commando_membres;
create policy commando_membres_select on public.commando_membres for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_membres_write on public.commando_membres;
create policy commando_membres_write on public.commando_membres for all to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

-- --- secteurs, codes postaux : lecture membres, écriture responsable ---
drop policy if exists commando_secteurs_select on public.commando_secteurs;
create policy commando_secteurs_select on public.commando_secteurs for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_secteurs_write on public.commando_secteurs;
create policy commando_secteurs_write on public.commando_secteurs for all to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

drop policy if exists commando_cp_select on public.commando_codes_postaux;
create policy commando_cp_select on public.commando_codes_postaux for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_cp_write on public.commando_codes_postaux;
create policy commando_cp_write on public.commando_codes_postaux for all to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

-- --- entreprises : lecture membres ; mise à jour responsable, colonnes limitées ;
--     insertion/suppression réservées à l'import (service_role) ---
drop policy if exists commando_entreprises_select on public.commando_entreprises;
create policy commando_entreprises_select on public.commando_entreprises for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
revoke insert, update, delete on public.commando_entreprises from authenticated;
grant update (est_client, exclu_le, exclu_par, exclu_raison) on public.commando_entreprises to authenticated;
drop policy if exists commando_entreprises_update on public.commando_entreprises;
create policy commando_entreprises_update on public.commando_entreprises for update to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

-- --- contacts : lecture et saisie par tous les membres ---
drop policy if exists commando_contacts_select on public.commando_contacts;
create policy commando_contacts_select on public.commando_contacts for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_contacts_insert on public.commando_contacts;
create policy commando_contacts_insert on public.commando_contacts for insert to authenticated
  with check ( (select public.commando_est_membre(auth.uid())) and updated_by = auth.uid() );
drop policy if exists commando_contacts_update on public.commando_contacts;
create policy commando_contacts_update on public.commando_contacts for update to authenticated
  using ( (select public.commando_est_membre(auth.uid())) )
  with check ( (select public.commando_est_membre(auth.uid())) and updated_by = auth.uid() );
drop policy if exists commando_contacts_delete on public.commando_contacts;
create policy commando_contacts_delete on public.commando_contacts for delete to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) );

-- --- clients, imports, générations : responsable ---
drop policy if exists commando_clients_all on public.commando_clients_siren;
create policy commando_clients_all on public.commando_clients_siren for all to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

drop policy if exists commando_imports_select on public.commando_imports;
create policy commando_imports_select on public.commando_imports for select to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) );
revoke insert, update, delete on public.commando_imports from authenticated;

drop policy if exists commando_generations_select on public.commando_generations;
create policy commando_generations_select on public.commando_generations for select to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) );
revoke insert, update, delete on public.commando_generations from authenticated;

-- --- paramètres : lecture membres, modification responsable (jamais d'insert/delete) ---
drop policy if exists commando_parametres_select on public.commando_parametres;
create policy commando_parametres_select on public.commando_parametres for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_parametres_update on public.commando_parametres;
create policy commando_parametres_update on public.commando_parametres for update to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );
revoke insert, delete on public.commando_parametres from authenticated;

-- --- semaines : lecture membres ; création/modification responsable ;
--     suppression d'un brouillon seulement ---
drop policy if exists commando_semaines_select on public.commando_semaines;
create policy commando_semaines_select on public.commando_semaines for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_semaines_insert on public.commando_semaines;
create policy commando_semaines_insert on public.commando_semaines for insert to authenticated
  with check ( (select public.commando_est_responsable(auth.uid())) );
drop policy if exists commando_semaines_update on public.commando_semaines;
create policy commando_semaines_update on public.commando_semaines for update to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );
drop policy if exists commando_semaines_delete on public.commando_semaines;
create policy commando_semaines_delete on public.commando_semaines for delete to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) and statut = 'brouillon' );

-- --- thématiques : le responsable voit tout ; un commercial ne voit que les
--     thématiques retenues d'une semaine publiée ---
drop policy if exists commando_thematiques_select on public.commando_thematiques;
create policy commando_thematiques_select on public.commando_thematiques for select to authenticated
  using (
    (select public.commando_est_responsable(auth.uid()))
    or ( (select public.commando_est_membre(auth.uid()))
         and statut = 'retenue'
         and exists (select 1 from public.commando_semaines s where s.id = semaine_id and s.statut = 'publiee') )
  );
drop policy if exists commando_thematiques_write on public.commando_thematiques;
create policy commando_thematiques_write on public.commando_thematiques for all to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) )
  with check ( (select public.commando_est_responsable(auth.uid())) );

-- --- ciblages : lecture membres ; écrits uniquement par la fonction de publication ---
drop policy if exists commando_ciblages_select on public.commando_ciblages;
create policy commando_ciblages_select on public.commando_ciblages for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
revoke insert, update, delete on public.commando_ciblages from authenticated;

-- --- appels : lecture par tous les membres (pour savoir qui a déjà appelé) ;
--     chacun crée et modifie ses propres appels ; le responsable peut tout modifier ---
drop policy if exists commando_appels_select on public.commando_appels;
create policy commando_appels_select on public.commando_appels for select to authenticated
  using ( (select public.commando_est_membre(auth.uid())) );
drop policy if exists commando_appels_insert on public.commando_appels;
create policy commando_appels_insert on public.commando_appels for insert to authenticated
  with check ( (select public.commando_est_membre(auth.uid())) and commercial_id = auth.uid() );
drop policy if exists commando_appels_update on public.commando_appels;
create policy commando_appels_update on public.commando_appels for update to authenticated
  using ( (select public.commando_est_membre(auth.uid()))
          and (commercial_id = auth.uid() or (select public.commando_est_responsable(auth.uid()))) )
  with check ( (select public.commando_est_membre(auth.uid()))
          and (commercial_id = auth.uid() or (select public.commando_est_responsable(auth.uid()))) );
drop policy if exists commando_appels_delete on public.commando_appels;
create policy commando_appels_delete on public.commando_appels for delete to authenticated
  using ( (select public.commando_est_responsable(auth.uid())) );

-- ------------------------------------------------------------
-- 8) Données initiales (idempotentes)
-- ------------------------------------------------------------
insert into public.commando_parametres (id) values (true) on conflict (id) do nothing;

insert into public.commando_secteurs (code, nom, commercial_id, ordre) values
  ('63', 'Ouest',      (select id from public.profiles where email = 'sarah.leveque@rex-rotary.fr'), 1),
  ('64', 'Est',        (select id from public.profiles where email = 'teo.caron@rex-rotary.fr'),     2),
  ('NO', 'Nord-Ouest', (select id from public.profiles where email = 'arthur.roulon@rex-rotary.fr'), 3),
  ('65', 'Centre-Sud', null, 4)
on conflict (code) do nothing;

insert into public.commando_codes_postaux (code_postal, ville, secteur_code) values
  ('37160', 'Buxeuil', '64'),
  ('86000', 'Poitiers', '63'),
  ('86100', 'Châtellerault', '64'),
  ('86110', 'Saint-Martin-la-Pallu', 'NO'),
  ('86120', 'Les Trois-Moutiers', 'NO'),
  ('86130', 'Jaunay-Marigny', 'NO'),
  ('86140', 'Lencloître', 'NO'),
  ('86150', 'L''Isle-Jourdain', '65'),
  ('86160', 'Gençay', '65'),
  ('86170', 'Neuville-de-Poitou', 'NO'),
  ('86180', 'Buxerolles', '63'),
  ('86190', 'Vouillé', 'NO'),
  ('86200', 'Loudun', 'NO'),
  ('86210', 'Vouneuil-sur-Vienne', '64'),
  ('86220', 'Dangé-Saint-Romain', '64'),
  ('86230', 'Saint-Gervais-les-Trois-Clochers', '64'),
  ('86240', 'Fontaine-le-Comte', '65'),
  ('86250', 'Charroux', '65'),
  ('86260', 'Saint-Pierre-de-Maillé', '64'),
  ('86270', 'La Roche-Posay', '64'),
  ('86280', 'Saint-Benoît', '63'),
  ('86290', 'La Trimouille', '65'),
  ('86300', 'Chauvigny', '65'),
  ('86310', 'Saint-Germain', '65'),
  ('86320', 'Lussac-les-Châteaux', '65'),
  ('86330', 'Saint-Jean-de-Sauves', 'NO'),
  ('86340', 'Nouaillé-Maupertuis', '65'),
  ('86350', 'Usson-du-Poitou', '65'),
  ('86360', 'Chasseneuil-du-Poitou', '63'),
  ('86370', 'Vivonne', '65'),
  ('86380', 'Chabournay', 'NO'),
  ('86390', 'Lathus-Saint-Rémy', '65'),
  ('86400', 'Civray', '65'),
  ('86410', 'Verrières', '65'),
  ('86420', 'Monts-sur-Guesnes', 'NO'),
  ('86430', 'Adriers', '65'),
  ('86440', 'Migné-Auxances', '63'),
  ('86450', 'Pleumartin', '64'),
  ('86460', 'Availles-Limouzine', '65'),
  ('86470', 'Boivre-la-Vallée', '65'),
  ('86480', 'Rouillé', '65'),
  ('86490', 'Colombiers', '64'),
  ('86500', 'Montmorillon', '65'),
  ('86510', 'Chaunay', '65'),
  ('86530', 'Naintré', '64'),
  ('86540', 'Thuré', '64'),
  ('86550', 'Mignaloux-Beauvoir', '63'),
  ('86580', 'Vouneuil-sous-Biard', '63'),
  ('86600', 'Lusignan', '65'),
  ('86700', 'Valence-en-Poitou', '65'),
  ('86800', 'Saint-Julien-l''Ars', '65')
on conflict (code_postal) do nothing;

-- Membres : le responsable et les trois commerciaux de Poitiers (si les
-- profils existent — sur une branche sans données, la liste reste vide).
insert into public.commando_membres (user_id, role)
select id, 'responsable' from public.profiles where email = 'scott.heitgen@rex-rotary.fr'
on conflict (user_id) do nothing;
insert into public.commando_membres (user_id, role)
select id, 'commercial' from public.profiles
 where email in ('sarah.leveque@rex-rotary.fr', 'teo.caron@rex-rotary.fr', 'arthur.roulon@rex-rotary.fr')
on conflict (user_id) do nothing;
