const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const app = express(); const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
app.use(express.static('public'));
app.get('/health', (_,res)=>res.json({ok:true, game:'MAPUII'}));
const rooms = new Map();
const SUITS=['♠','♥','♦','♣'], RANKS=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function makeDeck(){let d=[];for(const suit of SUITS)for(let i=0;i<RANKS.length;i++)d.push({id:crypto.randomUUID(),suit,rank:RANKS[i],value:i});return shuffle(d)}
function roomCode(){let c;do{c=crypto.randomBytes(3).toString('hex').slice(0,5).toUpperCase()}while(rooms.has(c));return c}
function safeState(r,viewer){const players=r.players.map(p=>({id:p.id,name:p.name,connected:p.connected,tricks:p.tricks,bid:p.bid,hand:p.id===viewer?p.hand.map(({id,suit,rank,value})=>({id,suit,rank,value})):undefined}));return {code:r.code,hostId:r.hostId,yourId:viewer,players,phase:r.phase,turnId:r.turnId,trick:r.trick.map(t=>({playerId:t.playerId,name:r.players.find(p=>p.id===t.playerId)?.name||'Player',card:{suit:t.card.suit,rank:t.card.rank}})),history:r.history.slice(-20),message:r.message||'',handNo:r.handNo}}
function broadcast(r){for(const p of r.players)if(p.connected)io.to(p.id).emit('gameState',safeState(r,p.id))}
function sendErr(s,m){s.emit('errorMessage',m)}
function deal(r){const d=makeDeck();r.trick=[];r.phase='bidding';r.message='';r.players.forEach((p,i)=>{p.hand=d.slice(i*13,(i+1)*13);p.hand.sort((a,b)=>a.suit.localeCompare(b.suit)||a.value-b.value);p.tricks=0;p.bid=null});r.turnId=r.players[r.handNo%2].id}
function strength(c){return c.value}
function winner(trick){const lead=trick[0].card.suit;let best=trick[0];for(const t of trick.slice(1)){const a=t.card,b=best.card;if((a.suit==='♠'&&b.suit!=='♠')||(a.suit===b.suit&&strength(a)>strength(b))||(a.suit===lead&&b.suit!=='♠'&&b.suit!==lead))best=t}return best.playerId}
function scoreHand(r){for(const p of r.players){p.total=(p.total||0)+(p.tricks>=p.bid?p.bid+(p.tricks-p.bid)*0.1:-p.bid)}r.message=`Hand ${r.handNo+1} complete. ${r.players.map(p=>`${p.name}: ${p.tricks}/${p.bid} tricks`).join(' · ')}`;r.history.push(r.message);r.phase='finished';r.turnId=null}
io.on('connection',s=>{
 s.on('createRoom',({name})=>{const code=roomCode();const p={id:s.id,name:String(name||'Player').slice(0,18),connected:true,hand:[],tricks:0,bid:null,total:0};const r={code,hostId:s.id,players:[p],phase:'lobby',turnId:null,trick:[],history:[],handNo:0};rooms.set(code,r);s.join(code);s.emit('roomState',safeState(r,s.id))});
 s.on('joinRoom',({name,code})=>{const r=rooms.get(String(code||'').toUpperCase());if(!r)return sendErr(s,'Room not found. Check the code and try again.');if(r.players.length>=2)return sendErr(s,'This room already has two players.');if(r.phase!=='lobby')return sendErr(s,'This game has already started. Ask for a new room.');const p={id:s.id,name:String(name||'Player').slice(0,18),connected:true,hand:[],tricks:0,bid:null,total:0};r.players.push(p);s.join(r.code);broadcast(r);r.players.forEach(x=>io.to(x.id).emit('roomState',safeState(r,x.id)))});
 s.on('startGame',({code})=>{const r=rooms.get(code);if(!r||r.hostId!==s.id||r.players.length!==2||r.phase!=='lobby')return;deal(r);broadcast(r)});
 s.on('placeBid',({code,bid})=>{const r=rooms.get(code);if(!r||r.phase!=='bidding'||r.turnId!==s.id)return;const p=r.players.find(x=>x.id===s.id);bid=Number(bid);if(!Number.isInteger(bid)||bid<1||bid>13)return sendErr(s,'Bid must be from 1 to 13.');p.bid=bid;const other=r.players.find(x=>x.id!==s.id);if(other.bid==null)r.turnId=other.id;else{r.phase='playing';r.turnId=r.players[r.handNo%2].id;r.message='Bids are locked. Play a card.'}broadcast(r)});
 s.on('playCard',({code,cardId})=>{const r=rooms.get(code);if(!r||r.phase!=='playing'||r.turnId!==s.id)return;const p=r.players.find(x=>x.id===s.id);const idx=p.hand.findIndex(c=>c.id===cardId);if(idx<0)return;const card=p.hand[idx];if(r.trick.length){const lead=r.trick[0].card.suit;if(p.hand.some(c=>c.suit===lead)&&card.suit!==lead)return sendErr(s,'You must follow suit when you can.')}p.hand.splice(idx,1);r.trick.push({playerId:s.id,card});if(r.trick.length===1){r.turnId=r.players.find(x=>x.id!==s.id).id;broadcast(r);return}const win=winner(r.trick);const wp=r.players.find(x=>x.id===win);wp.tricks++;r.history.push(`${wp.name} wins trick ${r.players.reduce((n,p)=>n+p.tricks,0)}.`);r.trick=[];if(r.players[0].hand.length===0){scoreHand(r)}else{r.turnId=win;r.message=`${wp.name} won the trick.`}broadcast(r)});
 s.on('nextHand',({code})=>{const r=rooms.get(code);if(!r||r.hostId!==s.id||r.phase!=='finished')return;r.handNo++;deal(r);broadcast(r)});
 s.on('leaveRoom',({code})=>{const r=rooms.get(code);if(!r)return;r.players=r.players.filter(p=>p.id!==s.id);if(r.players.length===0)rooms.delete(code);else{io.to(r.players[0].id).emit('roomClosed','The other player left the room.');rooms.delete(code)}});
 
s.on('disconnect', () => {
  for (const [code, r] of rooms) {
    const player = r.players.find(p => p.id === s.id);

    if (!player) continue;

    const otherPlayer = r.players.find(
      p => p.id !== s.id && p.connected
    );

    if (otherPlayer) {
      io.to(otherPlayer.id).emit(
        'roomClosed',
        'The other player disconnected. Please create a new room.'
      );
    }

    rooms.delete(code);
  }
});

const port=process.env.PORT||3000;server.listen(port,()=>console.log(`MAPUII server listening on ${port}`));
