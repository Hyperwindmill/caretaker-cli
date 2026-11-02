# Telegram: immagini verso gli agent e finestra di accumulo per chat

Data: 2026-11-02
Stato: design approvato, da pianificare

## Intento

Oggi il poller Telegram scarta in silenzio ogni messaggio che non abbia `text`, e
quando in un tick arrivano più messaggi dalla stessa chat esegue una run
dell'agente per ciascuno. Le due cose insieme producono un bot che ignora una
foto con didascalia senza nemmeno dire di averla vista, e che risponde tre volte
di fila a chi scrive tre righe di seguito.

Questo design copre entrambe, perché sono lo stesso meccanismo: una **finestra di
accumulo per chat** che raccoglie i messaggi in arrivo e li consegna all'agente
come **un solo turno**, con le immagini allegate.

## Obiettivi

- Le immagini inviate su Telegram arrivano all'agente come allegati del turno,
  riusando la pipeline allegati esistente (`saveAttachment` →
  `promptAttachments` → parti `image_url`).
- Più messaggi dalla stessa chat nella stessa finestra diventano **una sola
  risposta**, con tutti i messaggi nel contesto. Come farebbe un umano che
  guarda la chat e risponde a quello che ha letto.
- Una foto senza didascalia attende del testo prima di far partire il turno, e
  parte comunque dopo un tempo di sicurezza.
- Nessun messaggio ricevuto viene perso in silenzio, nemmeno quando una run è
  già in corso per quella chat.

## Non obiettivi

- **Runner esterni.** `claude_code_runner.ts` e `acp_runner.ts` ignorano
  completamente `promptAttachments`: un agente Telegram claude-code o ACP
  riceverà il testo unito ma non vedrà le immagini. È un TODO dichiarato, non un
  buco da tappare qui. La strada quando si farà: l'allegato è già un file su
  disco con un path noto, quindi a quei runner si passa il **path** nel prompt e
  l'agente lo legge con il proprio tool di lettura — non si duplica l'inline
  base64. Il servizio Telegram di riferimento gira su un provider
  OpenAI-compatibile, quindi la feature è utile dal primo giorno.
- **File non immagine** (PDF, archivi, audio, `voice`). La pipeline allegati li
  reggerebbe, ma accettare file arbitrari da una superficie remota è una
  decisione di sicurezza a sé, con tetto dimensione e whitelist MIME proprie.
- **Trascrizione dei messaggi vocali.** Stesso meccanismo più STT, giro
  separato.
- **Gestione esplicita dei media group.** Non serve codice dedicato: gli update
  di un media group cadono nella stessa finestra e si fondono da soli.
- Nessuna modifica all'interfaccia web o alla TUI.

## Anti obiettivi

Cose che renderebbero questo lavoro un fallimento anche se funzionasse:

- Ritardare i messaggi di solo testo. La finestra non deve introdurre latenza
  percepibile nel caso normale: chi scrive una riga deve ricevere risposta con
  la stessa prontezza di oggi.
- Incollare all'immagine un messaggio che non c'entra. La finestra va tenuta
  abbastanza stretta da far sì che il testo che segue una foto sia
  ragionevolmente la sua didascalia.
- Sostituire il drop silenzioso con un drop silenzioso diverso. Ogni messaggio
  accettato va consegnato o rifiutato a voce.

## Stato attuale, verificato

In `packages/cli/src/cli/web/scheduler/telegram.ts`:

- `executeTelegramPoller` committa l'offset **prima** di processare
  (intenzionale: rende impossibili le run duplicate), poi raggruppa gli update
  per `chat.id` e per ogni gruppo cicla `await executeTelegramTaskRun(...)` —
  una run per messaggio.
- Il filtro d'ingresso è `if (!msg || !msg.text) continue;`. Una foto con
  didascalia ha `caption`, non `text`, quindi viene scartata. Poiché l'offset è
  già committato, è persa per sempre.
- `executeTelegramTaskRun`, se `runningTasks` contiene già la chiave
  `${task.id}:${chat.id}`, manda l'avviso "session already in progress" e
  ritorna: anche quel messaggio è perso.
- La sessione è stabile e deterministica: `telegram_<chatId>`. Il prompt è
  `From: ...\nChat: ...\n\n<text>` al primo messaggio, `From: ...\n\n<text>`
  dopo.

Pipeline allegati già esistente e funzionante sul loop nativo:
`saveAttachment(sessionId, data, ext)` in `session/store.ts`,
`promptAttachments` in `harness/loop.ts:215`, replay della history in
`harness/history.ts:32`, tool `read_attachment` / `read_image`.

## Design

### La finestra di accumulo

