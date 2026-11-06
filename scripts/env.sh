# Source this to load API keys from the macOS Keychain (never stored in files).
export OPENROUTER_API_KEY="$(security find-generic-password -a "$USER" -s openrouter-api-key -w)"
export OPENAI_API_KEY="$(security find-generic-password -a "$USER" -s openai-api-key -w)"
