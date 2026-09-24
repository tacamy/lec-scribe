# LecScribe Privacy Policy

Last updated: 2026-09-24 ([日本語](PRIVACY.md))

LecScribe is a Chrome extension for taking notes while watching a video, paired with a local server that runs on the user's own Mac. **Recordings, images, transcripts and notes are processed and stored entirely on the user's Mac.** The developer operates no server that receives user data and collects no telemetry or analytics.

## Data handled

| Data | What it is | Where it is stored |
|---|---|---|
| Tab audio | A recording of the audio playing in the tab where the user pressed Start | Inside the extension's private storage (OPFS) while recording; after Stop it is handed to the server on the same Mac and saved under `~/LecScribe/` |
| Video frames | Images of the video area, captured only when the picture changes | Same as above |
| Page title and URL | To record which video the notes belong to | Same as above (`session.json`; the title is used in the folder name) |
| Transcript and notes | Produced by WhisperKit on the Mac and laid out as notes | `~/LecScribe/` |
| Settings and the pairing token | Extension settings and the token used to talk to the local server | Chrome extension storage (`chrome.storage.local`); the token is only ever used on the same Mac |

This data stays on the Mac until the user deletes it. "Delete" in the session list removes it from both the extension's storage and `~/LecScribe/`.

## Data sent elsewhere

- **The Chrome extension only communicates with the server on the same Mac (`127.0.0.1`).**
- The local server connects to the internet only in these cases:
  1. On install and on start-up it checks GitHub for a newer version and fetches it (a plain HTTP request; no user data is included)
  2. On the first transcription, `whisperkit-cli` downloads its speech model from its distributor (Hugging Face)
  3. **Only if the user enables "polish notes"**, the transcript text is sent to the ChatGPT account (via Codex CLI) or OpenAI API that the user configured themselves. Audio, images and page URLs are never sent. With local Ollama nothing leaves the Mac
- No data is sent to the developer.

## Third parties

- Distribution: Google (Chrome Web Store), subject to Google's policies
- Updates: GitHub
- Optional note polishing: OpenAI (ChatGPT / OpenAI API), subject to OpenAI's policies for the transcript text sent there

## The user's responsibility

LecScribe is a tool for personal study. Do not use it on sites that prohibit recording or capturing the screen. Complying with each site's terms and with copyright is the user's responsibility. Do not distribute or publish the recordings, images or notes it produces.

## Changes

Changes to this policy are made on this page, with the date above updated.

## Contact

Questions and bug reports: https://github.com/tacamy/lec-scribe/issues
