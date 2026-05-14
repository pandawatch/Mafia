const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static('.'));

// In-memory storage for rooms
const rooms = new Map();

// Utility functions
function generateId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function createPlayer(name, socketId) {
  return {
    id: generateId(8),
    name: name,
    socketId: socketId,
    alive: true,
    role: null,
    seerResult: null,
    mayorRevealed: false
  };
}

function buildRolesForCount(count) {
  const roles = [];

  // Mafia: max 17% and max 5, at least 1 if >=3 players
  let mafiaCount = Math.floor(count * 0.17);
  if (mafiaCount < 1 && count >= 3) mafiaCount = 1;
  if (mafiaCount > 5) mafiaCount = 5;
  for (let i = 0; i < mafiaCount; i++) roles.push('mafia');

  // Doctor: 1 if >=5
  if (count >= 5) roles.push('doctor');

  // Bodyguard: 1 if >=8
  if (count >= 8) roles.push('bodyguard');

  // Seer: 1 if >=6
  if (count >= 6) roles.push('seer');

  // Mayor: 1 if >=9
  if (count >= 9) roles.push('mayor');

  // Jester: 1 if >=10, 2 if >=20
  if (count >= 10) roles.push('jester');
  if (count >= 20) roles.push('jester');

  // Masons: 2 if >=7, 3 if >=14, 4 if >=22
  let masonCount = 0;
  if (count >= 22) masonCount = 4;
  else if (count >= 14) masonCount = 3;
  else if (count >= 7) masonCount = 2;
  for (let i = 0; i < masonCount; i++) roles.push('mason');

  // Fill the rest with villagers
  while (roles.length < count) {
    roles.push('villager');
  }

  return roles;
}

function shuffleArray(arr) {
  for (let j = arr.length - 1; j > 0; j--) {
    const k = Math.floor(Math.random() * (j + 1));
    const tmp = arr[j];
    arr[j] = arr[k];
    arr[k] = tmp;
  }
  return arr;
}

