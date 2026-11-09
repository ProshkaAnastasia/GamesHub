(function(root) {
  // Ports clockwise: north, east, south, west. H = highway, R = railway.
  const pieces = {
    'highway-straight': { label:'Прямая дорога', ports:['H',null,'H',null] },
    'highway-curve': { label:'Поворот дороги', ports:['H','H',null,null] },
    'highway-junction': { label:'Т-образная дорога', ports:['H','H',null,'H'] },
    'railway-straight': { label:'Прямая железная дорога', ports:['R',null,'R',null] },
    'railway-curve': { label:'Поворот железной дороги', ports:['R','R',null,null] },
    'railway-junction': { label:'Т-образная железная дорога', ports:['R','R',null,'R'] },
    'station-straight': { label:'Прямая станция', ports:['H',null,'R',null], station:true },
    'station-curve': { label:'Угловая станция', ports:['H','R',null,null], station:true },
    overpass: { label:'Путепровод', ports:['R','H','R','H'], overpass:true },
    'special-highway': { label:'Перекрёсток дорог', ports:['H','H','H','H'], special:true },
    'special-railway': { label:'Перекрёсток рельсов', ports:['R','R','R','R'], special:true },
    'special-three-highways': { label:'Станция: 3 дороги и рельсы', ports:['H','H','H','R'], station:true,special:true },
    'special-three-railways': { label:'Станция: 3 рельса и дорога', ports:['R','R','R','H'], station:true,special:true },
    'special-station-adjacent': { label:'Станция: соседние дороги и рельсы', ports:['H','H','R','R'], station:true,special:true },
    'special-station-opposite': { label:'Станция: встречные дороги и рельсы', ports:['H','R','H','R'], station:true,special:true },
  };
  const basic = Object.keys(pieces).filter(id=>!pieces[id].special&&!pieces[id].station&&!pieces[id].overpass);
  const transition = ['station-straight','station-straight','station-curve','station-curve','overpass','overpass'];
  const specials = Object.keys(pieces).filter(id=>pieces[id].special);
  const directions = [[0,-1],[1,0],[0,1],[-1,0]];
  const exits = [];
  for(const p of [1,3,5]) {
    const horizontal=p===3?'R':'H',vertical=p===3?'H':'R';
    exits.push({x:p,y:0,side:0,type:horizontal},{x:6,y:p,side:1,type:vertical},
      {x:p,y:6,side:2,type:horizontal},{x:0,y:p,side:3,type:vertical});
  }
  function orient(piece,rotation=0,flipped=false) {
    const spec=pieces[piece];
    if(!spec)return null;
    const transform=side=>((flipped?(4-side)%4:side)+rotation)%4;
    const ports=Array(4).fill(null);
    spec.ports.forEach((type,side)=>{ports[transform(side)]=type;});
    const originalGroups=spec.overpass?[[0,2],[1,3]]:[spec.ports.flatMap((type,side)=>type?[side]:[])];
    return {...spec,ports,groups:originalGroups.map(group=>group.map(transform))};
  }
  function legal(board,piece,x,y,rotation=0,flipped=false) {
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>6||y>6||board[y*7+x])return false;
    if(!Number.isInteger(rotation)||rotation<0||rotation>3||typeof flipped!=='boolean')return false;
    const tile=orient(piece,rotation,flipped);if(!tile)return false;
    let connects=false;
    for(let side=0;side<4;side++){
      const type=tile.ports[side];if(!type)continue;
      const [dx,dy]=directions[side],nx=x+dx,ny=y+dy;
      if(nx<0||ny<0||nx>6||ny>6){
        const exit=exits.find(e=>e.x===x&&e.y===y&&e.side===side);
        if(exit){if(exit.type!==type)return false;connects=true;}
      }else if(board[ny*7+nx]){
        const neighbor=board[ny*7+nx],other=orient(neighbor.piece,neighbor.rotation,neighbor.flipped).ports[(side+2)%4];
        if(other&&other!==type)return false;
        if(other===type)connects=true;
      }
    }
    // A neighbor route may face a blank edge of the new tile: this is an error,
    // not a forbidden road-to-rail join. Both endpoints are scored separately.
    return connects;
  }
  function placements(board,piece) {
    const result=[],seen=new Set();
    for(const flipped of [false,true])for(let rotation=0;rotation<4;rotation++){
      const tile=orient(piece,rotation,flipped);if(!tile)continue;
      const signature=JSON.stringify([tile.ports,tile.groups.map(g=>[...g].sort()).sort()]);
      if(seen.has(signature))continue;seen.add(signature);
      for(let y=0;y<7;y++)for(let x=0;x<7;x++)if(legal(board,piece,x,y,rotation,flipped))result.push({x,y,rotation,flipped});
    }
    return result;
  }
  const api={pieces,basic,transition,specials,directions,exits,orient,legal,placements};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RailroadTiles=api;
})(typeof window!=='undefined'?window:globalThis);
