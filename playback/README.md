# Playback TLC

Riproduttore di multitraccia per il culto, in stile Playback di MultiTracks, come web app (PWA)
per iPad e Mac. Funziona offline: i file audio restano salvati sul dispositivo (IndexedDB).

## Funzioni
- **Scalette**: più scalette, riordino, passaggio automatico al brano successivo (stop o continua con pausa).
- **Import stem**: più file insieme (WAV, MP3, M4A, AIFF, CAF…); click e guide riconosciuti dal nome.
- **Mixer**: volume, pan, mute, solo e uscita (1-2, 3-4… o mono 1/2/3…) per traccia, meter, master.
- **Uscite multiple**: con un'interfaccia audio multicanale ogni traccia va sull'uscita che vuoi;
  con 2 uscite c'è il classico "click+guide a sinistra, tracce a destra".
- **Click generato** dal BPM (se il brano non ha già una traccia click) e **count-in** di 1-2 battute.
- **Sezioni**: segnale mentre ascolti, salti subito / a fine battuta / a fine sezione, **loop** di sezione.
- **Pad** ambient generato nella tonalità del brano, continua tra un brano e l'altro.
- **Controllo**: tastiera, MIDI (Chrome/Edge su Mac), schermo sempre acceso durante la riproduzione.

## Uso
Pubblica la cartella su un hosting HTTPS (es. GitHub Pages) e aprila in Safari.
Su iPad: Condividi → "Aggiungi alla schermata Home".
In locale: `python3 -m http.server` dalla radice del repo e apri `http://localhost:8000/playback/`.

## Limiti attuali
- Niente cambio di tonalità/tempo con time-stretch e niente catalogo MultiTracks (quello resta nell'app ufficiale).
- I brani stanno sul singolo dispositivo: vanno importati su iPad e Mac separatamente.
- Web MIDI non è disponibile in Safari.
