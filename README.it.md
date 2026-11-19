# 🏢 Easy Agent Office

**Guarda i tuoi agenti di Google Antigravity lavorare — in un ufficio 2D pixel.**

Gli agenti camminano, si riuniscono e delegano compiti da una scrivania all'altra.
Mostrano in tempo reale gli strumenti che usano.

![Dashboard di Easy Agent Office](./public/easy-agent-office-dashboard.png)

---

## 🚀 Avvio in un click (Windows)

1. Tieni installato **Google Antigravity** (può anche essere chiuso: si apre da solo).
2. Fai doppio click su **`START.bat`**.

Lo script si occupa di tutto: controlla Node.js, avvia Antigravity, installa le dipendenze,
crea i 4 agenti se non esistono, avvia il server e apre **http://localhost:3000**.

---

## 🎮 Cosa vedrai

| Personaggio | Ruolo |
| --- | --- |
| 👔 Alberto | CEO — cammina dai colleghi per delegare |
| ⚙️ Luigi | Backend developer |
| 🎨 Gabri | Frontend developer |
| 🛡️ Carlo | QA e sicurezza |

### La nuova homepage semplice

La homepage è volutamente semplice. A sinistra c'è l'ufficio pixel animato.
A destra trovi solo quattro cose:

1. **I tuoi AI worker** — clicca un nome per scegliere chi riceve il compito.
2. **Dai un compito** — scrivi il compito e premi **Invia compito**.
3. **Azioni rapide** — animazioni divertenti: 🚶 Delegazione, 📢 Riunione, ☕ Pausa caffè.
4. **Cosa sta succedendo** — attività reale copiata da Antigravity.

Usa l'interruttore **English / ខ្មែរ** in alto a destra per cambiare lingua subito.
Al primo accesso appare una breve guida, e il pulsante ❓ Help spiega ogni parola
in linguaggio semplice.

Il testo usa **Nunito** per l'inglese e **Kantumruy Pro** per il khmer. Entrambi i font
sono inclusi localmente, quindi l'interfaccia resta identica anche senza internet.

Ti servono tutte le impostazioni? Apri **Full version** in alto a destra:
la dashboard originale è disponibile su `/full.html`.

---

## 🧠 Come funziona

```
Scrivi un compito
   ↓
Il compito arriva al vero agente Antigravity
   ↓
Antigravity scrive i log sul disco
   ↓
L'ufficio pixel legge i log
   ↓
Il personaggio si muove e mostra gli strumenti usati
```

L'ufficio non pensa: osserva i transcript locali di Antigravity
(`~/.gemini/antigravity/brain`) e li trasforma in animazioni.

---

## ⚙️ Personalizza il team

Modifica [`team.config.json`](./team.config.json) per cambiare nomi, ruoli, colori o
numero di agenti, poi esegui:

```powershell
npm run setup
```

---

## 📁 Repository

**https://github.com/NgoytryLyhuor/easy-agent-office**

---

## 📄 Licenza

MIT — vedi [`LICENSE`](./LICENSE). Il renderer 2D si basa su
[Pixel Agents](https://github.com/pablodelucca/pixel-agents) di Pablo De Lucca (MIT).
