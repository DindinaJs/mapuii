# MAPUII (2-player online prototype)

A mobile-friendly browser game for Android Chrome and iPhone Safari. It uses a private five-character room code and a Socket.IO server.

## Run locally
1. Install Node.js 18 or newer.
2. In this folder run:
   ```bash
   npm install
   npm start
   ```
3. Open `http://localhost:3000` on your computer. For testing two phones on the same Wi-Fi, open `http://YOUR_COMPUTER_LAN_IP:3000` on both.
4. One player creates a room; the other enters the room code.

## Deploy for play over the internet
Deploy this folder to a Node.js hosting service that supports WebSockets (for example Render or Railway). Use build command `npm install` and start command `npm start`. The host should assign `PORT`. Share the deployed HTTPS URL with both players.

## Current two-player rules
- Two players receive 13 cards each from a shuffled 52-card deck; remaining 26 cards are not used.
- Each player bids 1–13 tricks.
- Players must follow the lead suit if possible. Spades are trump. A higher card of the lead suit wins unless a spade is played; the highest spade wins.
- This is a custom two-player adaptation, not the official four-player Call Break rules.

## Prototype limitations
- This is an early playable prototype, not a published or signed Android/iOS app.
- Rooms and game state are kept in server memory; restarting the server clears them.
- Refreshing/reconnecting during a live hand is not fully recovered yet.
- Before public release, add stronger server-side validation, persistent sessions, anti-cheat checks, privacy information, and broader testing.
