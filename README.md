---
title: Soul Craft Buddies
emoji: 🎮
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# Soul Craft Buddies

A multiplayer platformer game built with Node.js, Express, and Socket.IO.

## Features

- Real-time multiplayer gameplay
- Level editor
- Game enhancer tools
- WebSocket-based communication

## Running Locally

```bash
npm install
npm start
```

The game will be available at:
- Main Game: http://localhost:7860/
- Editor: http://localhost:7860/editor
- Enhancer: http://localhost:7860/enhancer

## Deployment

This project is configured for Hugging Face Spaces using Docker.

### Environment Variables

- `PORT`: Server port (default: 7860)
- `HOST`: Bind host (default: 0.0.0.0)
- `SECRET_KEY`: JWT secret key
- `DATA_DIR`: Data directory path
- `NODE_ENV`: Environment (production/development)

## Technology Stack

- **Backend**: Node.js, Express.js
- **Real-time**: Socket.IO
- **Authentication**: JWT
- **Containerization**: Docker
