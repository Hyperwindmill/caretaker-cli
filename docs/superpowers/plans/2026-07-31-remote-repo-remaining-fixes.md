# Remote repository — fix rimanenti (handoff)

> Stato al 2026-07-31, HEAD `dcb6f88`. La feature remote-repository è implementata e
> hardened (vedi spec `2026-07-31-project-remote-repository-design.md` e piano
> `2026-07-31-project-remote-repository.md`). Dalla dual review restano **4 punti
> aperti**, tutti verificati sul codice. Suite verde: 637 test / 0 fail su cli,
> webview-ui, vscode-extension.

## 1. `fetch`/`pull` si autenticano verso `origin` letterale (IMPORTANT)

**Dove**: `packages/cli/src/lib/task_git.ts:193-194` (`syncProjectRepo`, ramo pull):

```ts
await netGit(dest, ['fetch', 'origin'], token);
await netGit(dest, ['pull', '--ff-only'], token);
```

**Problema**: il push usa `repositoryUrl` esplicita, ma fetch/pull usano il remote
`origin` del clone, qualunque esso sia. Il credential helper risponde con il PAT per
*qualsiasi* host git interroghi (nessun matching host). Se `workingDir` punta a un repo
preesistente il cui `origin` è un altro host (o se il clone è stato ereditato — vedi
punto 2), il token del progetto viene offerto a un host non previsto (confused deputy).

**Fix proposto**: all'inizio del ramo pull di `syncProjectRepo`, allineare l'origin alla
URL configurata prima di qualsiasi operazione di rete:

```ts
const currentOrigin = await git(dest, ['remote', 'get-url', 'origin']).catch(() => null);
if (currentOrigin !== url) {
  if (currentOrigin === null) {
    await git(dest, ['remote', 'add', 'origin', url]);
  } else {
    await git(dest, ['remote', 'set-url', 'origin', url]);
  }
  yield { step: 'clean', message: `Realigned origin to ${url}` };
}
```

Così fetch/pull/push parlano tutti e solo con `repositoryUrl`. Nota: `url` è già
passata da `assertCleanRemoteUrl`, quindi non può contenere credenziali.

**Test** (in `task_git.test.ts`, pattern `seededOrigin()` esistente): clone da origin A;
riconfigura il progetto con `repositoryUrl` = origin B (bare diverso con un commit in
più); sync → assert che `git remote get-url origin` in dest sia B e che il commit di B
sia arrivato.

## 2. Delete progetto non ripulisce il clone gestito → riuso id eredita il repo (IMPORTANT)

**Dove**: `DELETE /api/projects/:id` in `packages/cli/src/cli/web/server.ts:335-349`
(nessun riferimento a `repos/`), e id generati con `max(ids)+1` sia in
`server.ts` (POST) sia in `ProjectsTabSettings.tsx`.

