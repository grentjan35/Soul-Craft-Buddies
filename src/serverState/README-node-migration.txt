This folder contains the in-memory game state + Socket.IO handlers for the Node server.

Current status:
- HTTP routes implemented (pages, health, maps/backups, secure assets/chunks)
- Socket.IO handlers implemented for key events
- Basic physics/fireball/explosion loop implemented

Next steps:
- Match remaining Python behaviors (fairies, dead body cleanup/respawn timer, player-player collisions)
- Ensure client connects using Socket.IO v4 and the same event names
