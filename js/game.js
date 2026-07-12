/* =====================================================================
   FLOODED — an underground water-hose digging puzzle
   Single-file HTML5 canvas game. Portrait aligned, mobile + desktop.

   You are trapped underground. A pressure hose blasts water that washes
   away dirt to carve tunnels in 8 directions. Water obeys a mass-based
   cellular-automaton fluid sim — it falls, pools, seeks its level and
   rises under pressure. Drains swallow water; clogged drains make it
   back up and flood the shaft. Ride the rising water up, dodge rocks,
   poison gas and rabid rodents, and reach the surface alive.
   ===================================================================== */
(() => {
"use strict";

/* ------------------------------------------------------------------ */
/*  Grid + tuning constants                                            */
/* ------------------------------------------------------------------ */
const COLS = 36, ROWS = 78;          // 9:16-ish portrait play grid
const SURFACE_ROWS = 6;              // top band = daylight / goal
const IDX = (x, y) => y * COLS + x;

// Cell types
const AIR=0, DIRT=1, ROCK=2, DRAIN=3, CLOG=4, SKY=5, BEDROCK=6;

// Water fluid model
const MAX_MASS=1.0, MAX_COMPRESS=0.02, MIN_FLOW=0.01, MAX_SPEED=1.0;
const DRAWN_MIN=0.02;                // below this a cell reads as "empty"
const SEEP=0.4;                      // porous-ground drainage (fraction/sec): tunnels drain

// Physics (units = cells, seconds)
const GRAV=46, MOVE=9, JUMP=15.5, MAXFALL=34, CLIMB=7.5;
const P_W=1.55, P_H=2.35;            // player size in cells
const SUBMERGE_FLOAT=100;            // buoyancy: floats you at the surface (water = elevator)
const WATER_DRAG=5.0;

// Erosion
const ERODE_RATE=7.0;                // dirt integrity lost per second in stream
const BRUSH=1.55;                    // radius of the wash brush (cells)
const STREAM_LEN=7;                  // how far the jet reaches (cells)
const SPRAY_WATER=0.6;               // water mass injected per second while spraying

/* 8 spray directions, clockwise from up */
const DIRS = [
  {name:'U',  dx:0, dy:-1, ang:-90},
  {name:'UR', dx:1, dy:-1, ang:-45},
  {name:'R',  dx:1, dy:0,  ang:0},
  {name:'DR', dx:1, dy:1,  ang:45},
  {name:'D',  dx:0, dy:1,  ang:90},
  {name:'DL', dx:-1,dy:1,  ang:135},
  {name:'L',  dx:-1,dy:0,  ang:180},
  {name:'UL', dx:-1,dy:-1, ang:-135},
];

/* ------------------------------------------------------------------ */
/*  Deterministic-ish RNG                                             */
/* ------------------------------------------------------------------ */
let seed = (Date.now() ^ 0x9e3779b9) >>> 0;
function rnd(){ seed ^= seed<<13; seed^=seed>>>17; seed^=seed<<5; seed>>>=0; return seed/4294967296; }
const rint = (a,b)=> a + Math.floor(rnd()*(b-a+1));
const chance = p => rnd() < p;

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */
let grid   = new Uint8Array(COLS*ROWS);
let integ  = new Float32Array(COLS*ROWS);   // dirt integrity (hp)
let water  = new Float32Array(COLS*ROWS);
let water2 = new Float32Array(COLS*ROWS);
let gas    = new Float32Array(COLS*ROWS);
let gas2   = new Float32Array(COLS*ROWS);
let dust   = new Float32Array(COLS*ROWS);   // freshly-dug look, decays
let seen   = new Uint8Array(COLS*ROWS);     // fog-of-war: hazards hidden till dug near

let player, rodents, particles, spawnPoints;
let oxygen, health, running, ended, startDepth, best;
let sprayDir = null;      // active DIRS entry or null
let sprayFromKey = false; // arrow-key spray latch
let shakeT = 0;

const isSolid = t => t===DIRT || t===ROCK || t===CLOG || t===BEDROCK;

/* ------------------------------------------------------------------ */
/*  Level generation                                                  */
/* ------------------------------------------------------------------ */
function carveDisc(cx, cy, r, type){
  const r2 = r*r;
  for(let y=Math.floor(cy-r); y<=cy+r; y++)
    for(let x=Math.floor(cx-r); x<=cx+r; x++){
      if(x<0||x>=COLS||y<0||y>=ROWS) continue;
      const dx=x-cx, dy=y-cy;
      if(dx*dx+dy*dy<=r2 && grid[IDX(x,y)]!==BEDROCK) grid[IDX(x,y)]=type;
    }
}

function generate(){
  grid.fill(DIRT); integ.fill(0); water.fill(0); gas.fill(0); dust.fill(0); seen.fill(0);
  rodents=[]; particles=[]; spawnPoints=[];

  // dirt integrity varies a touch for organic erosion timing
  for(let i=0;i<grid.length;i++) integ[i]=1 + rnd()*0.35;

  // sky band
  for(let y=0;y<SURFACE_ROWS;y++)
    for(let x=0;x<COLS;x++) grid[IDX(x,y)]=SKY;
  // a lip of dirt just under the sky so you must break through
  for(let x=0;x<COLS;x++) grid[IDX(x,SURFACE_ROWS)]=DIRT;

  // hard floor
  for(let x=0;x<COLS;x++){ grid[IDX(x,ROWS-1)]=BEDROCK; grid[IDX(x,ROWS-2)]=BEDROCK; }
  // side walls of bedrock so water can't leak past edges awkwardly
  for(let y=0;y<ROWS;y++){ grid[IDX(0,y)]=BEDROCK; grid[IDX(COLS-1,y)]=BEDROCK; }

  // starting pocket near the bottom — kept narrow so you can brace & climb out
  const startX = COLS>>1, startY = ROWS-6;
  carveDisc(startX, startY, 1.8, AIR);
  carveDisc(startX, startY-1, 1.6, AIR);
  // solid ledge to stand on
  for(let x=startX-3;x<=startX+3;x++){ if(x>0&&x<COLS-1){ grid[IDX(x,startY+2)]=DIRT; integ[IDX(x,startY+2)]=1.6; } }

  // scatter rock clusters (kept sparse enough to always leave a diggable route up)
  const rocks = 16;
  for(let k=0;k<rocks;k++){
    const rx=rint(3,COLS-4), ry=rint(SURFACE_ROWS+3, ROWS-6);
    const rr=1+rnd()*1.5;
    carveDisc(rx,ry,rr,ROCK);
  }

  // hidden cavities — pockets of air walled inside dirt, some hazardous
  const cavities = 26;
  for(let k=0;k<cavities;k++){
    const cx=rint(4,COLS-5), cy=rint(SURFACE_ROWS+4, ROWS-8);
    const cr=1.4+rnd()*2.4;
    carveDisc(cx,cy,cr,AIR);
    const roll=rnd();
    if(roll<0.30){                       // gas pocket
      const r2=cr*cr;
      for(let y=Math.floor(cy-cr);y<=cy+cr;y++)
        for(let x=Math.floor(cx-cr);x<=cx+cr;x++){
          if(x<1||x>=COLS-1||y<1||y>=ROWS-2) continue;
          const dx=x-cx,dy=y-cy;
          if(dx*dx+dy*dy<=r2 && grid[IDX(x,y)]===AIR) gas[IDX(x,y)]=0.9;
        }
    } else if(roll<0.52){                 // rodent nest
      spawnPoints.push({x:cx, y:cy, used:false});
    } else if(roll<0.66){                 // buried drain (good — sinks water)
      const dy2=Math.min(ROWS-3, Math.round(cy+cr));
      grid[IDX(cx,dy2)]=DRAIN;
    } else if(roll<0.74){                 // clogged drain (bad)
      const dy2=Math.min(ROWS-3, Math.round(cy+cr));
      grid[IDX(cx,dy2)]=CLOG;
    }
  }

  // player
  player = {
    x:startX-P_W/2, y:startY-P_H, vx:0, vy:0,
    onGround:false, inWater:false, face:1, wet:0,
  };
  oxygen=1; health=1; running=true; ended=false; sprayDir=null; sprayFromKey=false;
  startDepth = depthMeters();

  // reveal the sky band and the starting pocket; the rest grows as you dig
  for(let y=0;y<=SURFACE_ROWS;y++) for(let x=0;x<COLS;x++) seen[IDX(x,y)]=1;
  for(let y=startY-4;y<=startY+3;y++) for(let x=startX-4;x<=startX+4;x++)
    if(x>0&&x<COLS-1&&y>0&&y<ROWS-1) seen[IDX(x,y)]=1;
}

// Fog reveal spreads one ring per tick through open (non-solid) space, so
// breaking a dirt wall lets light bleed into the cavity behind it.
function propagateReveal(){
  for(let y=0;y<ROWS;y++){
    for(let x=1;x<COLS-1;x++){
      const i=IDX(x,y);
      if(!seen[i] || isSolid(grid[i])) continue;
      if(y>0)      seen[i-COLS]=1;
      if(y<ROWS-1) seen[i+COLS]=1;
      seen[i-1]=1; seen[i+1]=1;
      if(y>0){ seen[i-COLS-1]=1; seen[i-COLS+1]=1; }
      if(y<ROWS-1){ seen[i+COLS-1]=1; seen[i+COLS+1]=1; }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Water cellular automaton (mass model)                             */
/* ------------------------------------------------------------------ */
function stableState(total){
  if(total<=1) return 1;
  if(total < 2*MAX_MASS+MAX_COMPRESS) return (MAX_MASS*MAX_MASS+total*MAX_COMPRESS)/(MAX_MASS+MAX_COMPRESS);
  return (total+MAX_COMPRESS)/2;
}
function simWater(){
  water2.set(water);
  for(let y=0;y<ROWS;y++){
    for(let x=1;x<COLS-1;x++){
      const i=IDX(x,y);
      const t=grid[i];
      if(isSolid(t)){ water2[i]=0; continue; }
      let remaining = water[i];
      if(t===DRAIN){                      // open drain devours water fast
        water2[i] -= remaining*0.5;
        remaining *= 0.5;
        if(remaining<=0) continue;
      }
      if(remaining<=0) continue;

      // down
      if(y+1<ROWS){
        const b=IDX(x,y+1);
        if(!isSolid(grid[b])){
          let f=stableState(remaining+water[b])-water[b];
          if(f>MIN_FLOW) f*=0.5;
          f=Math.max(0,Math.min(f, Math.min(MAX_SPEED,remaining)));
          water2[i]-=f; water2[b]+=f; remaining-=f;
        }
      }
      if(remaining<=0) continue;
      // left
      {
        const l=IDX(x-1,y);
        if(!isSolid(grid[l])){
          let f=(water[i]-water[l])/4;
          if(f>MIN_FLOW) f*=0.5;
          f=Math.max(0,Math.min(f,remaining));
          water2[i]-=f; water2[l]+=f; remaining-=f;
        }
      }
      if(remaining<=0) continue;
      // right
      {
        const r=IDX(x+1,y);
        if(!isSolid(grid[r])){
          let f=(water[i]-water[r])/4;
          if(f>MIN_FLOW) f*=0.5;
          f=Math.max(0,Math.min(f,remaining));
          water2[i]-=f; water2[r]+=f; remaining-=f;
        }
      }
      if(remaining<=0) continue;
      // up (pressure)
      if(y-1>=0){
        const u=IDX(x,y-1);
        if(!isSolid(grid[u])){
          let f=remaining-stableState(remaining+water[u]);
          if(f>MIN_FLOW) f*=0.5;
          f=Math.max(0,Math.min(f, Math.min(MAX_SPEED,remaining)));
          water2[i]-=f; water2[u]+=f; remaining-=f;
        }
      }
    }
  }
  // swap + porous-ground seep. Seep is a small *fraction* of each cell's mass,
  // so an actively-sprayed column fills faster than it drains (buoyant elevator),
  // while abandoned puddles slowly recede instead of filling the world forever.
  const tmp=water; water=water2; water2=tmp;
  const seep=1 - SEEP*FIXED;
  for(let i=0;i<water.length;i++){
    if(water[i]<=0){ water[i]=0; continue; }
    water[i]*=seep;
    if(water[i]<0.012) water[i]=0;
  }
}

/* ------------------------------------------------------------------ */
/*  Gas: rises, spreads, dissipates near sky, killed by water         */
/* ------------------------------------------------------------------ */
function simGas(){
  gas2.fill(0);
  for(let y=1;y<ROWS-1;y++){
    for(let x=1;x<COLS-1;x++){
      const i=IDX(x,y);
      let g=gas[i];
      if(g<=0.004) continue;
      if(isSolid(grid[i])){ continue; }
      if(water[i]>0.25){ g*=0.90; }                 // water pushes gas out
      if(grid[i]===SKY){ g*=0.80; }                 // vents at surface
      // buoyant rise + light lateral diffusion
      const up=IDX(x,y-1);
      let toUp = (!isSolid(grid[up])) ? g*0.55 : 0;
      let stay = g - toUp;
      // diffuse the staying part sideways a bit
      const l=IDX(x-1,y), r=IDX(x+1,y);
      let toL=0,toR=0;
      if(!isSolid(grid[l])) toL=stay*0.12;
      if(!isSolid(grid[r])) toR=stay*0.12;
      stay-=toL+toR;
      gas2[i]+=stay*0.985;                          // slow global decay
      if(toUp) gas2[up]+=toUp;
      if(toL) gas2[l]+=toL;
      if(toR) gas2[r]+=toR;
    }
  }
  const tmp=gas; gas=gas2; gas2=tmp;
}

/* ------------------------------------------------------------------ */
/*  Hose spray + erosion                                              */
/* ------------------------------------------------------------------ */
function nozzle(){
  return { x: player.x + P_W/2, y: player.y + 0.5 }; // upper chest
}
function erodeAt(cx, cy){
  const r=BRUSH, r2=r*r;
  let dugAny=false;
  for(let y=Math.floor(cy-r);y<=cy+r;y++)
    for(let x=Math.floor(cx-r);x<=cx+r;x++){
      if(x<1||x>=COLS-1||y<1||y>=ROWS-1) continue;
      const dx=x-cx,dy=y-cy; if(dx*dx+dy*dy>r2) continue;
      const i=IDX(x,y);
      if(grid[i]===DIRT){
        integ[i]-=ERODE_RATE*FIXED*(1-Math.min(0.8,(dx*dx+dy*dy)/r2)*0.5);
        dust[i]=Math.min(1,dust[i]+0.5);
        if(integ[i]<=0){ grid[i]=AIR; dust[i]=1; seen[i]=1; dugAny=true; }
      }
    }
  return dugAny;
}
function doSpray(){
  const dir = sprayDir;
  if(!dir || !running) return;
  player.face = dir.dx!==0 ? Math.sign(dir.dx) : player.face;
  const n=nozzle();
  const len=Math.hypot(dir.dx,dir.dy);
  const ux=dir.dx/len, uy=dir.dy/len;
  let hitSolid=false, tip=n;
  for(let s=0.6; s<=STREAM_LEN; s+=0.5){
    const px=n.x+ux*s, py=n.y+uy*s;
    const gx=Math.floor(px), gy=Math.floor(py);
    if(gx<1||gx>=COLS-1||gy<1||gy>=ROWS-1){ hitSolid=true; break; }
    const t=grid[IDX(gx,gy)];
    tip={x:px,y:py};
    if(t===ROCK||t===CLOG||t===BEDROCK){ hitSolid=true; break; }
    if(t===DIRT){
      erodeAt(px,py);
      // pool a little water right where we're washing
      water[IDX(gx,gy)] = Math.min(1.4, water[IDX(gx,gy)] + SPRAY_WATER*FIXED*0.4);
      hitSolid=true; break;
    } else {
      // open space: inject flowing water
      water[IDX(gx,gy)] = Math.min(1.6, water[IDX(gx,gy)] + SPRAY_WATER*FIXED);
    }
  }
  // spray droplet particles for feel
  for(let k=0;k<2;k++){
    const spread=(rnd()-0.5)*0.5;
    particles.push({
      x:n.x, y:n.y,
      vx:(ux+spread)*(16+rnd()*10), vy:(uy+spread)*(16+rnd()*10),
      life:0.25+rnd()*0.25, kind:'drop'
    });
  }
  if(hitSolid){
    const t=tip;
    for(let k=0;k<3;k++)
      particles.push({x:t.x,y:t.y,vx:(rnd()-0.5)*10,vy:(rnd()-0.5)*10-4,life:0.2+rnd()*0.3,kind:'splash'});
  }
}

/* ------------------------------------------------------------------ */
/*  Player physics                                                    */
/* ------------------------------------------------------------------ */
function solidAt(x,y){
  if(x<0||x>=COLS||y<0||y>=ROWS) return true;
  return isSolid(grid[IDX(x|0,y|0)]);
}
function boxHitsSolid(px,py){
  const x0=Math.floor(px), x1=Math.floor(px+P_W-1e-4);
  const y0=Math.floor(py), y1=Math.floor(py+P_H-1e-4);
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) if(solidAt(x,y)) return true;
  return false;
}
function sampleWaterBox(px,py){
  const x0=Math.floor(px), x1=Math.floor(px+P_W-1e-4);
  const y0=Math.floor(py), y1=Math.floor(py+P_H-1e-4);
  let sum=0,n=0;
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
    if(x<0||x>=COLS||y<0||y>=ROWS) continue;
    sum+=water[IDX(x,y)]; n++;
  }
  return n? sum/n : 0;
}
function gasAtHead(){
  const x0=Math.floor(player.x), x1=Math.floor(player.x+P_W-1e-4);
  const y=Math.floor(player.y);
  let g=0;
  for(let x=x0;x<=x1;x++) if(x>=0&&x<COLS) g=Math.max(g,gas[IDX(x,y)]);
  return g;
}

// is the player braced inside the tunnel network (something solid to grip)?
function nearWall(){
  const cx=player.x+P_W/2, cy=player.y+P_H/2;
  const pts=[[-1.5,-0.6],[1.5,-0.6],[-1.5,0.6],[1.5,0.6],[0,-1.7],[-1.2,-1.5],[1.2,-1.5]];
  for(const [ox,oy] of pts) if(solidAt(cx+ox, cy+oy)) return true;
  return false;
}
let moveDir=0, wantJump=false;
function updatePlayer(){
  const submerge = sampleWaterBox(player.x,player.y);   // 0..~1
  player.inWater = submerge>0.15;
  player.wet = Math.max(player.wet*0.96, player.inWater?1:0);

  // horizontal
  const accelAir = player.inWater? MOVE*0.7 : MOVE;
  player.vx = moveDir*accelAir;

  // Tunnel-climb: holding jump while braced inside the tunnel network (solid
  // nearby) hauls you steadily upward — the main way to gain height. In wide-open
  // caverns there's nothing to brace on, so you're back to gravity + a real jump.
  const climbing = wantJump && !player.onGround && nearWall();

  // vertical forces
  if(climbing){
    player.vy = -CLIMB;
  } else if(player.inWater){
    // buoyancy: rise faster the more submerged; damped by drag
    player.vy -= SUBMERGE_FLOAT*submerge*FIXED;
    player.vy += GRAV*FIXED;
    player.vy *= Math.max(0, 1 - WATER_DRAG*FIXED);
    if(wantJump) player.vy -= 20*FIXED; // kick to swim up
  } else {
    player.vy += GRAV*FIXED;
  }
  if(player.vy>MAXFALL) player.vy=MAXFALL;

  // jump off ground
  if(wantJump && player.onGround && !player.inWater){
    player.vy=-JUMP; player.onGround=false;
  }

  // integrate X (with 1-cell auto-mantle so dug staircases climb smoothly)
  let nx=player.x + player.vx*FIXED;
  if(boxHitsSolid(nx,player.y)){
    if((player.onGround||player.inWater) &&
       !boxHitsSolid(nx, player.y-1.05) && !boxHitsSolid(player.x, player.y-1.05)){
      player.y-=1.0; player.x=nx;                 // mantle up onto the step
    } else {
      const dir=Math.sign(player.vx)||player.face;
      while(!boxHitsSolid(player.x+dir*0.02, player.y) && Math.abs(player.x-nx)>0.02){
        player.x+=dir*0.02;
      }
      player.vx=0;
    }
  } else player.x=nx;

  // integrate Y
  player.onGround=false;
  let ny=player.y + player.vy*FIXED;
  if(boxHitsSolid(player.x,ny)){
    const dir=Math.sign(player.vy);
    while(!boxHitsSolid(player.x, player.y+dir*0.02) && Math.abs(player.y-ny)>0.02){
      player.y+=dir*0.02;
    }
    if(dir>0) player.onGround=true;
    player.vy=0;
  } else player.y=ny;

  // clamp to world
  player.x=Math.max(1,Math.min(COLS-1-P_W,player.x));
  player.y=Math.max(0,Math.min(ROWS-1-P_H,player.y));

  // ---- vitals ----
  const headWater = sampleWaterBox(player.x, player.y+0.1) ;
  const headSubmerged = water[IDX(Math.floor(player.x+P_W/2), Math.floor(player.y))]>0.45;
  if(headSubmerged){
    oxygen -= 0.09*FIXED;
    if(oxygen<0){ oxygen=0; health -= 0.22*FIXED; damageFx(); }
  } else {
    oxygen = Math.min(1, oxygen + 0.34*FIXED);
  }
  const g=gasAtHead();
  if(g>0.25){ health -= g*0.30*FIXED; damageFx(); }

  if(health<=0){ health=0; lose("You were overcome."); }
  if(player.y<=SURFACE_ROWS-1) win();
}
let dmgCooldown=0;
function damageFx(){ if(dmgCooldown<=0){ shakeT=0.18; dmgCooldown=0.25; } }

/* ------------------------------------------------------------------ */
/*  Rodents                                                           */
/* ------------------------------------------------------------------ */
function spawnRodents(){
  for(const sp of spawnPoints){
    if(sp.used) continue;
    // spawn once the nest has been dug open (revealed) and is air
    if(seen[IDX(sp.x|0, sp.y|0)] && grid[IDX(sp.x|0, sp.y|0)]===AIR){
      sp.used=true;
      rodents.push({x:sp.x, y:sp.y, vx:0, vy:0, onGround:false, alive:true, hurt:0});
    }
  }
}
function updateRodents(){
  for(const r of rodents){
    if(!r.alive) continue;
    // gravity
    r.vy+=GRAV*FIXED; if(r.vy>MAXFALL) r.vy=MAXFALL;
    // drown / wash: heavy water pushes them and can send them down drains
    const w=water[IDX(r.x|0,r.y|0)];
    if(w>0.4){ r.vy += 4*FIXED; r.hurt+=FIXED; if(r.hurt>3){ r.alive=false; continue; } }
    // chase player horizontally if roughly level & close
    const dx=(player.x+P_W/2)-r.x, dy=(player.y+P_H/2)-r.y;
    if(Math.abs(dx)<12 && Math.abs(dy)<6){
      const dir=Math.sign(dx);
      if(!solidAt(r.x+dir*0.6, r.y+0.4)) r.vx=dir*6.5;
      else { r.vx=0; if(r.onGround && !solidAt(r.x+dir*0.6,r.y-0.6)){ r.vy=-11; } } // hop obstacles
    } else r.vx*=0.8;

    // integrate x
    let nx=r.x+r.vx*FIXED;
    if(!solidAt(nx,r.y)&&!solidAt(nx,r.y-0.6)) r.x=nx; else r.vx=0;
    // integrate y
    r.onGround=false;
    let ny=r.y+r.vy*FIXED;
    if(solidAt(r.x,ny)){ if(r.vy>0) r.onGround=true; r.vy=0; }
    else r.y=ny;

    // fell into a drain -> clog it (raises the flood stakes) and die
    const gi=IDX(r.x|0, r.y|0);
    if(grid[gi]===DRAIN){ grid[gi]=CLOG; r.alive=false; shakeT=0.15; continue; }

    // touch player -> bite
    if(Math.abs(dx)<P_W*0.7 && Math.abs(dy)<P_H*0.7){
      health -= 0.5*FIXED; damageFx();
    }
    if(r.y>ROWS-2) r.alive=false;
  }
  rodents = rodents.filter(r=>r.alive);
}

/* ------------------------------------------------------------------ */
/*  Particles                                                         */
/* ------------------------------------------------------------------ */
function updateParticles(){
  for(const p of particles){
    p.life-=FIXED;
    p.vy+=GRAV*FIXED*0.6;
    p.x+=p.vx*FIXED; p.y+=p.vy*FIXED;
    // die in dirt/water
    const gx=p.x|0, gy=p.y|0;
    if(gx>0&&gx<COLS&&gy>0&&gy<ROWS){
      if(isSolid(grid[IDX(gx,gy)])||water[IDX(gx,gy)]>0.3) p.life=0;
    }
  }
  particles = particles.filter(p=>p.life>0);
  if(particles.length>420) particles.splice(0, particles.length-420);
}

/* ------------------------------------------------------------------ */
/*  Depth / win / lose                                                */
/* ------------------------------------------------------------------ */
function depthMeters(){
  const d = (player.y - SURFACE_ROWS);
  return Math.max(0, Math.round(d*0.5));
}
function win(){
  if(ended) return; ended=true; running=false;
  showResult(true, "You broke the surface and gulped the sky.");
}
function lose(msg){
  if(ended) return; ended=true; running=false;
  showResult(false, msg);
}

/* ------------------------------------------------------------------ */
/*  Fixed-timestep loop                                               */
/* ------------------------------------------------------------------ */
const FIXED = 1/60;
let acc=0, last=0, waterTick=0;
function frame(ts){
  if(!last) last=ts;
  let dt=(ts-last)/1000; last=ts;
  if(dt>0.1) dt=0.1;
  acc+=dt;
  while(acc>=FIXED){
    step();
    acc-=FIXED;
  }
  render();
  requestAnimationFrame(frame);
}
function step(){
  if(dmgCooldown>0) dmgCooldown-=FIXED;
  if(shakeT>0) shakeT-=FIXED;
  if(running){
    // decay dust
    for(let i=0;i<dust.length;i++) if(dust[i]>0) dust[i]-=FIXED*0.8;
    doSpray();
    propagateReveal();
    spawnRodents();
    updatePlayer();
    updateRodents();
    simWater();
    // gas every other tick (cheaper, looks fine)
    waterTick^=1; if(waterTick) simGas();
    updateParticles();
    updateHUD();
  }
}

/* ------------------------------------------------------------------ */
/*  Rendering                                                         */
/* ------------------------------------------------------------------ */
const cvs=document.getElementById('game');
const ctx=cvs.getContext('2d');
let CELL=8, viewW=0, viewH=0;
let time=0;

function resize(){
  const availW=window.innerWidth, availH=window.innerHeight;
  CELL=Math.max(4, Math.floor(Math.min(availW/COLS, availH/ROWS)));
  viewW=CELL*COLS; viewH=CELL*ROWS;
  cvs.width=viewW; cvs.height=viewH;
  cvs.style.width=viewW+'px'; cvs.style.height=viewH+'px';
  layoutHosePad();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// dirt colour with a bit of vertical banding for a stratified look
function dirtColour(x,y,i){
  const shade = ((x*7+y*13) & 3);
  const band = Math.floor(y/6)%3;
  const base = band===0? [96,64,38] : band===1? [86,57,33] : [104,72,44];
  const s = shade*6;
  const d = dust[i]>0? dust[i]*40 : 0;
  return `rgb(${base[0]-s+d},${base[1]-s+d*0.7},${base[2]-s+d*0.5})`;
}

function render(){
  time+=1/60;
  ctx.save();
  if(shakeT>0){
    const m=shakeT*CELL*1.6;
    ctx.translate((rnd()-0.5)*m,(rnd()-0.5)*m);
  }
  // sky gradient
  const sg=ctx.createLinearGradient(0,0,0,viewH);
  sg.addColorStop(0,'#8fd0ff'); sg.addColorStop(SURFACE_ROWS/ROWS,'#bfe6ff');
  sg.addColorStop(SURFACE_ROWS/ROWS+0.001,'#2a1c0e'); sg.addColorStop(1,'#0c0803');
  ctx.fillStyle=sg; ctx.fillRect(0,0,viewW,viewH);

  // sun in the sky band
  ctx.fillStyle='rgba(255,247,210,.9)';
  ctx.beginPath(); ctx.arc(viewW*0.78, CELL*2, CELL*1.6, 0, Math.PI*2); ctx.fill();

  // terrain
  for(let y=SURFACE_ROWS-0;y<ROWS;y++){
    for(let x=1;x<COLS-1;x++){
      const i=IDX(x,y);
      const t = seen[i] ? grid[i] : DIRT;   // fog: undug cells read as solid dirt
      const px=x*CELL, py=y*CELL;
      if(t===DIRT){
        ctx.fillStyle=dirtColour(x,y,i);
        ctx.fillRect(px,py,CELL+1,CELL+1);
      } else if(t===ROCK){
        ctx.fillStyle= ((x+y)&1)? '#5b5f68':'#4c505a';
        ctx.fillRect(px,py,CELL+1,CELL+1);
        ctx.fillStyle='rgba(255,255,255,.08)';
        ctx.fillRect(px,py,CELL,CELL*0.35);
      } else if(t===BEDROCK){
        ctx.fillStyle= ((x+y)&1)? '#2b2118':'#241b12';
        ctx.fillRect(px,py,CELL+1,CELL+1);
      } else if(t===DRAIN){
        ctx.fillStyle='#141414'; ctx.fillRect(px,py,CELL+1,CELL+1);
        ctx.strokeStyle='#3a3a3a'; ctx.lineWidth=1;
        for(let g=1;g<CELL;g+=3){ ctx.beginPath(); ctx.moveTo(px+g,py); ctx.lineTo(px+g,py+CELL); ctx.stroke(); }
      } else if(t===CLOG){
        ctx.fillStyle='#3a2c1c'; ctx.fillRect(px,py,CELL+1,CELL+1);
        ctx.fillStyle='#6b5334';
        ctx.fillRect(px+CELL*0.2,py+CELL*0.2,CELL*0.6,CELL*0.6);
        ctx.strokeStyle='#221a10'; ctx.strokeRect(px+CELL*0.2,py+CELL*0.2,CELL*0.6,CELL*0.6);
      }
    }
  }

  // gas
  for(let y=SURFACE_ROWS;y<ROWS;y++)for(let x=1;x<COLS-1;x++){
    const g=gas[IDX(x,y)];
    if(g>0.03 && seen[IDX(x,y)]){
      const a=Math.min(0.6,g*0.7);
      const wob=Math.sin(time*3+x*0.6+y*0.4)*0.15;
      ctx.fillStyle=`rgba(150,220,90,${a})`;
      ctx.fillRect(x*CELL, y*CELL+wob*CELL, CELL+1, CELL+1);
    }
  }

  // water — depth shaded, animated surface highlight
  for(let y=SURFACE_ROWS;y<ROWS;y++){
    for(let x=1;x<COLS-1;x++){
      const i=IDX(x,y); const w=water[i];
      if(w<DRAWN_MIN || isSolid(grid[i]) || !seen[i]) continue;
      const px=x*CELL, py=y*CELL;
      const fill=Math.min(1,w);
      const above=water[IDX(x,y-1)]||0;
      const isSurf = above<DRAWN_MIN && grid[IDX(x,y-1)]!==undefined && !isSolid(grid[IDX(x,y-1)]);
      // body
      const depthShade=Math.min(1, w*0.5 + y/ROWS*0.4);
      const r=20+depthShade*10, gc=90-depthShade*30, b=150+depthShade*40;
      let h=CELL;
      if(isSurf && w<0.96){ h=CELL*Math.max(0.25,fill); }
      ctx.fillStyle=`rgba(${r|0},${gc|0},${b|0},${0.72+0.2*fill})`;
      ctx.fillRect(px, py+(CELL-h), CELL+1, h+1);
      // animated caustic shimmer
      if(isSurf){
        const shimmer=(Math.sin(time*4 + x*0.9) *0.5+0.5);
        ctx.fillStyle=`rgba(190,240,255,${0.25+0.35*shimmer})`;
        ctx.fillRect(px, py+(CELL-h), CELL+1, Math.max(1,CELL*0.18));
      }
    }
  }

  // particles
  for(const p of particles){
    const a=Math.max(0,Math.min(1,p.life*3));
    ctx.fillStyle = p.kind==='splash'? `rgba(210,245,255,${a})` : `rgba(120,205,255,${a})`;
    const s=Math.max(1,CELL*0.28);
    ctx.fillRect(p.x*CELL-s/2, p.y*CELL-s/2, s, s);
  }

  // rodents
  for(const r of rodents){
    const px=r.x*CELL, py=r.y*CELL;
    ctx.fillStyle='#6b6f77';
    ctx.fillRect(px-CELL*0.7, py-CELL*0.5, CELL*1.4, CELL*0.9);
    ctx.fillStyle='#54585f';
    ctx.fillRect(px + (player.x>r.x?0.4:-1.1)*CELL, py-CELL*0.55, CELL*0.6, CELL*0.55); // head
    ctx.fillStyle='#ff4646';
    ctx.fillRect(px + (player.x>r.x?0.75:-0.95)*CELL, py-CELL*0.4, CELL*0.16, CELL*0.16); // eye
    // tail
    ctx.strokeStyle='#6b6f77'; ctx.lineWidth=Math.max(1,CELL*0.15);
    ctx.beginPath(); ctx.moveTo(px+(player.x>r.x?-0.7:0.7)*CELL, py);
    ctx.lineTo(px+(player.x>r.x?-1.4:1.4)*CELL, py+Math.sin(time*10)*CELL*0.3); ctx.stroke();
  }

  drawPlayer();

  // vignette down deep
  const vg=ctx.createRadialGradient(viewW/2,player.y*CELL,CELL*4, viewW/2,player.y*CELL, viewH*0.6);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.45)');
  ctx.fillStyle=vg; ctx.fillRect(0,0,viewW,viewH);

  ctx.restore();
}

function drawPlayer(){
  const px=player.x*CELL, py=player.y*CELL, w=P_W*CELL, h=P_H*CELL;
  // body (diver-ish)
  ctx.fillStyle= player.wet>0.3? '#ffd23f':'#ffb830';
  roundRect(px, py+h*0.32, w, h*0.68, CELL*0.25); ctx.fill();
  // helmet
  ctx.fillStyle='#ffe08a';
  ctx.beginPath(); ctx.arc(px+w/2, py+h*0.28, w*0.5, 0, Math.PI*2); ctx.fill();
  // visor
  ctx.fillStyle='#123b52';
  ctx.beginPath(); ctx.arc(px+w/2+player.face*w*0.12, py+h*0.28, w*0.26, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(180,240,255,.7)';
  ctx.beginPath(); ctx.arc(px+w/2+player.face*w*0.18, py+h*0.22, w*0.09, 0, Math.PI*2); ctx.fill();

  // hose held toward current aim
  const n=nozzle();
  const aim = sprayDir || DIRS[player.face>0?2:6];
  const len=Math.hypot(aim.dx,aim.dy);
  const ex=n.x+aim.dx/len*1.4, ey=n.y+aim.dy/len*1.4;
  ctx.strokeStyle='#222'; ctx.lineWidth=Math.max(2,CELL*0.35); ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(px+w/2, py+h*0.5); ctx.lineTo(ex*CELL, ey*CELL); ctx.stroke();
  ctx.strokeStyle='#39c6ff'; ctx.lineWidth=Math.max(1,CELL*0.16);
  ctx.beginPath(); ctx.moveTo(px+w/2, py+h*0.5); ctx.lineTo(ex*CELL, ey*CELL); ctx.stroke();

  // oxygen bubbles when submerged
  if(player.inWater && (time*8|0)%3===0){
    particles.push({x:player.x+P_W/2+(rnd()-0.5), y:player.y, vx:(rnd()-0.5)*2, vy:-6-rnd()*4, life:0.6, kind:'drop'});
  }
}
function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}

/* ------------------------------------------------------------------ */
/*  HUD                                                               */
/* ------------------------------------------------------------------ */
const oxyFill=document.getElementById('oxyFill');
const hpFill=document.getElementById('hpFill');
const depthReadout=document.getElementById('depthReadout');
function updateHUD(){
  oxyFill.style.width=(oxygen*100).toFixed(0)+'%';
  hpFill.style.width=(health*100).toFixed(0)+'%';
  depthReadout.textContent = depthMeters()+' m deep';
}

/* ------------------------------------------------------------------ */
/*  Overlays                                                          */
/* ------------------------------------------------------------------ */
const overlay=document.getElementById('overlay');
function showResult(won, msg){
  overlay.classList.remove('hidden');
  overlay.innerHTML=`<div class="panel">
    <h1 class="result-title ${won?'win':'lose'}">${won?'SURFACED!':'FLOODED'}</h1>
    <p class="result-sub">${msg}<br>Reached the surface from <b>${startDepth} m</b> down.</p>
    <button class="restart" id="againBtn">${won?'DIVE AGAIN ▶':'TRY AGAIN ▶'}</button>
  </div>`;
  document.getElementById('againBtn').addEventListener('click', startGame, {passive:true});
}
function startGame(){
  overlay.classList.add('hidden');
  seed=(seed*1664525+1013904223)>>>0;
  generate(); updateHUD();
}

/* ------------------------------------------------------------------ */
/*  Input — touch pads                                                */
/* ------------------------------------------------------------------ */
function bindHold(el, on, off){
  const start=e=>{ e.preventDefault(); el.classList.add('on'); on(); };
  const end=e=>{ e.preventDefault(); el.classList.remove('on'); off(); };
  el.addEventListener('touchstart',start,{passive:false});
  el.addEventListener('touchend',end,{passive:false});
  el.addEventListener('touchcancel',end,{passive:false});
  el.addEventListener('mousedown',start);
  window.addEventListener('mouseup',end);
  el.addEventListener('mouseleave',e=>{ if(el.classList.contains('on')) end(e); });
}

// movement buttons
document.querySelectorAll('#movePad .btn').forEach(el=>{
  const m=el.dataset.move;
  if(m==='left')  bindHold(el, ()=>moveDir=-1, ()=>{ if(moveDir<0) moveDir=0; });
  if(m==='right') bindHold(el, ()=>moveDir= 1, ()=>{ if(moveDir>0) moveDir=0; });
  if(m==='jump')  bindHold(el, ()=>wantJump=true, ()=>wantJump=false);
});

// 8-direction hose ring — built dynamically
const hoseRing=document.getElementById('hoseRing');
DIRS.forEach((d,idx)=>{
  const b=document.createElement('button');
  b.className='hose-btn'; b.dataset.dir=idx;
  b.textContent = ({U:'↑',UR:'↗',R:'→',DR:'↘',D:'↓',DL:'↙',L:'←',UL:'↖'})[d.name];
  hoseRing.appendChild(b);
  bindHold(b, ()=>{ sprayDir=d; }, ()=>{ if(sprayDir===d && !sprayFromKey) sprayDir=null; });
});
function layoutHosePad(){
  const pad=document.getElementById('hosePad');
  const R=Math.min(pad.clientWidth,pad.clientHeight)/2 - 26;
  const cx=pad.clientWidth/2, cy=pad.clientHeight/2;
  hoseRing.querySelectorAll('.hose-btn').forEach(b=>{
    const d=DIRS[b.dataset.dir];
    const a=d.ang*Math.PI/180;
    b.style.left=(cx+Math.cos(a)*R)+'px';
    b.style.top =(cy+Math.sin(a)*R)+'px';
  });
}

/* ------------------------------------------------------------------ */
/*  Input — keyboard + mouse (desktop)                                */
/* ------------------------------------------------------------------ */
const keyDirMap={
  'KeyW':'U','KeyE':'UR','KeyD':'R','KeyC':'DR','KeyX':'D','KeyZ':'DL','KeyA':'L','KeyQ':'UL'
};
const held=new Set();
window.addEventListener('keydown',e=>{
  if(e.repeat) return;
  held.add(e.code);
  switch(e.code){
    case 'ArrowLeft': moveDir=-1; break;
    case 'ArrowRight': moveDir=1; break;
    case 'ArrowUp': case 'Space': wantJump=true; break;
  }
  // aim with number keys / IJKL style via ArrowKeys+shift? use QWE/ASD/ZXC ring:
  refreshKeyAim();
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
},{passive:false});
window.addEventListener('keyup',e=>{
  held.delete(e.code);
  switch(e.code){
    case 'ArrowLeft': if(moveDir<0) moveDir=0; break;
    case 'ArrowRight': if(moveDir>0) moveDir=0; break;
    case 'ArrowUp': case 'Space': wantJump=false; break;
  }
  refreshKeyAim();
});
function refreshKeyAim(){
  // QWE / A D / ZXC surround-key aiming
  for(const code of Object.keys(keyDirMap)){
    if(held.has(code)){
      const name=keyDirMap[code];
      sprayDir=DIRS.find(d=>d.name===name); sprayFromKey=true; return;
    }
  }
  if(sprayFromKey){ sprayFromKey=false; sprayDir=null; }
}

// mouse aim + hold to spray (desktop convenience)
let mouseDown=false;
cvs.addEventListener('mousedown',e=>{ mouseDown=true; aimMouse(e); });
window.addEventListener('mousemove',e=>{ if(mouseDown) aimMouse(e); });
window.addEventListener('mouseup',()=>{ if(mouseDown){ mouseDown=false; if(!sprayFromKey) sprayDir=null; } });
function aimMouse(e){
  const rect=cvs.getBoundingClientRect();
  const mx=(e.clientX-rect.left)/CELL, my=(e.clientY-rect.top)/CELL;
  const n=nozzle();
  const ang=Math.atan2(my-n.y, mx-n.x)*180/Math.PI;
  // snap to nearest of 8
  let best=DIRS[0], bd=1e9;
  for(const d of DIRS){
    let diff=Math.abs(((d.ang-ang+540)%360)-180);
    if(diff<bd){ bd=diff; best=d; }
  }
  sprayDir=best; sprayFromKey=true; // treat as latched while mouse held
}

/* ------------------------------------------------------------------ */
/*  Boot                                                              */
/* ------------------------------------------------------------------ */
document.getElementById('startBtn').addEventListener('click', startGame, {passive:true});
resize();
generate();          // pre-build so the world is visible behind the menu
updateHUD();
requestAnimationFrame(frame);

})();
