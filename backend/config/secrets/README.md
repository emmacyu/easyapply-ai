# Gmail OAuth secrets (gitignored)
Put the Google Cloud OAuth *Desktop app* client credentials here as:
  gmail_credentials.json

Then run:  docker compose exec jobpilot python main.py gmail-auth
The read-only token is written next to it as gmail_token.json.
