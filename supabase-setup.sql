-- Pendientes: tablas para guardar las tareas de cada usuario.
-- Pega TODO este archivo en Supabase -> SQL Editor -> New query -> Run.
-- Es seguro ejecutarlo más de una vez.

-- ---------- Tablas ----------
create table if not exists public.tasks (
  user_id    uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,                    -- momento del último cambio (ms), lo pone la app
  deleted    boolean not null default false,      -- las tareas borradas se marcan, no se eliminan
  synced_at  timestamptz not null default now(),  -- lo pone el servidor; sirve para saber qué es nuevo
  primary key (user_id, id)
);

create table if not exists public.user_settings (
  user_id    uuid   primary key default auth.uid() references auth.users(id) on delete cascade,
  categories jsonb  not null,
  updated_at bigint not null,
  synced_at  timestamptz not null default now()
);

create index if not exists tasks_user_synced on public.tasks (user_id, synced_at);

-- ---------- Reglas del servidor ----------
-- 1) Anota la hora del servidor en cada cambio.
-- 2) Si llega una versión MÁS VIEJA que la guardada (por ejemplo, un dispositivo que estuvo
--    sin conexión), se ignora: siempre gana el cambio más reciente.
create or replace function public.pendientes_touch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.synced_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before insert or update on public.tasks
  for each row execute function public.pendientes_touch();

drop trigger if exists settings_touch on public.user_settings;
create trigger settings_touch before insert or update on public.user_settings
  for each row execute function public.pendientes_touch();

-- ---------- Privacidad: cada usuario solo ve y toca lo suyo ----------
alter table public.tasks         enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "tasks: solo el dueño" on public.tasks;
create policy "tasks: solo el dueño" on public.tasks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "settings: solo el dueño" on public.user_settings;
create policy "settings: solo el dueño" on public.user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
