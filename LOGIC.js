function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Mafia');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getRoomKey(roomId) {
  return 'room_' + roomId;
}

function loadRoom(roomId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(getRoomKey(roomId));
  if (!raw) return null;
  return JSON.parse(raw);
}

function saveRoom(room) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(getRoomKey(room.id), JSON.stringify(room));
}

function generateId(len) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function createPlayer(name) {
  return {
    id: generateId(8),
    name: name,
    alive: true,
    role: null,
    seerResult: null
  };
}

function createRoom(playerName) {
  var roomId = generateId(4);
  var host = createPlayer(playerName);

  var room = {
    id: roomId,
    hostId: host.id,
    phase: 'lobby', // lobby, night, discussion, day, ended
    players: [host],
    votes: {},
    nightActions: {
      mafia: {},
      doctor: {},
      bodyguard: {},
      seer: {}
    },
    lastDeathMessage: null,
    lastVoteSummary: null,
    chat: [],
    createdAt: Date.now(),
    winner: null
  };

  saveRoom(room);
  return { room: room, playerId: host.id };
}

function joinRoom(roomId, playerName) {
  var room = loadRoom(roomId);
  if (!room) throw new Error('Room not found');
  if (room.phase !== 'lobby') throw new Error('Game already started');

  var player = createPlayer(playerName);
  room.players.push(player);
  saveRoom(room);

  return { room: room, playerId: player.id };
}

function getRoomState(roomId, playerId) {
  var room = loadRoom(roomId);
  if (!room) throw new Error('Room not found');

  var safeRoom = JSON.parse(JSON.stringify(room));
  safeRoom.players.forEach(function (p) {
    if (p.id !== playerId && room.phase !== 'ended') {
      p.role = null;
      p.seerResult = null;
    }
  });

  var me = room.players.find(function (p) { return p.id === playerId; });
  safeRoom.mySeerResult = me ? me.seerResult : null;

  return safeRoom;
}

// ---------- ROLE BUILDING & SHUFFLING ----------

function buildRolesForCount(count) {
  var roles = [];

  // Mafia: max 17% and max 5, at least 1 if >=3 players
  var mafiaCount = Math.floor(count * 0.17);
  if (mafiaCount < 1 && count >= 3) mafiaCount = 1;
  if (mafiaCount > 5) mafiaCount = 5;
  for (var i = 0; i < mafiaCount; i++) roles.push('mafia');

  // Doctor: 1 if >=5
  if (count >= 5) roles.push('doctor');

  // Bodyguard: 1 if >=8
  if (count >= 8) roles.push('bodyguard');

  // Seer: 1 if >=6
  if (count >= 6) roles.push('seer');

  // Jester: 1 if >=10, 2 if >=20
  if (count >= 10) roles.push('jester');
  if (count >= 20) roles.push('jester');

  // Masons: 2 if >=7, 3 if >=14, 4 if >=22
  var masonCount = 0;
  if (count >= 22) masonCount = 4;
  else if (count >= 14) masonCount = 3;
  else if (count >= 7) masonCount = 2;
  for (i = 0; i < masonCount; i++) roles.push('mason');

  // Fill the rest with villagers
  while (roles.length < count) {
    roles.push('villager');
  }

  return roles;
}

function shuffleArray(arr) {
  for (var j = arr.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var tmp = arr[j];
    arr[j] = arr[k];
    arr[k] = tmp;
  }
  return arr;
}

function startGame(roomId, playerId) {
  var room = loadRoom(roomId);
  if (!room || room.hostId !== playerId) throw new Error('Access denied');
  if (room.players.length < 3) throw new Error('Need at least 3 players');

  var count = room.players.length;
  var roles = buildRolesForCount(count);
  shuffleArray(roles);
  shuffleArray(room.players);

  for (var i = 0; i < room.players.length; i++) {
    room.players[i].role = roles[i];
    room.players[i].alive = true;
    room.players[i].seerResult = null;
  }

  room.phase = 'night';
  room.votes = {};
  room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {} };
  room.lastDeathMessage = "Night falls. Shadows stretch across the town as everyone quietly locks their doors...";
  room.lastVoteSummary = null;
  room.winner = null;

  saveRoom(room);
  return room;
}