Stato nuovo: un **buffer per `(task.id, chat.id)`** che raccoglie le voci in
arrivo. Ogni voce conserva: `updateId`, `date`, mittente (`username` /
`first_name`), metadati chat, il testo (`text ?? caption`, può mancare) e gli
allegati già salvati su disco.

A ogni tick, per ogni chat: le voci nuove si accodano al buffer, poi si decide
se scaricarlo.

**Il tick deve valutare i buffer anche quando non arriva nessun update.** Oggi
`executeTelegramPoller` esce subito con `if (updates.length === 0) return;`:
lasciato così, la scadenza dei 3 minuti e la consegna del buffer trattenuto dal
lock non scatterebbero mai, perché entrambe avvengono in assenza di traffico
nuovo. Il ritorno anticipato va spostato dopo la valutazione dei buffer
persistiti.

**Si scarica subito** se almeno una voce nel buffer ha del testo. È il caso
normale e non introduce ritardo.

**Si trattiene** se il buffer contiene solo voci con allegati e senza testo, e
la voce **più vecchia** ha meno di `HOLD_MS` (3 minuti). Il riferimento è la
voce più vecchia, non l'ultima: così la latenza massima resta limitata anche se
arrivano foto a raffica.

**Si scarica al tick successivo, senza attendere**, se quella chat ha avuto uno
scarico negli ultimi `WARM_MS` (2 minuti), anche se il buffer contiene solo
immagini. È il caso speculare a quello per cui la finestra esiste: l'utente
scrive «guarda questo» e subito dopo manda la foto. Il testo è già nella history
della sessione, quindi l'agente il contesto ce l'ha — trattenere l'immagine per
tre minuti lo farebbe rispondere due volte male invece di una volta bene. La
regola, detta in un modo solo: **l'attesa lunga serve a un'immagine che arriva a
freddo**, in una chat silenziosa, dove rispondere subito vorrebbe dire rispondere
al nulla.

Questo richiede di ricordare l'istante dell'ultimo scarico per chat, accanto al
buffer e con la stessa durabilità.

**Si scarica comunque** quando la voce più vecchia supera `HOLD_MS`. La scadenza
è controllata sul tick da 15 secondi, quindi l'attesa reale cade tra 180 e 195
secondi. È accettabile perché questo non è il percorso normale: è la rete di
sicurezza per quando l'utente manda una foto e poi non scrive più.

**Non si scarica** se `runningTasks` contiene già la chiave composta per quella
chat: il buffer resta dov'è e verrà consegnato al tick successivo, appena la run
in corso termina. L'avviso "session already in progress" **sparisce**: non serve
più, perché non si perde più niente. Questo chiude anche il caso attuale in cui
un messaggio arrivato durante una run lunga viene buttato.

### Persistenza

Il buffer **deve** sopravvivere a un riavvio, perché l'offset è già stato
committato quando la voce entra: un buffer solo in memoria significa perdere
l'immagine.

- I **byte** dell'immagine si scaricano e si salvano **appena arrivano**, non
  alla scadenza, via `saveAttachment('telegram_<chatId>', buf, ext)`. Il
  sessionId è deterministico, quindi la destinazione è nota prima di sapere se
  e quando il turno partirà.
- Il **record** del buffer tiene solo id allegato, metadati e timestamp, e vive
  accanto all'offset in `scheduler-logs/<taskId>.pending.json`.
- Scrittura atomica tmp + rename con retry Windows, esattamente come
  `saveTelegramOffset` nello stesso file. Non ripiegare su una `writeFile`
  diretta sulla destinazione.

### Ingresso e download delle immagini

Il filtro diventa: si accetta un messaggio se ha `text`, `caption`, `photo`, o
un `document` con `mime_type` che inizia per `image/`.

Il rifiuto **a voce** vale per i contenuti che l'utente ha inviato
deliberatamente aspettandosi una reazione — un `document` non immagine, un
`video`, un `audio`, un `voice`, uno `sticker`. Non vale per i messaggi di
servizio che Telegram consegna comunque nello stesso canale `message`
(ingressi e uscite dal gruppo, pin, cambi di titolo): su quelli il bot resta
zitto, perché nessuno sta aspettando una risposta e il rumore in un gruppo
sarebbe peggiore del drop silenzioso che stiamo chiudendo. Il drop muto da
eliminare è quello che colpisce un messaggio *rivolto al bot*.

Per `photo`, Telegram manda un array di dimensioni: si prende **l'ultima**, la
più grande. Il download è `getFile` seguito dal fetch su
`https://api.telegram.org/file/bot<token>/<file_path>`; l'estensione si ricava
dal `file_path` restituito, con il MIME come ripiego.

