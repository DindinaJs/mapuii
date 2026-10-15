
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/', (_, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.get('/health', (_, res) =>
  res.json({ ok: true, game: 'MAPUII' })
);

const rooms = new Map();

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [
  '2', '3', '4', '5', '6', '7',
  '8', '9', '10', 'J', 'Q', 'K', 'A'
];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    RANKS.forEach((rank, value) => {
      deck.push({
        id: crypto.randomUUID(),
        suit,
        rank,
        value
      });
    });
  }
  return shuffle(deck);
}

function roomCode() {
  let code;
  do {
    code = crypto.randomBytes(3)
      .toString('hex')
      .slice(0, 5)
      .toUpperCase();
  } while (rooms.has(code));
  return code;
}

function safeState(r, viewer) {
  const players = r.players.map(p => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    tricks: p.tricks,
    bid: p.bid,
    hand: p.id === viewer ? p.hand : undefined
  }));

  return {
    code: r.code,
    hostId: r.hostId,
    yourId: viewer,
    players,
    phase: r.phase,
    turnId: r.turnId,
    trick: r.trick.map(t => ({
      playerId: t.playerId,
      name: r.players.find(p => p.id === t.playerId)?.name || 'Player',
      card: { suit: t.card.suit, rank: t.card.rank }
    })),
    history: r.history.slice(-20),
    message: r.message || '',
    handNo: r.handNo
  };
}

function broadcast(r) {
  for (const p of r.players) {
    if (p.connected) {
      io.to(p.id).emit('gameState', safeState(r, p.id));
    }
  }
}

function sendErr(socket, message) {
  socket.emit('errorMessage', message);
}

function deal(r) {
  const deck = makeDeck();
  r.trick = [];
  r.phase = 'bidding';
  r.message = '';

  r.players.forEach((p, i) => {
    p.hand = deck.slice(i * 13, (i + 1) * 13);
    p.hand.sort((a, b) =>
      a.suit.localeCompare(b.suit) || a.value - b.value
    );
    p.tricks = 0;
    p.bid = null;
  });

  r.turnId = r.players[r.handNo % 2].id;
}

function strength(card) {
  return card.value;
}

function winner(trick) {
  const lead = trick[0].card.suit;
  let best = trick[0];

  for (const t of trick.slice(1)) {
    const a = t.card;
    const b = best.card;

    if (
      (a.suit === '♠' && b.suit !== '♠') ||
      (a.suit === b.suit && strength(a) > strength(b)) ||
      (a.suit === lead && b.suit !== '♠' && b.suit !== lead)
    ) {
      best = t;
    }
  }

  return best.playerId;
}

function scoreHand(r) {
  for (const p of r.players) {
    p.total = (p.total || 0) +
      (p.tricks >= p.bid
        ? p.bid + (p.tricks - p.bid) * 0.1
        : -p.bid);
  }

  r.message = `Hand ${r.handNo + 1} complete. ` +
    r.players.map(p => `${p.name}: ${p.tricks}/${p.bid} tricks`).join(' · ');

  r.history.push(r.message);
  r.phase = 'finished';
  r.turnId = null;
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name } = {}) => {
    const code = roomCode();
    const player = {
      id: socket.id,
      name: String(name || 'Player').slice(0, 18),
      connected: true,
      hand: [],
      tricks: 0,
      bid: null,
      total: 0
    };

    const room = {
      code,
      hostId: socket.id,
      players: [player],
      phase: 'lobby',
      turnId: null,
      trick: [],
      history: [],
      handNo: 0
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit('roomState', safeState(room, socket.id));
  });

  socket.on('joinRoom', ({ name, code } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());

    if (!room) {
      return sendErr(socket, 'Room not found. Check the code and try again.');
    }
    if (room.players.length >= 2) {
      return sendErr(socket, 'This room already has two players.');
    }
    if (room.phase !== 'lobby') {
      return sendErr(socket, 'This game has already started. Ask for a new room.');
    }

    room.players.push({
      id: socket.id,
      name: String(name || 'Player').slice(0, 18),
      connected: true,
      hand: [],
      tricks: 0,
      bid: null,
      total: 0
    });

    socket.join(room.code);
    broadcast(room);

    room.players.forEach(p =>
      io.to(p.id).emit('roomState', safeState(room, p.id))
    );
  });

  socket.on('startGame', ({ code } = {}) => {
    const room = rooms.get(code);
    if (
      !room ||
      room.hostId !== socket.id ||
      room.players.length !== 2 ||
      room.phase !== 'lobby'
    ) return;

    deal(room);
    broadcast(room);
  });

  socket.on('placeBid', ({ code, bid } = {}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'bidding' || room.turnId !== socket.id) return;

    const player = room.players.find(p => p.id === socket.id);
    bid = Number(bid);

    if (!Number.isInteger(bid) || bid < 1 || bid > 13) {
      return sendErr(socket, 'Bid must be from 1 to 13.');
    }

    player.bid = bid;
    const other = room.players.find(p => p.id !== socket.id);

    if (other.bid == null) {
      room.turnId = other.id;
    } else {
      room.phase = 'playing';
      room.turnId = room.players[room.handNo % 2].id;
      room.message = 'Bids are locked. Play a card.';
    }

    broadcast(room);
  });

  socket.on('playCard', ({ code, cardId } = {}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'playing' || room.turnId !== socket.id) return;

    const player = room.players.find(p => p.id === socket.id);
    const index = player.hand.findIndex(c => c.id === cardId);
    if (index < 0) return;

    const card = player.hand[index];

    if (room.trick.length) {
      const lead = room.trick[0].card.suit;
      if (
        player.hand.some(c => c.suit === lead) &&
        card.suit !== lead
      ) {
        return sendErr(socket, 'You must follow suit when you can.');
      }
    }

    player.hand.splice(index, 1);
    room.trick.push({ playerId: socket.id, card });

    if (room.trick.length === 1) {
      room.turnId = room.players.find(p => p.id !== socket.id).id;
      broadcast(room);
      return;
    }

    const winningId = winner(room.trick);
    const winningPlayer = room.players.find(p => p.id === winningId);
    winningPlayer.tricks++;

    room.history.push(
      `${winningPlayer.name} wins trick ${room.players.reduce((n, p) => n + p.tricks, 0)}.`
    );

    room.trick = [];

    if (room.players[0].hand.length === 0) {
      scoreHand(room);
    } else {
      room.turnId = winningId;
      room.message = `${winningPlayer.name} won the trick.`;
    }

    broadcast(room);
  });

  socket.on('nextHand', ({ code } = {}) => {
    const room = rooms.get(code);

    if (
      !room ||
      room.hostId !== socket.id ||
      room.phase !== 'finished'
    ) return;

    room.handNo++;
    deal(room);
    broadcast(room);
  });

  socket.on('leaveRoom', ({ code } = {}) => {
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      io.to(room.players[0].id).emit(
        'roomClosed',
        'The other player left the room.'
      );
      rooms.delete(code);
    }
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) continue;

      player.connected = false;
      broadcast(room);

      if (room.phase === 'lobby') {
        rooms.delete(code);
      }
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`MAPUII server listening on ${port}`);
});
