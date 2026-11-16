import { MAX_PLAYERS } from "./protocol.js";
import { ROOMS_MAX } from "./config.js";
import { rooms, roomOf, join, occupied, spawnCell } from './room.js';
import { locationCatalogue, locationRoom, knownLocation } from './location-world.js';
import { withTestLocation, testMap, TEST_OBST_CELLS } from './testmap.js';
function spawnPoints(id) {
  const points=(testMap.spawns || []).map((s,index)=>({index,c:s.c,r:s.r}));
  if(points.length) return points;
  const code=locationRoom(id),room=rooms.get(code) || {code,fmt:'test',cats:new Map()};
  const cell=spawnCell(room);
  return cell ? [{index:0,c:cell[0]-1,r:cell[1]-1,automatic:true}] : [];
}
export function adminLocations() {
  return locationCatalogue().map(place => { try { return withTestLocation(place.id,()=>({...place,spawns:spawnPoints(place.id)})); } catch { return {...place,spawns:[],unavailable:true}; } });
}
export function teleportAccount(accountId, locationId, spawnIndex) {
  if(!knownLocation(locationId) || !Number.isInteger(spawnIndex)) return {error:'invalid_spawn'};
  let connection, previous;
  for(const room of rooms.values()) for(const [ws,cat] of room.sockets) if(ws.account?.id===accountId) {connection=ws;previous=cat;}
  if(!connection) return {error:'not_on_field'};
  const code=locationRoom(locationId);
  if (!rooms.has(code) && [...rooms.values()].filter(room=>room.cats.size).length >= ROOMS_MAX) return {error:"rooms_full"};
  const target=roomOf(code);
  if(connection.room!==target && target.cats.size>=MAX_PLAYERS) return {error:"room_full"};
  const arrival=withTestLocation(locationId,()=>{
    const s=spawnPoints(locationId).find(point=>point.index===spawnIndex);
    if(!s || TEST_OBST_CELLS.has(`${s.c},${s.r}`) || occupied(target,s.c+1,s.r+1,previous.id)) return null;
    return {x:s.c+1,y:s.r+1,fx:s.c+.05,fy:s.r-.15,foot:{dx:.45,dy:.95}};
  });
  if(!arrival) return {error:'spawn_unavailable'};
  join(connection,{room:target.code,login:previous.login},{arrival,adminTeleport:true});
  if(connection.room!==target) return {error:'location_unavailable'};
  return {ok:true,locationId,spawnIndex};
}