Tetto di dimensione: l'API bot non consente comunque il download sopra i 20 MB,
quindi quello è il soffitto naturale. Sopra soglia — `file_size` è disponibile
prima di scaricare — si risponde in chat con un rifiuto esplicito invece di
lasciare fallire `getFile` in silenzio. Un download fallito per altri motivi si
segnala in chat e non entra nel buffer.

### Il turno unito

Allo scarico, le voci del buffer diventano **un unico messaggio utente**, non N
messaggi utente consecutivi: i runner esterni ricevono comunque un prompt
singolo, e diversi provider non gradiscono turni `user` consecutivi.

- L'intestazione resta quella di oggi: `From: <mittente>` più il blocco `Chat:`
  solo al primo messaggio della sessione.
- I corpi delle voci si concatenano in ordine, separati da riga vuota.
- Se **nessuna** voce ha testo, il corpo è una riga scritta dall'host che dice
  all'agente che l'immagine è arrivata senza testo. L'agente decide come
  reagire: il tono dipende dal suo system prompt, non da una stringa fissa di
  caretaker. Lingua italiana, coerente con `[Allegato: ...]` già presente in
  `loop.ts` e `history.ts`.
- Gli allegati di tutte le voci confluiscono in un unico array passato sia a
  `promptAttachments` sia al `MessageRecord` utente persistito in sessione —
  quest'ultimo è ciò che fa funzionare il replay nei turni successivi.
- Non serve aggiungere una riga per nominare gli allegati: `loop.ts` e
  `history.ts` accodano già `[Allegato: <nome> (ID: <id>)]` al testo.

Caso a una sola voce senza allegati: il prompt prodotto deve restare **identico
byte per byte** a quello di oggi. Niente churn sul percorso più battuto.

### Chat di gruppo

La finestra è chiavata su `chat.id`, quindi in un gruppo può raccogliere
messaggi di persone diverse. Quando i mittenti nel buffer differiscono, ogni
voce porta la propria riga `From:` invece di un'unica intestazione — così
l'agente sa chi ha detto cosa e risponde una volta avendo letto tutti. *(Scelta
mia, non discussa: l'alternativa era chiavare la finestra su mittente oltre che
su chat, che però spezzerebbe il caso "foto e poi testo" in un gruppo.)*

## Vincoli

- Lo scheduler gira solo sotto il server web (e quindi sotto l'app desktop, che
  lo forka). Niente di tutto questo vive nella TUI o in VSCode.
- Il tick è di 15 secondi: è la granularità di ogni scadenza qui descritta.
- L'offset va committato prima del processing. Non invertire l'ordine per
  semplificare il buffer: renderebbe possibili le run duplicate.
- ESM, TypeScript strict, test co-locati `*.test.ts` sul runner di Node via
  `tsx`. `telegram.test.ts` esiste già.
- Le funzioni di decisione vanno estratte **pure** e testate: la regola di
  scarico (buffer + istante → scaricare sì/no) e la costruzione del prompt
  unito (voci + sessione nuova → testo). Stesso trattamento di `splitMessage`,
  già esportata e testata nello stesso file.
- Changeset obbligatorio (`pnpm run changeset`), impatto minor.
- `CLAUDE.md` e `README.md` vanno aggiornati nella stessa unità di lavoro: il
  comportamento cambia ed è visibile all'utente.

## Dettagli chiusi in revisione

Punti sollevati dal controllo del documento e risolti qui.

### Autorizzazione prima del download

Il controllo su `telegramAllowedChats` esiste già e oggi avviene mentre si
raggruppano gli update. Deve restare **prima** di qualsiasi `getFile` o
download: senza quest'ordine chiunque conosca il bot può riempire il disco con
immagini che non verranno mai consegnate a nessun agente. Una chat non
autorizzata non produce né scrittura su disco né voce nel buffer né risposta in
chat, esattamente come oggi.

### Ordine delle scritture e finestra di crash

L'ordine è: commit dell'offset, download dei byte, `saveAttachment`, scrittura
del record nel buffer. L'offset resta per primo per non riaprire la porta alle
run duplicate.

Resta quindi una finestra in cui un crash tra il commit dell'offset e la
scrittura del record perde il messaggio. È **la stessa esposizione di oggi**,
non una nuova: oggi un crash dopo il commit e prima della run perde il
messaggio allo stesso modo. Non vale invertire l'ordine per chiuderla, perché
il prezzo sarebbe la possibilità di run duplicate, che è molto peggio. I byte
già scritti e rimasti orfani di un record sono innocui: vivono nella cartella
allegati della sessione.

### Esito della run e consumo del buffer

Il buffer viene **consumato allo scarico**, non all'esito della run. Le voci
diventano il messaggio utente persistito in sessione prima che l'agente parta,
come avviene oggi, e il buffer si svuota lì.