// ---------- NIGHT ACTIONS ----------

function submitNightTarget(roomId, playerId, targetId) {
  var room = loadRoom(roomId);
  if (room.phase !== 'night') throw new Error('Not night');

  var player = room.players.find(function (p) { return p.id === playerId; });
  if (!player || !player.alive) throw new Error('Unauthorized');

  if (!targetId || targetId === 'none') {
    if (player.role === 'mafia') delete room.nightActions.mafia[playerId];
    if (player.role === 'doctor') delete room.nightActions.doctor[playerId];
    if (player.role === 'bodyguard') delete room.nightActions.bodyguard[playerId];
    if (player.role === 'seer') delete room.nightActions.seer[playerId];
    saveRoom(room);
    return room;
  }

  if (player.role === 'mafia') {
    room.nightActions.mafia[playerId] = targetId;
  } else if (player.role === 'doctor') {
    room.nightActions.doctor[playerId] = targetId;
  } else if (player.role === 'bodyguard') {
    room.nightActions.bodyguard[playerId] = targetId;
  } else if (player.role === 'seer') {
    room.nightActions.seer[playerId] = targetId;
  } else {
    throw new Error('This role has no night action');
  }

  saveRoom(room);
  return room;
}

// ---------- NIGHT → DISCUSSION RESOLUTION ----------

