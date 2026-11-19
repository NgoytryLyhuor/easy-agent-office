# 🏢 Easy Agent Office

**Watch your Google Antigravity agents work — as a 2D pixel office.**

Your agents walk to meetings, delegate tasks desk-to-desk, and show their live tool calls.
It is a visual dashboard for the agents that already run inside Antigravity.

![Easy Agent Office dashboard](./public/easy-agent-office-dashboard.png)

---

## 🚀 Start in one click (Windows)

1. Keep **Google Antigravity** installed (it can be closed — the launcher opens it).
2. Double-click **`START.bat`**.

That's it. The script will:

- check Node.js
- start Antigravity if needed
- install packages if missing
- create your 4 agents if missing
- start the server and open **http://localhost:3000**

To start it again later, just double-click `START.bat` again.

---

## 🎮 What you will see

| Character | Role |
| --- | --- |
| 👔 Alberto | CEO — walks to teammates' desks to delegate |
| ⚙️ Luigi | Backend engineer |
| 🎨 Gabri | Frontend engineer |
| 🛡️ Carlo | QA & security reviewer |

### The new simple homepage

The homepage is deliberately simple. On the left is the living pixel office.
On the right you get only four things:

1. **Your AI workers** — click a name to choose who gets the task.
2. **Give a task** — type a task and press **Send task**.
3. **Quick actions** — fun animations: 🚶 Watch delegation, 📢 Call a meeting, ☕ Coffee break.
4. **What's happening** — live activity copied from Antigravity.

Use the **English / ខ្មែរ** switch in the top-right to change language instantly.
A short welcome guide appears on your first visit, and the ❓ Help button explains
every word in plain language.

Text uses **Nunito** for English and **Kantumruy Pro** for ខ្មែរ. Both fonts are bundled
locally, so the UI looks the same even without internet.

Need every advanced setting? Open **Full version** in the top-right — the original
dashboard is kept there at `/full.html`.

---

## 🧠 How it works

```
You type a task
   ↓
Task goes to the real Antigravity agent
   ↓
Antigravity writes logs on your disk
   ↓
The pixel office reads those logs
   ↓
The character moves and shows live tool calls
```

The office does **not** think. It only watches Antigravity's local transcripts
(`~/.gemini/antigravity/brain`) and animates what it sees.

---

## ⚙️ Customize your team

Edit [`team.config.json`](./team.config.json) to change names, roles, colors or the number
of agents, then run:

```powershell
npm run setup
```

---

## 📁 Repository

This is the maintained fork:
**https://github.com/NgoytryLyhuor/easy-agent-office**

```
origin   = your fork
upstream = the original MIT-licensed project
```

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE). The original copyright notice is kept there as
required by the MIT license. The 2D canvas engine is based on the open-source
[Pixel Agents](https://github.com/pablodelucca/pixel-agents) renderer by Pablo De Lucca (MIT).
