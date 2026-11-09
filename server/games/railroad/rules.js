const {orient,directions,exits}=require('../../../public/railroad-tiles');
function longestRoute(board,type) {
  const graph=new Map();
  for(let index=0;index<49;index++)if(board[index]){
    const tile=orient(board[index].piece,board[index].rotation,board[index].flipped);
    if(!tile.ports.includes(type))continue;
    const adjacent=[];
    for(let side=0;side<4;side++)if(tile.ports[side]===type){
      const [dx,dy]=directions[side],x=index%7+dx,y=Math.floor(index/7)+dy;
      if(x>=0&&x<7&&y>=0&&y<7&&board[y*7+x]){
        const other=board[y*7+x];if(orient(other.piece,other.rotation,other.flipped).ports[(side+2)%4]===type)adjacent.push(y*7+x);
      }
    }
    graph.set(index,adjacent);
  }
  let best=0;const processed=new Set();
  for(const start of graph.keys()){
    if(processed.has(start))continue;
    const component=[start];processed.add(start);
    for(let i=0;i<component.length;i++)for(const next of graph.get(component[i]))if(!processed.has(next)){processed.add(next);component.push(next);}
    if(component.length<=best)continue;
    const edgeCount=component.reduce((n,id)=>n+graph.get(id).length,0)/2;
    if(edgeCount===component.length-1){
      const farthest=origin=>{const queue=[[origin,1]],seen=new Set([origin]);let far=queue[0];for(let i=0;i<queue.length;i++){const [id,length]=queue[i];if(length>far[1])far=queue[i];for(const next of graph.get(id))if(!seen.has(next)){seen.add(next);queue.push([next,length+1]);}}return far;};
      best=Math.max(best,farthest(farthest(start)[0])[1]);continue;
    }
    const color=id=>(id%7+Math.floor(id/7))%2;
    function dfs(id,visited,length){
      if(length>best)best=length;
      if(best===component.length)return;
      // Exact reachability and checkerboard bound prune branches without
      // approximating the score on cycles or junctions.
      const queue=[id],reachable=new Set([id]);let same=0,opposite=0;
      for(let i=0;i<queue.length;i++){
        const node=queue[i];if(color(node)===color(id))same++;else opposite++;
        for(const next of graph.get(node))if(!reachable.has(next)&&(visited&(1n<<BigInt(next)))===0n){reachable.add(next);queue.push(next);}
      }
      const availableBound=same>opposite?2*opposite+1:2*same;
      if(length-1+availableBound<=best)return;
      for(const next of graph.get(id))if((visited&(1n<<BigInt(next)))===0n)dfs(next,visited|(1n<<BigInt(next)),length+1);
    }
    for(const id of [...component].sort((a,b)=>graph.get(a).length-graph.get(b).length)){
      dfs(id,1n<<BigInt(id),1);if(best===component.length)break;
    }
  }
  return best;
}
function score(board,includeLongest=true){
  const nodes=[],portNode=new Map();let errors=0,center=0;
  for(let index=0;index<49;index++)if(board[index]){
    const x=index%7,y=Math.floor(index/7),tile=orient(board[index].piece,board[index].rotation,board[index].flipped);
    if(x>=2&&x<=4&&y>=2&&y<=4)center++;
    tile.groups.forEach(group=>{const node=nodes.length;nodes.push({edges:new Set(),exits:new Set()});group.forEach(side=>portNode.set(`${index}:${side}`,node));});
    tile.ports.forEach((type,side)=>{
      if(!type)return;const [dx,dy]=directions[side],nx=x+dx,ny=y+dy;
      if(nx<0||nx>6||ny<0||ny>6)return; // Outer edges are not errors.
      const next=board[ny*7+nx];
      if(!next||orient(next.piece,next.rotation,next.flipped).ports[(side+2)%4]!==type)errors++;
    });
  }
  for(let index=0;index<49;index++)if(board[index]){
    const x=index%7,y=Math.floor(index/7),tile=orient(board[index].piece,board[index].rotation,board[index].flipped);
    tile.ports.forEach((type,side)=>{
      if(!type)return;const node=portNode.get(`${index}:${side}`),[dx,dy]=directions[side],nx=x+dx,ny=y+dy;
      if(nx<0||nx>6||ny<0||ny>6){const exit=exits.findIndex(e=>e.x===x&&e.y===y&&e.side===side&&e.type===type);if(exit>=0)nodes[node].exits.add(exit);}
      else if(board[ny*7+nx]){const other=board[ny*7+nx];if(orient(other.piece,other.rotation,other.flipped).ports[(side+2)%4]===type)nodes[node].edges.add(portNode.get(`${ny*7+nx}:${(side+2)%4}`));}
    });
  }
  const seen=new Set(),networks=[];
  for(let i=0;i<nodes.length;i++)if(!seen.has(i)){
    const queue=[i],connected=new Set();seen.add(i);
    for(let p=0;p<queue.length;p++){const node=nodes[queue[p]];node.exits.forEach(e=>connected.add(e));for(const next of node.edges)if(!seen.has(next)){seen.add(next);queue.push(next);}}
    if(connected.size)networks.push(connected.size);
  }
  const network=networks.reduce((sum,n)=>sum+(n===12?45:Math.max(0,(n-1)*4)),0);
  const highway=includeLongest?longestRoute(board,'H'):null,railway=includeLongest?longestRoute(board,'R'):null;
  return {network,networks,highway,railway,center,errors,total:includeLongest?network+highway+railway+center-errors:null};
}
module.exports={longestRoute,score};