Nessun ritentativo. Una run fallita non è una perdita silenziosa, perché il
percorso d'errore esistente manda già `❌ Agent error: ...` in chat: l'utente
vede che qualcosa è andato storto e può riscrivere. Ritentare lo stesso buffer
contro un agente o un provider rotto costruirebbe un ciclo di avvelenamento che
consuma token a ogni tick senza che nessuno possa fermarlo dalla chat.

### Tetti sul buffer

Il blocco dello scarico durante una run lunga rende il buffer illimitato per
costruzione, e un utente prolisso può generare un turno enorme pieno di parti
base64. Serve un tetto: **20 voci** e **8 immagini** per finestra. Oltre il
tetto le voci nuove vengono rifiutate a voce, con un messaggio che dice di
aspettare la risposta in corso. Il tetto va applicato in accodamento, non in
scarico, così il rifiuto arriva quando l'utente sta ancora scrivendo.

### Servizi disabilitati o cancellati

`runTelegramPollerTick` filtra già sui servizi `enabled`, quindi un servizio
disabilitato semplicemente non viene ticcato e il suo buffer resta congelato su
disco fino alla riattivazione. È il comportamento giusto: riattivare il servizio
consegna quello che era in sospeso. Un servizio cancellato lascia un file orfano
in `scheduler-logs/`, innocuo quanto il `.offset` che già oggi resta lì.

### Modelli senza supporto immagini

Nessun controllo di capability sul modello. Non disponiamo di metadati
affidabili sul supporto immagini per endpoint OpenAI-compatibili arbitrari, e
inventarne uno significherebbe una lista di modelli da manutenere. Se il modello
rifiuta le parti `image_url`, l'errore emerge dal percorso d'errore esistente e
arriva in chat come `❌ Agent error`. Il tool `read_attachment` resta comunque
disponibile all'agente come via alternativa, visto che il file è su disco.

### Intestazione di sessione nuova

La decisione "sessione nuova" (il blocco `Chat:` nell'intestazione) si valuta
**allo scarico**, sulla history effettiva della sessione, non all'arrivo del
singolo messaggio. Una finestra trattenuta per tre minuti su una sessione
appena creata produce quindi comunque l'intestazione completa.

Per più voci di testo dallo stesso mittente il formato è: una sola intestazione
`From:`, poi i corpi in ordine separati da riga vuota. Nessun numero di
messaggio, nessun timestamp: all'agente serve l'ordine, non la contabilità.

## Deciso dall'utente

- Le immagini vanno supportate; i file in generale no, per ora.
- Una foto senza didascalia attende del testo invece di partire subito.
- L'attesa è una rete di sicurezza, non il percorso normale: può stare larga
  perché "tutti scrivono dopo".
- Alla scadenza l'immagine parte **con una riga che dice all'agente che non
  c'era testo**, e la risposta la formula l'agente, non caretaker.
- L'attesa lunga vale solo per un'immagine che arriva **a freddo**. Se nella
  chat c'è stato uno scarico da poco, l'immagine parte quasi subito, perché il
  contesto è già nella history: copre il caso «guarda questo» seguito dalla
  foto.
- Più messaggi in una finestra devono produrre **una sola risposta**, formulata
  avendo tutti i messaggi a disposizione.
- Il recupero dei messaggi che oggi muoiono sul lock "session already in
  progress" è dentro lo scope.
- I runner ACP e claude-code restano un TODO.

## Scelte mie

Da verificare in revisione, non concordate:

- `WARM_MS` = 2 minuti per considerare «calda» una chat. La logica è stata
  approvata dall'utente; il numero è mio.
- `HOLD_MS` = 3 minuti. Lungo abbastanza da non scattare mai nell'uso reale,
  stretto abbastanza da rendere improbabile che un messaggio successivo e
  scollegato si porti dietro l'immagine.
- Scadenza misurata sulla voce più vecchia del buffer.
- Scope ai soli `image/*`; rifiuto a voce per il resto.
- Tetto 20 MB, allineato al limite dell'API bot.
- Buffer persistito in `scheduler-logs/<taskId>.pending.json`.
- Byte scaricati all'arrivo anziché allo scarico della finestra.
- Riga `From:` per voce quando i mittenti differiscono.
- Rimozione dell'avviso "session already in progress".

## Lasciato al builder

- Forma esatta del record persistito e sua evoluzione (versionamento del file).
- Testo preciso dei messaggi di rifiuto e della riga host "immagine senza
  testo".
- Se il buffer vada tenuto anche in memoria come cache davanti al file o
  riletto a ogni tick.
- Ordinamento e deduplica all'interno della finestra quando lo stesso
  `updateId` dovesse ripresentarsi.
- Come strutturare i test di integrazione sul poller senza una vera API
  Telegram, seguendo quanto già fa `telegram.test.ts`.
