# Mafia Game

A real-time multiplayer Mafia (Werewolf) game built with Node.js, Express, and Socket.IO.

## Features

- Real-time multiplayer gameplay
- Multiple roles with unique mechanics
- Atmospheric dark theme with animations and cutscenes
- Death messages and popups after each game phase
- Chat system for communication
- Responsive design
- Runs in GitHub Codespaces

## How to Run

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser and navigate to `http://localhost:3000` (or the port shown in the terminal)

The game will load `index.html` which contains the updated real-time multiplayer version.

## How to Play

1. **Host a Game**: Enter your name and click "Host" to create a new room
2. **Join a Game**: Enter your name and the 4-letter room ID, then click "Join"
3. **Start Game**: The host can start the game once enough players have joined (minimum 3)
4. **Game Phases**:
   - **Night**: Special roles perform actions
   - **Discussion**: Players discuss suspicions
   - **Day**: Players vote to eliminate someone
5. **Win Conditions**:
   - **Mafia/Godfather**: Eliminate all town members
   - **Town**: Eliminate all Mafia members
   - **Jester**: Get voted out during the day
   - **Serial Killer**: Be the last player standing
   - **Executioner**: Get your assigned target voted out

## Roles

### Town Roles
- **Villager**: No special powers, discuss and vote wisely
- **Doctor**: Protect one player each night from attacks
- **Bodyguard**: Guard someone at night, taking hits instead
- **Seer**: Inspect one player's role each night (Godfather appears as Villager)
- **Mason**: Know other Masons and can trust them
- **Mayor**: Block one player's night action, double vote when revealed
- **Investigator**: Learn if someone is innocent or guilty each night
- **Vigilante**: Kill one player during the day (one-time use)

### Mafia Roles
- **Mafia**: Work together to eliminate town members at night
- **Godfather**: Lead the Mafia, appear as Villager to Seer

### Neutral Roles
- **Jester**: Win by getting voted out during the day
- **Serial Killer**: Kill one player each night, win alone
- **Witch**: Save someone from death or kill someone (each once per game)
- **Executioner**: Win if your assigned target gets voted out

## New Features

- **Death Messages & Popups**: Dramatic overlays show after each phase with death announcements
- **Cutscenes**: Visual effects like walking silhouettes for certain death messages
- **Enhanced Atmosphere**: Improved styling with gradients, animations, and atmospheric effects
- **More Roles**: 6 new roles with unique mechanics for deeper gameplay
- **Mason**: Know other Masons and can trust them

## Controls

- **Host Controls**: Start game, advance phases
- **Night Actions**: Select targets for special roles
- **Voting**: Cast votes during day phase
- **Chat**: Communicate with other players

## Technical Details

- Backend: Node.js with Express and Socket.IO
- Frontend: HTML, CSS, JavaScript
- Real-time communication via WebSockets
- In-memory game state storage
