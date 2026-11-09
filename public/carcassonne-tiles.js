// Shared tile geometry: clockwise sides N/E/S/W. Original vector artwork.
(function(root) {
  const rotatePoint = ([x,y], r) => { for(let i=0;i<r;i++) [x,y]=[100-y,x]; return [x,y]; };
  const cap = [[0,0],[100,0],[78,24],[22,24]];
  function cityShape(edges) {
    const r=edges.find(e=>edges.includes((e+1)%4)) ?? edges[0];
    if(edges.length===4) return [[0,0],[100,0],[100,100],[0,100]];
    let points;
    if(edges.length===1) return cap.map(p=>rotatePoint(p,edges[0]));
    if(edges.length===2 && edges.includes((r+1)%4)) points=[[0,0],[100,0],[100,100],[70,68],[32,30]];
    else if(edges.length===2) return [[0,0],[100,0],[65,35],[65,65],[100,100],[0,100],[35,65],[35,35]].map(p=>rotatePoint(p,edges[0]));
    else { const missing=[0,1,2,3].find(e=>!edges.includes(e)); return [[0,0],[100,0],[100,100],[78,76],[22,76],[0,100]].map(p=>rotatePoint(p,(missing+2)%4)); }
    return points.map(p=>rotatePoint(p,r));
  }
  const specs=[
    ['A',2,[],[[2]],true],['B',4,[],[],true],['C',1,[[0,1,2,3]],[],false,1],
    ['D',4,[[0]],[[1,3]]],['E',5,[[0]],[]],['F',2,[[0,2]],[],false,1],['G',1,[[0,2]],[]],
    ['H',3,[[0],[2]],[]],['I',2,[[0],[1]],[]],['J',3,[[0]],[[1,2]]],['K',3,[[0]],[[2,3]]],
    ['L',3,[[0]],[[1],[2],[3]]],['M',2,[[0,1]],[],false,1],['N',3,[[0,1]],[]],
    ['O',2,[[0,1]],[[2,3]],false,1],['P',3,[[0,1]],[[2,3]]],
    ['Q',1,[[0,1,3]],[],false,1],['R',3,[[0,1,3]],[]],
    ['S',2,[[0,1,3]],[[2]],false,1],['T',1,[[0,1,3]],[[2]]],
    ['U',8,[],[[0,2]]],['V',9,[],[[0,1]]],['W',4,[],[[0],[1],[3]]],['X',1,[],[[0],[1],[2],[3]]],
  ];
  const inside=(x,y,poly)=>{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
  const ends=[[50,0],[100,50],[50,100],[0,50]];
  function roadPoints(edges) { return edges.length===1 ? [ends[edges[0]],[50,50]] : [ends[edges[0]],[50,50],ends[edges[1]]]; }
  function dist(x,y,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);}
  const tiles={};
  for(const [id,count,cities,roads,monastery=false,shield=0] of specs){
    const features=[];
    cities.forEach((edges,i)=>features.push({id:'c'+i,type:'city',edges,shield:i===0?shield:0,polygon:cityShape(edges)}));
    roads.forEach((edges,i)=>{
      const points=roadPoints(edges);
      if(cities.length===1 && cities[0].length===2 && roads.length===1) points[1]=[40,60];
      if(cities.length===1 && cities[0].length===3 && roads.length===1) points[1]=[50,76];
      features.push({id:'r'+i,type:'road',edges,points});
    });
    if(monastery)features.push({id:'m',type:'monastery',edges:[],anchor:[50,50]});
    features.forEach(f=>{
      if(f.anchor) return;
      f.anchor=f.type==='city'?rotatePoint([50,14],f.edges[0]):f.edges.length===1?rotatePoint([50,27],f.edges[0]):f.points[0].map(v=>(v+50)/2);
    });
    // Flood the open landscape to derive field connectivity and city adjacency.
    const n=40,grid=Array(n*n).fill(-1);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
      const px=(x+.5)*100/n,py=(y+.5)*100/n;
      if(features.some(f=>f.type==='city'&&inside(px,py,f.polygon)||f.type==='road'&&f.points.slice(1).some((b,i)=>dist(px,py,f.points[i],b)<3)))grid[y*n+x]=-2;
    }
    let group=0;
    for(let i=0;i<grid.length;i++)if(grid[i]===-1){const cells=[i];grid[i]=group;for(let k=0;k<cells.length;k++){const v=cells[k],x=v%n,y=Math.floor(v/n);for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy,j=ny*n+nx;if(nx>=0&&nx<n&&ny>=0&&ny<n&&grid[j]===-1){grid[j]=group;cells.push(j);}}}
      const ports=[];const samples=[[10,0],[30,0],[39,10],[39,30],[30,39],[10,39],[0,30],[0,10]];samples.forEach(([x,y],p)=>{if(grid[y*n+x]===group)ports.push(p)});
      const adjacent=features.filter(f=>f.type==='city'&&cells.some(v=>{const x=(v%n+.5)*2.5,y=(Math.floor(v/n)+.5)*2.5;return [[3,0],[-3,0],[0,3],[0,-3]].some(([dx,dy])=>inside(x+dx,y+dy,f.polygon));})).map(f=>f.id);
      const available=cells.filter(v=>features.every(f=>!f.anchor || Math.hypot((v%n+.5)*2.5-f.anchor[0],(Math.floor(v/n)+.5)*2.5-f.anchor[1])>=22));
      const candidates=available.length?available:cells;
      const mid=candidates.reduce((best,v)=>Math.hypot(v%n-20,Math.floor(v/n)-20)<Math.hypot(best%n-20,Math.floor(best/n)-20)?v:best,candidates[0]);
      features.push({id:'f'+group,type:'field',edges:[],ports,adjacent,anchor:[(mid%n+.5)*2.5,(Math.floor(mid/n)+.5)*2.5]});group++;
    }
    features.forEach(f=>{if(!f.anchor){if(f.type==='city'){const e=f.edges[0];f.anchor=rotatePoint([50,14],e);}else f.anchor=f.edges.length===1?rotatePoint([50,27],f.edges[0]):f.points[0].map((v,i)=>(v+50)/2);}});
    const edges=[0,1,2,3].map(e=>cities.some(c=>c.includes(e))?'city':roads.some(r=>r.includes(e))?'road':'field');
    tiles[id]={id,count,features,edges,monastery};
  }
  // Placement anchors matched to the PNG artwork in its unrotated orientation.
  // Apply after field generation: visual positions must not change connectivity.
  const artworkAnchors={
    A:{m:[50,39],f0:[75,70]},
    B:{m:[50,39],f0:[75,70]},
    D:{f0:[50,35],f1:[50,75]},
    F:{f0:[85,50],f1:[15,50]},
    G:{f0:[85,50],f1:[15,50]},
    J:{f0:[72,34],f1:[72,78]},
    K:{f0:[72,43],f1:[25,78]},
    L:{f0:[50,33],f1:[25,78],f2:[75,78]},
    M:{f0:[28,72]},
    N:{f0:[28,72]},
    O:{f0:[74,91],f1:[22,78]},
    P:{f0:[74,91],f1:[22,78]},
    U:{f0:[22,55],f1:[78,55]},
    V:{f0:[28,72],f1:[73,28]},
    W:{f0:[25,25],f1:[75,25],f2:[50,80]},
    X:{f0:[25,25],f1:[75,25],f2:[25,75],f3:[75,75]},
  };
  for(const [id,anchors] of Object.entries(artworkAnchors)){
    for(const [featureId,anchor] of Object.entries(anchors)){
      tiles[id].features.find(f=>f.id===featureId).anchor=anchor;
    }
  }
  const api={tiles,rotatePoint};
  if(typeof module!=='undefined')module.exports=api;else root.CarcassonneTiles=api;
})(typeof window!=='undefined'?window:globalThis);
