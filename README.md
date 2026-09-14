# WhatsApp Bulk Sender & AI Chat Agent

> Desktop app for managing WhatsApp chats at scale: send bulk messages, run AI-powered auto-replies with Gemini, and chat with your own custom AI agent.

---

## What it does

- **Bulk messaging** – load contacts and send WhatsApp messages in bulk from your own account.
- **AI chat agent** – let Gemini-powered AI reply to incoming messages automatically.
- **Custom AI agent** – configure your own AI persona/bot that responds in your style.
- **Chat management** – view and manage chats from the desktop UI.
- **QR login** – log in with your WhatsApp account via QR scan (WhatsApp Web session).

---

## Tech stack

- **Electron** – desktop app shell
- **whatsapp-web.js** – WhatsApp Web session via Puppeteer
- **Node.js / Express** – backend API server
- **Google Generative AI (Gemini)** – AI responses via `@google/generative-ai`
- **LangChain** – agent/tool orchestration
- **Discord webhooks** – optional notifications

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required environment variables:

- `DISCORD_WEBHOOK_URL` – optional Discord webhook for notifications
- `TIMEZONEDB_API_KEY` – optional timezone lookups
- `IPGEOLOCATION_API_KEY` – optional IP geolocation
- `GOOGLE_API_KEY` – Gemini API key for AI features

### 3. Run the app

```bash
npm start
```

On first run, a QR code will appear. Scan it with WhatsApp → Linked Devices to connect your account.

---

## Project structure

```
whatsapp-bulk-sender/
├── main.js         # Main process: WhatsApp session, AI agent, API routes
├── preload.js      # Electron preload script
├── index.html      # UI
├── renderer.js     # Frontend logic
├── package.json
├── .env.example
└── LICENSE
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_WEBHOOK_URL` | No | Discord webhook URL for notifications |
| `TIMEZONEDB_API_KEY` | No | TimezoneDB API key |
| `IPGEOLOCATION_API_KEY` | No | IP geolocation API key |
| `GOOGLE_API_KEY` | Yes (for AI) | Google Gemini API key |

Never commit your real `.env` file. Use `.env.example` as a template.

---

## Security notes

- This app uses your own WhatsApp account via WhatsApp Web. Treat the session data as sensitive.
- `.env` files with API keys and session data are excluded from version control via `.gitignore`.
- Keep your `GOOGLE_API_KEY` private. Rotate it if it is ever exposed.

---

## License

MIT License — see [LICENSE](LICENSE).

Copyright (c) 2025 Pawan947

---

## Version

**v1.0.0** – Initial public release.
- Bulk messaging
- Gemini AI auto-responses
- Custom AI chat agent
- QR-based WhatsApp login
- Express API server
- Electron desktop app
