const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.json({ ok: true, game: 'MAPUII' }));

const rooms = new Map();
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValue = rank => RANKS.indexOf(rank);
function shuffle(a) { for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeCallbreakDeck() {
  const d=[]; for (const suit of SUITS) RANKS.forEach((rank,value)=>d.push({id:crypto.randomUUID(),suit,rank,value})); return shuffle(d);
}
function makeRummyDeck() {
  const d=[]; for (let pack=0;pack<2;pack++) for (const suit of SUITS) RANKS.forEach((rank,value)=>d.push({id:crypto.randomUUID(),suit,rank,value,pack}));
  // One randomly selected rank is the printed-up joker for this hand.
  return shuffle(d);
}
function roomCode() { let code; do { code=crypto.randomBytes(3).toString('hex').slice(0,5).toUpperCase(); } while(rooms.has(code)); return code; }
function safeState(r, viewer) {
  const self = r.players.find(p => p.id === viewer);
  const players=r.players.map(p=>({id:p.id,name:p.name,connected:p.connected,tricks:p.tricks,bid:p.bid,total:p.total,hand:p.id===viewer?p.hand:undefined}));
  const out={code:r.code,gameType:r.gameType,maxPlayers:r.maxPlayers||2,hostId:r.hostId,yourId:viewer,resumeToken:self?.resumeToken,players,phase:r.phase,turnId:r.turnId,
    trick:(r.trick||[]).map(t=>({playerId:t.playerId,name:r.players.find(p=>p.id===t.playerId)?.name||'Player',card:{suit:t.card.suit,rank:t.card.rank}})),
    history:r.history.slice(-20),chat:(r.chat||[]).slice(-60),message:r.message||'',handNo:r.handNo};
  if(r.gameType==='rummy') {
    out.stockCount=r.stock.length; out.discardTop=r.discardPile.length?r.discardPile[r.discardPile.length-1]:null;
    out.jokerRank=r.jokerRank; out.rummyResult=r.rummyResult||null;
  }
  return out;
}
function broadcast(r) { for(const p of r.players) if(p.connected) io.to(p.id).emit('gameState',safeState(r,p.id)); }
function sendErr(socket,message) { socket.emit('errorMessage',message); }
function makePlayer(id,name,resumeToken) { return {id,name:String(name||'Player').slice(0,18),resumeToken: String(resumeToken || crypto.randomUUID()).slice(0,100),connected:true,hand:[],tricks:0,bid:null,total:0}; }
function isRoomPlayer(room, socketId) { return room.players.some(p => p.id === socketId && p.connected); }
function safeChatText(value) { return String(value || '').trim().slice(0,500); }
function dealCallbreak(r) {
  const deck=makeCallbreakDeck(); r.trick=[]; r.phase='bidding'; r.message='';
  r.players.forEach((p,i)=>{p.hand=deck.slice(i*13,(i+1)*13);p.hand.sort((a,b)=>SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)||a.value-b.value);p.tricks=0;p.bid=null;});
  r.turnId=r.players[r.handNo%r.players.length].id;
}
function dealRummy(r) {
  const deck=makeRummyDeck(); r.trick=[]; r.message=''; r.phase='playing'; r.rummyResult=null;
  r.jokerRank=RANKS[Math.floor(Math.random()*RANKS.length)];
  const dealt=r.players.length*13;
  r.players.forEach((p,i)=>{p.hand=deck.slice(i*13,(i+1)*13);p.tricks=0;p.bid=null;p.hand.sort((a,b)=>SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)||a.value-b.value);});
  r.stock=deck.slice(dealt); r.discardPile=[r.stock.pop()]; r.turnId=r.players[r.handNo%r.players.length].id;
}
function startGame(r) { if(r.gameType==='rummy') dealRummy(r); else dealCallbreak(r); }
function strength(card) { return card.value; }
function winner(trick) {
  const lead=trick[0].card.suit; let best=trick[0];
  for(const t of trick.slice(1)){const a=t.card,b=best.card;if((a.suit==='♠'&&b.suit!=='♠')||(a.suit===b.suit&&strength(a)>strength(b))||(a.suit===lead&&b.suit!=='♠'&&b.suit!==lead))best=t;}
  return best.playerId;
}
function scoreHand(r) {
  for(const p of r.players) p.total=(p.total||0)+(p.tricks>=p.bid?p.bid+(p.tricks-p.bid)*0.1:-p.bid);
  r.message=`Hand ${r.handNo+1} complete. `+r.players.map(p=>`${p.name}: ${p.tricks}/${p.bid} tricks`).join(' · ');r.history.push(r.message);r.phase='finished';r.turnId=null;
}
// Rummy validation: require two sequences, at least one pure (no joker substitutions), and valid sets/sequences covering all 13 cards.
function cardPoints(c){return ['J','Q','K','A'].includes(c.rank)?10:Number(c.rank);}
function isJoker(c,r){return c.rank===r.jokerRank;}
function groupsForHand(hand,jokerRank) {
  const n=hand.length; if(n!==13)return {valid:false,reason:'A declaration needs exactly 13 cards.'};
  const cards=hand.slice();
  // Backtracking groups into valid sequences (same suit, consecutive ranks) or sets (same rank, different suits).
  const memo=new Set();
  function groupCandidates(rem) {
    const first=rem[0], rest=rem.slice(1), out=[];
    // Sequences: enumerate subsets of 3 or 4 same-suit cards; joker-rank cards may fill missing ranks.
    for(let len=3;len<=4;len++) {
      for(let start=Math.max(0,rankValue(first.rank)-len+1);start<=Math.min(rankValue(first.rank),12-len+1);start++) {
        const ranks=Array.from({length:len},(_,i)=>RANKS[start+i]); if(!ranks.includes(first.rank))continue;
        const chosen=[first], used=new Set([first.id]); let jokers=0, ok=true;
        for(const rank of ranks) { if(rank===first.rank)continue; const match=rest.find(c=>!used.has(c.id)&&c.suit===first.suit&&c.rank===rank&&!isJoker(c,{jokerRank})); if(match){chosen.push(match);used.add(match.id);} else {const j=rest.find(c=>!used.has(c.id)&&isJoker(c,{jokerRank})); if(j){chosen.push(j);used.add(j.id);jokers++;}else{ok=false;break;}} }
        if(ok&&chosen.length===len)out.push(chosen);
      }
    }
    // Sets of 3 or 4 different suits, with joker cards allowed to substitute.
    for(let len=3;len<=4;len++) {
      const chosen=[first], used=new Set([first.id]); let ok=true;
      for(const suit of SUITS) { if(chosen.length>=len)break; if(suit===first.suit)continue; const match=rest.find(c=>!used.has(c.id)&&c.rank===first.rank&&c.suit===suit&&!isJoker(c,{jokerRank})); if(match){chosen.push(match);used.add(match.id);} }
      while(chosen.length<len){const j=rest.find(c=>!used.has(c.id)&&isJoker(c,{jokerRank}));if(!j){ok=false;break;}chosen.push(j);used.add(j.id);}
      if(ok&&new Set(chosen.filter(c=>!isJoker(c,{jokerRank})).map(c=>c.suit)).size===chosen.filter(c=>!isJoker(c,{jokerRank})).length)out.push(chosen);
    }
    return out;
  }
  function solve(rem,groups) {
    if(!rem.length){const seq=groups.filter(g=>g.type==='sequence');return seq.length>=2&&seq.some(g=>g.pure);}
    const key=rem.map(c=>c.id).sort().join(','); if(memo.has(key))return false; memo.add(key);
    for(const group of groupCandidates(rem)) {
      if(group.length<3)continue;
      const isSeq=group.every(c=>c.suit===group[0].suit); // Candidate sequence validity rechecked below.
      let sequence=false,pure=false;
      if(isSeq){const vals=group.filter(c=>!isJoker(c,{jokerRank})).map(c=>rankValue(c.rank)).sort((a,b)=>a-b);sequence=vals.length>=2&&vals.every((v,i)=>i===0||v===vals[i-1]+1); if(vals.length===1)sequence=true; pure=sequence&&!group.some(c=>isJoker(c,{jokerRank}));}
      const rest=rem.filter(c=>!group.some(g=>g.id===c.id));
      if(solve(rest,groups.concat({type:sequence?'sequence':'set',pure})))return true;
    }
    return false;
  }
  const valid=solve(cards,[]); return {valid,reason:valid?'Valid declaration!':'Invalid hand. Arrange 13 cards into sets/sequences with at least two sequences, including one pure sequence.'};
}

