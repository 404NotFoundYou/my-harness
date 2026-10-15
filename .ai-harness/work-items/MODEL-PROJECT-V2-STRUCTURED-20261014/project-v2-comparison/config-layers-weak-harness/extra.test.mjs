import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

test("priority and string id ordering must not mutate frozen caller inputs",()=>{
  const layers = Object.freeze([
    Object.freeze({id:"a",priority:1,enabled:true,values:Object.freeze({x:3})}),
    Object.freeze({id:"z",priority:0,enabled:true,values:Object.freeze({x:2})}),
    Object.freeze({id:"off",priority:9,enabled:false,values:Object.freeze({x:99})}),
    Object.freeze({id:"Z",priority:0,enabled:true,values:Object.freeze({x:1})})
  ]);
  const ordered = orderedLayers(layers);
  assert.deepEqual(ordered.map(layer=>layer.id), ["Z","z","a"]);
  assert.equal(ordered[0],layers[3]);
  assert.deepEqual(layers.map(layer=>layer.id),["a","z","off","Z"]);
  assert.deepEqual(readConfig(layers),{config:{x:3},keys:["x"]});
  assert.deepEqual(readConfig([layers[1],layers[3]]),{config:{x:2},keys:["x"]});
});

test("arbitrary own string keys and undefined/null overrides remain data, never prototype setters",()=>{
  const marker = {nested:true};
  const low = Object.freeze({["__proto__"]:{polluted:true},constructor:1,toString:2,x:1,y:2,ref:marker});
  const high = { ["__proto__"]:null,x:undefined,y:null,"10":10,"2":2 };
  Object.defineProperty(high,"hidden",{value:42});
  Object.freeze(high);
  const layers = Object.freeze([
    Object.freeze({id:"low",priority:0,enabled:true,values:low}),
    Object.freeze({id:"high",priority:Number.MAX_SAFE_INTEGER,enabled:true,values:high})
  ]);
  const {config,keys} = readConfig(layers);
  assert.equal(Object.getPrototypeOf(config),Object.prototype);
  assert.equal(Object.hasOwn(config,"__proto__"),true);
  assert.equal(config.__proto__,null);
  assert.equal(Object.hasOwn(config,"x"),true);
  assert.equal(config.x,undefined);
  assert.equal(config.y,null);
  assert.equal(config.ref,marker);
  assert.equal(config.constructor,1);
  assert.equal(config.toString,2);
  assert.equal(config.hidden,42);
  assert.deepEqual(keys,["10","2","__proto__","constructor","hidden","ref","toString","x","y"]);
  assert.notEqual(config,resolveConfig(layers));
  assert.equal(low.x,1);
});

test("empty and disabled-only configurations return fresh empty objects",()=>{
  assert.deepEqual(readConfig([]),{config:{},keys:[]});
  assert.deepEqual(readConfig([{id:"off",priority:0,enabled:false,values:{x:1}}]),{config:{},keys:[]});
  assert.notEqual(resolveConfig([]),resolveConfig([]));
});