**Problema**: cancelli il progetto con id più alto, ne crei uno nuovo → stesso id →
stesso path `~/.caretaker/repos/<id>` → il nuovo progetto eredita silenziosamente il
clone (e l'`origin`) del vecchio. Combinato col punto 1 (se non fixato), manda il token
nuovo all'host vecchio; col punto 1 fixato resta comunque contaminazione di dati.

**Fix proposto**: nel handler DELETE, dopo aver rimosso il progetto dalla config,
rimuovere il clone gestito **solo se era gestito** (stessa regola del wipe in
`syncProjectRepo`: `workingDir` vuoto ⇒ path gestito):

```ts
// project è l'elemento rimosso da config.projects
if (project && !(project.workingDir || '').trim() && (project.repositoryUrl || '').trim()) {
  await rm(join(dataDir(), 'repos', String(project.id)), { recursive: true, force: true });
}
```

Serve trattenere l'oggetto `project` prima del filter (oggi il handler filtra e basta).
MAI toccare un `workingDir` scelto dall'utente. Il fix del punto 1 resta necessario
comunque (difesa in profondità).

**Test**: creare config con progetto gestito id N + directory finta
`CARETAKER_HOME/repos/N`; DELETE → directory assente. Contro-test: progetto con
`workingDir` utente → directory intatta.

## 3. Clone divergente: `pull --ff-only` fallisce per sempre, nessun self-heal (IMPORTANT)

**Dove**: `packages/cli/src/lib/task_git.ts:127` — `broken` scatta solo se `isGitRepo`
fallisce; un clone valido ma divergente (force-push a monte, commit locale spurio sul
branch checked-out) prende sempre il ramo `pull --ff-only`, che fallisce identico a ogni
retry. Nessun `reset --hard` / re-clone forzato esiste nel codebase. Recovery oggi =
cancellare a mano `~/.caretaker/repos/<id>`.

**DECISIONE UTENTE RICHIESTA** (non implementare senza scelta esplicita):

- **Opzione A — self-heal automatico sul path gestito**: se il pull ff-only fallisce E il
  path è gestito (`workingDir` vuoto), fare `git fetch origin` +
  `git reset --hard origin/<default-branch>`. Sicuro perché sul clone gestito scrive solo
  caretaker (i task lavorano nei worktree, non nel clone), ma un reset automatico resta
  un'azione distruttiva presa da un daemon.
- **Opzione B — affordance esplicita**: bottone "Re-clone" nella UI (endpoint dedicato,
  es. `POST /api/projects/:id/reclone`, che fa rm+clone via la stessa
  `syncProjectRepo` forzando lo stato `absent`; 409 se sync in flight). Il task resta
  `blocked` finché l'utente non agisce. Più attrito, zero sorprese.

In entrambi i casi: mai auto-wipe su `workingDir` scelto dall'utente (stessa regola del
punto 2 e del wipe `broken` esistente).

## 4. Minori

**4a. Timeout di rete su `netGit`** (`task_git.ts:96-104`): oggi nessun timeout — una
connessione TCP appesa tiene occupati `syncingProjects` e il lock del task fino al
timeout del sistema. Fix: passare `timeout` a `execFile` nel helper `git()` quando
chiamato da `netGit` (es. 120s, stile `runBootstrap` che usa 10min), oppure
`-c http.lowSpeedLimit=1 -c http.lowSpeedTime=60` negli args di rete. Attenzione a non
imporre il timeout ai comandi git locali (worktree add su repo enormi può essere lento
ma legittimo).

**4b. Guardia lock su discard** (`POST /api/tasks/:id/discard-worktree` in `server.ts` e
`taskDiscardWorktreeTool` in `task_tools.ts:677`): manca il check
`task.lockedAt || runningTasks.has(lockKey)` che i gemelli delete hanno
(`server.ts:610-612`, `task_tools.ts:793-796`). Un discard manuale può correre contro un
ciclo heartbeat in corso sullo stesso worktree — preesistente, ma ora la sezione critica
include un push di rete. Fix: copiare la stessa guardia (409 / `err(...)`).

## Note operative per chi implementa

- Test co-locati, runner nativo via tsx. Comando per file singolo (path relativo al
  pacchetto, NON alla root): `pnpm -F @hyperwindmill/caretaker-cli exec tsx --test src/lib/task_git.test.ts`.
- La cwd della shell persiste tra comandi: verificare `pwd` prima di fidarsi di un
  `pnpm test` "full suite" (il conteggio atteso alla root è ~637 su 3 pacchetti).
- Ogni fix: aggiornare `CLAUDE.md` (layer 5, paragrafo remote-backed) se cambia il
  comportamento, e il changeset esiste già (`.changeset/project-remote-repository.md`) —
  la feature non è ancora rilasciata, quindi si può estendere quella voce.
- Invarianti da non rompere: token mai su argv/`.git/config`/log/messaggi
  (`assertCleanRemoteUrl` + credential helper); wipe automatico SOLO su path gestito;
  push gating prima di ogni rimozione worktree; stato sync mai persistito.