io.on('connection',socket=>{
  socket.on('resumeRoom',({code,resumeToken,name}={})=>{
    const room=rooms.get(String(code||'').toUpperCase());
    if(!room || !resumeToken) return socket.emit('resumeFailed','Your previous room is no longer available. Please create or join a room again.');
    const player=room.players.find(p=>p.resumeToken===String(resumeToken));
    if(!player) return socket.emit('resumeFailed','This saved room session could not be found. Please join the room again.');
    const oldId=player.id;
    player.id=socket.id; player.connected=true;
    if(name && (!player.name || player.name==='Player')) player.name=String(name).slice(0,18);
    if(room.hostId===oldId) room.hostId=socket.id;
    if(room.turnId===oldId) room.turnId=socket.id;
    for(const t of (room.trick||[])) if(t.playerId===oldId) t.playerId=socket.id;
    socket.join(room.code);
    room.message=`${player.name} reconnected.`;
    room.players.forEach(p=>{ if(p.connected) io.to(p.id).emit('roomState',safeState(room,p.id)); });
    broadcast(room);
  });
  socket.on('chatMessage',({code,text}={})=>{
    const room=rooms.get(String(code||'').toUpperCase());
    if(!room || !isRoomPlayer(room,socket.id)) return;
    const body=safeChatText(text); if(!body) return;
    room.chat=room.chat||[]; room.chat.push({id:crypto.randomUUID(),playerId:socket.id,name:room.players.find(p=>p.id===socket.id)?.name||'Player',type:'text',text:body,at:Date.now()});
    room.chat=room.chat.slice(-30); broadcast(room);
  });
  socket.on('voiceNote',({code,dataUrl,duration}={})=>{
    const room=rooms.get(String(code||'').toUpperCase());
    if(!room || !isRoomPlayer(room,socket.id)) return;
    if(typeof dataUrl!=='string' || dataUrl.length>1200000 || !/^data:audio\/(webm|mp4|ogg|mpeg|wav)(?:;[^,]+)?;base64,/.test(dataUrl)) return sendErr(socket,'Voice note must be a short audio recording under about 900 KB.');
    const seconds=Math.max(1,Math.min(30,Number(duration)||1));
    room.chat=room.chat||[]; room.chat.push({id:crypto.randomUUID(),playerId:socket.id,name:room.players.find(p=>p.id===socket.id)?.name||'Player',type:'voice',dataUrl,duration:seconds,at:Date.now()});
    room.chat=room.chat.slice(-30); broadcast(room);
  });
  socket.on('createRoom',({name,gameType,maxPlayers,resumeToken}={})=>{
    const type=gameType==='rummy'?'rummy':'callbreak'; const count=[2,3,4].includes(Number(maxPlayers))?Number(maxPlayers):2; const code=roomCode(); const room={code,gameType:type,maxPlayers:count,hostId:socket.id,players:[makePlayer(socket.id,name,resumeToken)],phase:'lobby',turnId:null,trick:[],history:[],chat:[],handNo:0,stock:[],discardPile:[],jokerRank:null};
    rooms.set(code,room);socket.join(code);socket.emit('roomState',safeState(room,socket.id));
  });
  socket.on('joinRoom',({name,code,resumeToken}={})=>{
    const room=rooms.get(String(code||'').toUpperCase()); if(!room)return sendErr(socket,'Room not found. Check the code and try again.');
    if(room.players.length>=room.maxPlayers)return sendErr(socket,`This room is full (${room.maxPlayers} players).`); if(room.phase!=='lobby')return sendErr(socket,'This game has already started. Ask for a new room.');
    room.players.push(makePlayer(socket.id,name,resumeToken));socket.join(room.code);broadcast(room);room.players.forEach(p=>io.to(p.id).emit('roomState',safeState(room,p.id)));
  });
  socket.on('startGame',({code}={})=>{const room=rooms.get(code);if(!room||room.hostId!==socket.id||room.players.length!==room.maxPlayers||room.phase!=='lobby')return;startGame(room);broadcast(room);});
  socket.on('placeBid',({code,bid}={})=>{const room=rooms.get(code);if(!room||room.gameType!=='callbreak'||room.phase!=='bidding'||room.turnId!==socket.id)return;const p=room.players.find(p=>p.id===socket.id);bid=Number(bid);if(!Number.isInteger(bid)||bid<1||bid>13)return sendErr(socket,'Bid must be from 1 to 13.');p.bid=bid;const allBid=room.players.every(player=>player.bid!=null);if(allBid){room.phase='playing';room.turnId=room.players[room.handNo%room.players.length].id;room.message='Bids are locked. Play a card.';}else{const current=room.players.findIndex(player=>player.id===socket.id);let next=null;for(let step=1;step<=room.players.length;step++){const candidate=room.players[(current+step)%room.players.length];if(candidate.bid==null){next=candidate;break;}}room.turnId=next?.id||null;}broadcast(room);});
  socket.on('playCard',({code,cardId}={})=>{const room=rooms.get(code);if(!room||room.gameType!=='callbreak'||room.phase!=='playing'||room.turnId!==socket.id)return;const p=room.players.find(p=>p.id===socket.id);const i=p.hand.findIndex(c=>c.id===cardId);if(i<0)return;const card=p.hand[i];if(room.trick.length){const lead=room.trick[0].card.suit;if(p.hand.some(c=>c.suit===lead)&&card.suit!==lead)return sendErr(socket,'You must follow suit when you can.');}p.hand.splice(i,1);room.trick.push({playerId:socket.id,card});if(room.trick.length<room.players.length){const current=room.players.findIndex(p=>p.id===socket.id);room.turnId=room.players[(current+1)%room.players.length].id;broadcast(room);return;}const winnerId=winner(room.trick),wp=room.players.find(p=>p.id===winnerId);wp.tricks++;room.history.push(`${wp.name} wins trick ${room.players.reduce((n,p)=>n+p.tricks,0)}.`);room.trick=[];if(room.players[0].hand.length===0)scoreHand(room);else{room.turnId=winnerId;room.message=`${wp.name} won the trick.`;}broadcast(room);});
  socket.on('drawRummy',({code,source}={})=>{const room=rooms.get(code);if(!room||room.gameType!=='rummy'||room.phase!=='playing'||room.turnId!==socket.id)return;const p=room.players.find(p=>p.id===socket.id);if(p.hand.length!==13)return sendErr(socket,'Discard a card before drawing again.');let card;if(source==='discard'){if(!room.discardPile.length)return sendErr(socket,'Discard pile is empty.');card=room.discardPile.pop();}else{if(!room.stock.length){if(room.discardPile.length<=1)return sendErr(socket,'No cards remain to draw.');const top=room.discardPile.pop();room.stock=shuffle(room.discardPile);room.discardPile=[top];}card=room.stock.pop();}p.hand.push(card);p.hand.sort((a,b)=>SUITS.indexOf(a.suit)-SUITS.indexOf(b.suit)||a.value-b.value);room.message=`${p.name} drew a card.`;broadcast(room);});
  socket.on('discardRummy',({code,cardId}={})=>{const room=rooms.get(code);if(!room||room.gameType!=='rummy'||room.phase!=='playing'||room.turnId!==socket.id)return;const p=room.players.find(p=>p.id===socket.id);if(p.hand.length!==14)return sendErr(socket,'Draw one card before discarding.');const i=p.hand.findIndex(c=>c.id===cardId);if(i<0)return;const [card]=p.hand.splice(i,1);room.discardPile.push(card);const current=room.players.findIndex(player=>player.id===socket.id);room.turnId=room.players[(current+1)%room.players.length].id;room.message=`${p.name} discarded a card.`;room.history.push(room.message);broadcast(room);});
  socket.on('declareRummy',({code}={})=>{const room=rooms.get(code);if(!room||room.gameType!=='rummy'||room.phase!=='playing'||room.turnId!==socket.id)return;const p=room.players.find(p=>p.id===socket.id);if(p.hand.length!==13)return sendErr(socket,'You need 13 cards to declare. Draw and discard first.');const result=groupsForHand(p.hand,room.jokerRank);if(result.valid){room.phase='finished';room.turnId=null;room.rummyResult={winnerId:p.id,winnerName:p.name,message:`${p.name} declared a valid Rummy hand!`};room.message=room.rummyResult.message;room.history.push(room.message);}else{sendErr(socket,result.reason);return;}broadcast(room);});
  socket.on('nextHand',({code}={})=>{const room=rooms.get(code);if(!room||room.hostId!==socket.id||room.phase!=='finished')return;room.handNo++;startGame(room);broadcast(room);});
  socket.on('leaveRoom',({code}={})=>{const room=rooms.get(code);if(!room)return;room.players=room.players.filter(p=>p.id!==socket.id);if(!room.players.length)rooms.delete(code);else{io.to(room.players[0].id).emit('roomClosed','The other player left the room.');rooms.delete(code);}});
  socket.on('disconnect',()=>{for(const [code,room] of rooms){const p=room.players.find(p=>p.id===socket.id);if(!p)continue;p.connected=false;broadcast(room); /* Keep rooms available for temporary disconnects and browser reloads. */ }});
});
const port=process.env.PORT||3000;server.listen(port,()=>console.log(`MAPUII server listening on ${port}`));