function advanceToDay(roomId, playerId) {
  // NOTE: now advances from NIGHT → DISCUSSION
  var room = loadRoom(roomId);
  if (room.hostId !== playerId || room.phase !== 'night') throw new Error('Unauthorized');

  var deathMsg = "A quiet night... maybe too quiet. No one was harmed.";
  var killedPlayer = null;

  var mafiaVotes = room.nightActions.mafia || {};
  var tally = {};
  Object.keys(mafiaVotes).forEach(function (pid) {
    var tid = mafiaVotes[pid];
    tally[tid] = (tally[tid] || 0) + 1;
  });

  var mafiaTargetId = null, maxVotes = 0;
  Object.keys(tally).forEach(function (tid) {
    if (tally[tid] > maxVotes) {
      maxVotes = tally[tid];
      mafiaTargetId = tid;
    }
  });

  var doctorTargetId = null;
  var docVotes = room.nightActions.doctor || {};
  Object.keys(docVotes).forEach(function (pid) {
    doctorTargetId = docVotes[pid];
  });

  var bodyguardTargetId = null;
  var bgVotes = room.nightActions.bodyguard || {};
  Object.keys(bgVotes).forEach(function (pid) {
    bodyguardTargetId = bgVotes[pid];
  });

  var seerVotes = room.nightActions.seer || {};
  Object.keys(seerVotes).forEach(function (seerPid) {
    var targetId = seerVotes[seerPid];
    var seerPlayer = room.players.find(function (p) { return p.id === seerPid; });
    var target = room.players.find(function (p) { return p.id === targetId; });
    if (seerPlayer && seerPlayer.alive && target) {
      var seenRole = target.role;
      if (seenRole === 'jester') {
        seerPlayer.seerResult = target.name + " feels... off. Their role is unclear.";
      } else {
        seerPlayer.seerResult = target.name + " is a " + seenRole.toUpperCase() + ".";
      }
    }
  });

  if (mafiaTargetId) {
    var target = room.players.find(function (p) { return p.id === mafiaTargetId; });
    if (target && target.alive) {
      var bodyguard = room.players.find(function (p) { return p.role === 'bodyguard' && p.alive; });
      var bodyguardTakesHit = bodyguard && bodyguardTargetId === mafiaTargetId;
      var doctorSaves = doctorTargetId === mafiaTargetId || (bodyguardTakesHit && doctorTargetId === bodyguard.id);

      if (bodyguardTakesHit && !doctorSaves) {
        bodyguard.alive = false;
        killedPlayer = bodyguard;
        var bgMsgs = [
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
        var msgs = [
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
        var savedMsgs = [
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

  room.phase = 'discussion'; // NEW PHASE
  room.votes = {};
  room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {} };
  room.lastDeathMessage = deathMsg;
  room.lastVoteSummary = null;

  saveRoom(room);
  return room;
}
// ---------- DISCUSSION → DAY ----------

function beginDay(roomId, playerId) {
  var room = loadRoom(roomId);
  if (room.hostId !== playerId || room.phase !== 'discussion') throw new Error('Unauthorized');

  room.phase = 'day';
  room.votes = {};
  room.lastVoteSummary = null;

  saveRoom(room);
  return room;
}

// ---------- DAY VOTING & RESOLUTION ----------

function submitVote(roomId, playerId, targetId) {
  var room = loadRoom(roomId);
  if (room.phase !== 'day') throw new Error('Not day');

  var player = room.players.find(function (p) { return p.id === playerId; });
  if (!player || !player.alive) throw new Error('Unauthorized');

  if (!targetId) targetId = 'skip';

  room.votes[playerId] = targetId;
  saveRoom(room);
  return room;
}

function resolveDay(roomId, playerId) {
  var room = loadRoom(roomId);
  if (room.hostId !== playerId || room.phase !== 'day') throw new Error('Unauthorized');

  var tally = {};
  Object.keys(room.votes).forEach(function (pid) {
    var tid = room.votes[pid];
    tally[tid] = (tally[tid] || 0) + 1;
  });

  var summaryLines = [];
  Object.keys(room.votes).forEach(function (pid) {
    var voter = room.players.find(function (p) { return p.id === pid; });
    var tid = room.votes[pid];
    var targetName = 'Skip';
    if (tid !== 'skip') {
      var target = room.players.find(function (p) { return p.id === tid; });
      if (target) targetName = target.name;
    }
    summaryLines.push((voter ? voter.name : 'Unknown') + " voted for " + targetName);
  });
  room.lastVoteSummary = summaryLines.join('\n');

  var maxTarget = null, maxVotes = 0;
  Object.keys(tally).forEach(function (tid) {
    if (tally[tid] > maxVotes) {
      maxVotes = tally[tid];
      maxTarget = tid;
    }
  });

  var dayMsg = "The town couldn't reach a clear decision. No one was eliminated.";
  var jesterWin = false;

  if (maxTarget && maxTarget !== 'skip') {
    var skipVotes = tally['skip'] || 0;
    if (maxVotes > skipVotes) {
      var target = room.players.find(function (p) { return p.id === maxTarget; });
      if (target && target.alive) {
        target.alive = false;

        if (target.role === 'jester') {
          jesterWin = true;
          var jesterMsgs = [
            "The town proudly voted out {name}... who secretly wanted exactly that. The JESTER cackles in victory!",
            "{name} leaves the town smiling. The joke's on everyone else. The JESTER wins!",
            "Confetti (imaginary) falls as {name} is voted out. The JESTER's plan worked perfectly.",
            "{name} waves dramatically on the way out. Somewhere, a tiny victory trumpet plays."
          ];
          dayMsg = jesterMsgs[Math.floor(Math.random() * jesterMsgs.length)].replace("{name}", target.name);
        } else {
          var msgs = [
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

  var aliveMafia = room.players.filter(function (p) { return p.alive && p.role === 'mafia'; }).length;
  var aliveTown = room.players.filter(function (p) { return p.alive && p.role !== 'mafia'; }).length;

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
    room.nightActions = { mafia: {}, doctor: {}, bodyguard: {}, seer: {} };
  }

  room.lastDeathMessage = dayMsg;
  saveRoom(room);
  return room;
}

// ---------- CHAT ----------

function postChatMessage(roomId, playerId, text) {
  var room = loadRoom(roomId);
  if (!room) throw new Error('Room not found');
  text = (text || '').trim();
  if (!text) return room;

  var player = room.players.find(function (p) { return p.id === playerId; });
  if (!player) throw new Error('Unauthorized');

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

  saveRoom(room);
  return room;
}