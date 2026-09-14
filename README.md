# WhatsApp Manager — Bulk Sender & AI Agent

> A powerful WhatsApp automation tool with AI agent capabilities for managing chats, sending bulk messages, and automating responses via Google Gemini AI.

**Important:** This tool is built for authorized use only. Automating WhatsApp without Meta's official Business API may violate WhatsApp Terms of Service. Use responsibly and at your own risk.

---

## Features

- **Bulk Messaging** — Send messages, media, and templates to multiple contacts in sequence with configurable delays and scheduling.
- **AI Chat Agent** — Powered by Google Gemini (via `@google/generative-ai`), the built-in chatbot can auto-respond to incoming messages using context-aware conversations.
- **QR Code Login** — Scan a QR code to authenticate with WhatsApp Web session. Session data stored locally.
- **OTP Verification** — Admin console supports OTP-based identity verification.
- **REST API Server** — Built-in Express server exposes endpoints for sending messages, generating responses, managing contacts, and checking bulk job status.
- **Discord Webhook Integration** — Optional notifications sent to a Discord channel for event alerts (configure via `DISCORD_WEBHOOK_URL`).
- **Timezone Detection** — Uses TimezoneDB and IPGeolocation to detect recipient timezone for scheduled sends.
- **Media Attachments** — Supports text, images, documents, and other attachment types.
- **Chat History & Auto-Response** — Chat agent reads conversation history and decides whether to auto-respond.
- **Contact Management** — Import contacts from CSV; manage user/contact lists.
- **Session Persistence** — WhatsApp Web session cached locally for re-login without re-scanning QR.
- **Excel Status Export** — Bulk send progress exported to `.xlsx` for reporting.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js |
| Desktop shell | Electron |
| WhatsApp client | `whatsapp-web.js` |
| AI (chat agent) | Google Gemini (`@google/generative-ai`, LangChain) |
| Web server | Express + Socket.IO |
| File handling | Multer, ExcelJS, csv-parse |
| QR display | qrcode-terminal |
| Config | dotenv, electron-store |

## Project Structure

```
.
├── main.js            # Electron main process + Express server + WhatsApp logic
├── agent2.js          # AI agent helper module
├── preload.js         # Electron preload script
├── example_chatbot.js # Example chatbot implementation
├── New folder/        # Duplicate main.js copy (keep only main.js in production)
├── front/             # Frontend UI (HTML/CSS/JS served by Express)
├── uploads/           # Uploaded attachments (temp)
├── whatsapp-auth/     # WhatsApp session data (do not commit)
├── .env.example       # Environment variable template
├── package.json
└── .gitignore
```

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/Pawan947/whatsapp-bulk-sender.git
   cd whatsapp-bulk-sender
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   # Edit .env and add your API keys
   ```

   | Variable | Description |
   |----------|-------------|
   | `DISCORD_WEBHOOK_URL` | Discord webhook URL for event notifications (optional) |
   | `TIMEZONEDB_API_KEY` | API key for TimezoneDB (optional, used for timezone lookups) |
   | `IPGEOLOCATION_API_KEY` | API key for IPGeolocation (optional, used for timezone lookups) |
   | `GOOGLE_API_KEY` | Google API key with Gemini access for AI chat agent |

4. **Run**
   ```bash
   # Desktop app (Electron UI)
   npm start

   # Headless bot mode (no UI)
   npm run bot
   ```

5. **Scan QR** — A QR code will appear in the terminal. Scan it with WhatsApp on your phone to link the session.

## Environment Variables

See `.env.example` for the full list. All secrets must be provided via environment variables — **never commit a `.env` file**.

### Required for AI features
- `GOOGLE_API_KEY` — Google API key with Generative AI enabled.

### Optional
- `DISCORD_WEBHOOK_URL` — Discord webhook for alerts.
- `TIMEZONEDB_API_KEY` — TimezoneDB API key.
- `IPGEOLOCATION_API_KEY` — IPGeolocation API key.

## API Endpoints (Express server)

The built-in Express server (default port 3000) exposes the following endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/get-qr` | Returns the WhatsApp QR code for login |
| `POST` | `/send-message` | Send a single message to a phone number |
| `POST` | `/send-bulk` | Send bulk messages to a list of numbers |
| `POST` | `/generate-response` | Generate an AI response for a message |
| `POST` | `/send-agent-response` | Send an AI-generated response to a chat |
| `POST` | `/verify-otp` | Verify an OTP for admin access |
| `GET` | `/get-chat-list` | List available chats |
| `GET` | `/get-chat-history` | Get chat history for a given chat ID |

> Authentication via token header required for most endpoints. See `main.js` for token validation logic.

## Bulk Sending

Bulk sending works by:
1. Providing a list of phone numbers (CSV import supported).
2. Configuring message text, media attachments, and sending options (delay, schedule, variables).
3. The tool sends messages sequentially with the configured gap between each.
4. Progress is saved to `bulk_status.xlsx` and can be resumed if interrupted.

> Sending rates are limited by WhatsApp. Excessive automation may trigger temporary or permanent bans. Respect rate limits and user consent.

## AI Chat Agent

The built-in AI agent:
- Listens for incoming messages on linked WhatsApp chats.
- Checks if auto-response is enabled for that chat.
- Generates a reply using Google Gemini based on conversation history.
- Sends the response back to the chat.

Configure agent behavior via the agent settings UI or by editing `agent-settings.json`.

## Session Management

- WhatsApp sessions are stored locally in `whatsapp-auth/session/`.
- The session is cached after the initial QR login.
- Subsequent runs re-use the cached session (no QR rescan needed).
- **Never commit session files** — they allow full account access.

## Security Notes

- **Do not commit `.env` or session files.** The `.gitignore` excludes these.
- WhatsApp session data is sensitive — treat it like a password.
- Use strong, unique API keys for external services.
- This tool interacts with WhatsApp Web; automation at scale may trigger anti-abuse measures.

## Disclaimer

This project is a community-built automation tool. It is **not** affiliated with, endorsed by, or connected to WhatsApp, Meta, or Google.

Automating personal WhatsApp accounts may violate [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Use at your own risk. For business use cases, consider the official [WhatsApp Business Platform](https://business.whatsapp.com/).

## License

MIT License — see [LICENSE](LICENSE) file.

## Repository

- **Name:** `whatsapp-bulk-sender`
- **URL:** https://github.com/Pawan947/whatsapp-bulk-sender
- **Version:** 1.0.0
- **Author:** Pawan947

> Note: This repo was sanitized for public release. All secrets (API keys, Discord webhooks, session data) have been removed and replaced with environment variable references.