function getSafeRoomState(room, playerId) {
  const safeRoom = JSON.parse(JSON.stringify(room));
  safeRoom.players.forEach(p => {
    if (p.id !== playerId && room.phase !== 'ended') {
      p.role = null;
      p.seerResult = null;
    }
  });

  const me = room.players.find(p => p.id === playerId);
  safeRoom.mySeerResult = me ? me.seerResult : null;

  return safeRoom;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room
  socket.on('createRoom', (playerName) => {
    const roomId = generateId(4);
    const host = createPlayer(playerName, socket.id);

    const room = {
      id: roomId,
      hostId: host.id,
      phase: 'lobby',
      players: [host],
      votes: {},
      nightActions: {
        mafia: {},
        doctor: {},
        bodyguard: {},
        seer: {},
        mayor: {}
      },
      lastDeathMessage: null,
      lastVoteSummary: null,
      chat: [],
      createdAt: Date.now(),
      winner: null
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('roomCreated', { room: getSafeRoomState(room, host.id), playerId: host.id });
  });

  // Join room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error', 'Game already started');
      return;
    }

    const player = createPlayer(playerName, socket.id);
    room.players.push(player);
    rooms.set(roomId, room);
    socket.join(roomId);

    // Notify all players in room
    io.to(roomId).emit('roomUpdated', room);

    socket.emit('roomJoined', { room: getSafeRoomState(room, player.id), playerId: player.id });
  });

  // Start game
  socket.on('startGame', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== playerId) {
      socket.emit('error', 'Access denied');
      return;
    }
    if (room.players.length < 3) {
      socket.emit('error', 'Need at least 3 players');
      return;
    }

    const count = room.players.length;
    const roles = buildRolesForCount(count);
    shuffleArray(roles);
    shuffleArray(room.players);

    for (let i = 0; i < room.players.length; i++) {
      room.players[i].role = roles[i];
      room.players[i].alive = true;
      room.players[i].seerResult = null;
    }

    room.phase = 'night';
    room.votes = {};
    room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {}, mayor: {} };
    room.lastDeathMessage = "Night falls. Shadows stretch across the town as everyone quietly locks their doors...";
    room.lastVoteSummary = null;
    room.winner = null;

    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Submit night target
  socket.on('submitNightTarget', ({ roomId, playerId, targetId }) => {
    const room = rooms.get(roomId);
    if (room.phase !== 'night') {
      socket.emit('error', 'Not night');
      return;
    }

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive) {
      socket.emit('error', 'Unauthorized');
      return;
    }

    if (!targetId || targetId === 'none') {
      if (player.role === 'mafia') delete room.nightActions.mafia[playerId];
      if (player.role === 'doctor') delete room.nightActions.doctor[playerId];
      if (player.role === 'bodyguard') delete room.nightActions.bodyguard[playerId];
      if (player.role === 'seer') delete room.nightActions.seer[playerId];
      if (player.role === 'mayor') delete room.nightActions.mayor[playerId];
      rooms.set(roomId, room);
      io.to(roomId).emit('roomUpdated', room);
      return;
    }

    if (player.role === 'mafia') {
      room.nightActions.mafia[playerId] = targetId;
    } else if (player.role === 'doctor') {
      room.nightActions.doctor[playerId] = targetId;
    } else if (player.role === 'bodyguard') {
      room.nightActions.bodyguard[playerId] = targetId;
    } else if (player.role === 'seer') {
      room.nightActions.seer[playerId] = targetId;
    } else if (player.role === 'mayor') {
      room.nightActions.mayor[playerId] = targetId;
    } else {
      socket.emit('error', 'This role has no night action');
      return;
    }

    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Advance to day (from night to discussion)
  socket.on('advanceToDay', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (room.hostId !== playerId || room.phase !== 'night') {
      socket.emit('error', 'Unauthorized');
      return;
    }

    let deathMsg = "A quiet night... maybe too quiet. No one was harmed.";
    let killedPlayer = null;

    // First, process mayor blocking
    const mayorVotes = room.nightActions.mayor || {};
    const blockedPlayers = new Set();
    Object.keys(mayorVotes).forEach(pid => {
      const targetId = mayorVotes[pid];
      if (targetId && targetId !== 'none') {
        blockedPlayers.add(targetId);
      }
    });

    const mafiaVotes = room.nightActions.mafia || {};
    const tally = {};
    Object.keys(mafiaVotes).forEach(pid => {
      const tid = mafiaVotes[pid];
      if (!blockedPlayers.has(pid)) { // Only count if not blocked
        tally[tid] = (tally[tid] || 0) + 1;
      }
    });

    let mafiaTargetId = null, maxVotes = 0;
    Object.keys(tally).forEach(tid => {
      if (tally[tid] > maxVotes) {
        maxVotes = tally[tid];
        mafiaTargetId = tid;
      }
    });

    let doctorTargetId = null;
    const docVotes = room.nightActions.doctor || {};
    Object.keys(docVotes).forEach(pid => {
      if (!blockedPlayers.has(pid)) {
        doctorTargetId = docVotes[pid];
      }
    });

    let bodyguardTargetId = null;
    const bgVotes = room.nightActions.bodyguard || {};
    Object.keys(bgVotes).forEach(pid => {
      if (!blockedPlayers.has(pid)) {
        bodyguardTargetId = bgVotes[pid];
      }
    });

    const seerVotes = room.nightActions.seer || {};
    Object.keys(seerVotes).forEach(seerPid => {
      if (!blockedPlayers.has(seerPid)) {
        const targetId = seerVotes[seerPid];
        const seerPlayer = room.players.find(p => p.id === seerPid);
        const target = room.players.find(p => p.id === targetId);
        if (seerPlayer && seerPlayer.alive && target) {
          let seenRole = target.role;
          if (seenRole === 'jester') {
            seerPlayer.seerResult = target.name + " feels... off. Their role is unclear.";
          } else {
            seerPlayer.seerResult = target.name + " is a " + seenRole.toUpperCase() + ".";
          }
        }
      }
    });

    if (mafiaTargetId) {
      const target = room.players.find(p => p.id === mafiaTargetId);
      if (target && target.alive) {
        const bodyguard = room.players.find(p => p.role === 'bodyguard' && p.alive);
        const bodyguardTakesHit = bodyguard && bodyguardTargetId === mafiaTargetId;
        const doctorSaves = doctorTargetId === mafiaTargetId || (bodyguardTakesHit && doctorTargetId === bodyguard.id);

        if (bodyguardTakesHit && !doctorSaves) {
          bodyguard.alive = false;
          killedPlayer = bodyguard;
          const bgMsgs = [
            "A brave protector stepped in. {name} took the hit and didn't make it.",
            "{name} jumped in front of danger like an action movie hero... but this isn't a movie.",
            "Someone tried to strike in the dark, but {name} shielded their friend and paid the price.",
            "{name} activated 'human shield' mode. It worked. Kind of.",
            "The attack hit, but {name} was standing in the way with dramatic timing."
          ];
          deathMsg = bgMsgs[Math.floor(Math.random() * bgMsgs.length)].replace("{name}", bodyguard.name);
        } else if (!doctorSaves) {
          target.alive = false;
          killedPlayer = target;
          const msgs = [
            "{name} was found 'sleeping with the fishes' this morning.",
            "{name} took a mysterious late-night walk and never came back.",
            "The town woke up and discovered {name} had an unfortunate meeting with gravity.",
            "A note was found: 'Nothing personal, {name}.' The message was clear.",
            "{name} didn't show up for breakfast. Or lunch. Or ever again.",
            "{name} slipped on a banana peel... that definitely wasn't an accident.",
            "{name} vanished like homework on a Friday afternoon.",
            "The town found {name} taking a very permanent nap behind the bakery.",
            "{name} opened a door labeled 'Do Not Enter.' They really should've listened.",
            "{name} lost a very intense argument with a staircase."
          ];
          deathMsg = msgs[Math.floor(Math.random() * msgs.length)].replace("{name}", target.name);
        } else {
          const savedMsgs = [
            "Someone was targeted last night, but a quick-thinking healer saved the day.",
            "The shadows moved, but a bandage and some bravery kept everyone alive.",
            "There was almost a disaster, but a quiet hero patched things up.",
            "A suspicious noise, a dramatic gasp, and then... everyone was fine. Somehow.",
            "The attack failed. Whoever tried it is probably very embarrassed."
          ];
          deathMsg = savedMsgs[Math.floor(Math.random() * savedMsgs.length)];
        }
      }
    }

    room.phase = 'discussion';
    room.votes = {};
    room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {}, mayor: {} };
    room.lastDeathMessage = deathMsg;
    room.lastVoteSummary = null;

    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Begin day phase (from discussion to day)
  socket.on('beginDay', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (room.hostId !== playerId || room.phase !== 'discussion') {
      socket.emit('error', 'Unauthorized');
      return;
    }

    room.phase = 'day';
    room.votes = {};
    room.lastVoteSummary = null;

    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Submit vote
  socket.on('submitVote', ({ roomId, playerId, targetId }) => {
    const room = rooms.get(roomId);
    if (room.phase !== 'day') {
      socket.emit('error', 'Not day');
      return;
    }

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive) {
      socket.emit('error', 'Unauthorized');
      return;
    }

    if (!targetId) targetId = 'skip';

    room.votes[playerId] = targetId;
    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Resolve day
  socket.on('resolveDay', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (room.hostId !== playerId || room.phase !== 'day') {
      socket.emit('error', 'Unauthorized');
      return;
    }

    const tally = {};
    Object.keys(room.votes).forEach(pid => {
      const tid = room.votes[pid];
      tally[tid] = (tally[tid] || 0) + 1;
    });

    const summaryLines = [];
    Object.keys(room.votes).forEach(pid => {
      const voter = room.players.find(p => p.id === pid);
      const tid = room.votes[pid];
      let targetName = 'Skip';
      if (tid !== 'skip') {
        const target = room.players.find(p => p.id === tid);
        if (target) targetName = target.name;
      }
      summaryLines.push((voter ? voter.name : 'Unknown') + " voted for " + targetName);
    });
    room.lastVoteSummary = summaryLines.join('\n');

    let maxTarget = null, maxVotes = 0;
    Object.keys(tally).forEach(tid => {
      if (tally[tid] > maxVotes) {
        maxVotes = tally[tid];
        maxTarget = tid;
      }
    });

    let dayMsg = "The town couldn't reach a clear decision. No one was eliminated.";
    let jesterWin = false;

    if (maxTarget && maxTarget !== 'skip') {
      const skipVotes = tally['skip'] || 0;
      if (maxVotes > skipVotes) {
        const target = room.players.find(p => p.id === maxTarget);
        if (target && target.alive) {
          target.alive = false;

          if (target.role === 'jester') {
            jesterWin = true;
            const jesterMsgs = [
              "The town proudly voted out {name}... who secretly wanted exactly that. The JESTER cackles in victory!",
              "{name} leaves the town smiling. The joke's on everyone else. The JESTER wins!",
              "Confetti (imaginary) falls as {name} is voted out. The JESTER's plan worked perfectly.",
              "{name} waves dramatically on the way out. Somewhere, a tiny victory trumpet plays."
            ];
            dayMsg = jesterMsgs[Math.floor(Math.random() * jesterMsgs.length)].replace("{name}", target.name);
          } else {
            const msgs = [
              "The town decided {name} was too suspicious. {name} was voted out.",
              "{name} was sent on a permanent vacation by popular vote.",
              "After a very serious meeting, the town agreed that {name} had to go.",
              "Hands were raised, votes were counted, and {name} was shown the exit.",
              "{name} lost the world's least fun popularity contest."
            ];
            dayMsg = msgs[Math.floor(Math.random() * msgs.length)].replace("{name}", target.name);
          }
        }
      }
    }

    const aliveMafia = room.players.filter(p => p.alive && p.role === 'mafia').length;
    const aliveTown = room.players.filter(p => p.alive && p.role !== 'mafia').length;

    if (jesterWin) {
      room.phase = 'ended';
      room.winner = 'jester';
    } else if (aliveMafia === 0) {
      room.phase = 'ended';
      room.winner = 'villagers';
    } else if (aliveMafia >= aliveTown) {
      room.phase = 'ended';
      room.winner = 'mafia';
    } else {
      room.phase = 'night';
      room.votes = {};
      room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {}, mayor: {} };
    }

    room.lastDeathMessage = dayMsg;
    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Post chat message
  socket.on('postChatMessage', ({ roomId, playerId, text }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    text = (text || '').trim();
    if (!text) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) {
      socket.emit('error', 'Unauthorized');
      return;
    }

    room.chat = room.chat || [];
    room.chat.push({
      id: generateId(6),
      playerId: playerId,
      name: player.name,
      text: text,
      ts: Date.now()
    });

    if (room.chat.length > 200) {
      room.chat = room.chat.slice(room.chat.length - 200);
    }

    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  // Reveal as mayor
  socket.on('revealMayor', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive || player.role !== 'mayor') {
      socket.emit('error', 'Unauthorized');
      return;
    }

    player.mayorRevealed = true;
    rooms.set(roomId, room);
    io.to(roomId).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // In a real app, you'd handle player disconnection
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});