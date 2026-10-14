import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

test("ordering protects frozen callers and uses string order rather than locale order",()=>{
  const layers=Object.freeze([
    {id:"a",priority:1,enabled:true,values:{}},
    {id:"off",priority:0,enabled:false,values:{x:9}},
    {id:"Z",priority:1,enabled:true,values:{}},
    {id:"first",priority:0,enabled:true,values:{}}
  ].map(layer=>Object.freeze({...layer,values:Object.freeze(layer.values)})));
  assert.deepEqual(orderedLayers(layers),[layers[3],layers[2],layers[0]]);
  assert.deepEqual(layers.map(layer=>layer.id),["a","off","Z","first"]);
  assert.notStrictEqual(orderedLayers(layers),layers);
});

test("merge preserves special own keys and later null or undefined without mutating values",()=>{
  const reference={nested:true};
  const lower=Object.freeze({x:1,y:2,constructor:3,["__proto__"]:{old:true}});
  const higher={x:null,y:undefined,constructor:undefined,["__proto__"]:reference,"10":10,"2":2};
  Object.defineProperty(higher,"hidden",{value:"own",enumerable:false});
  Object.freeze(higher);
  const layers=Object.freeze([
    Object.freeze({id:"a",priority:1,enabled:true,values:higher}),
    Object.freeze({id:"Z",priority:1,enabled:true,values:lower}),
    Object.freeze({id:"off",priority:9,enabled:false,values:Object.freeze({x:99})})
  ]);
  const {config,keys}=readConfig(layers);
  assert.equal(config.x,null);
  assert.equal(config.y,undefined);
  assert.equal(Object.hasOwn(config,"y"),true);
  assert.equal(Object.hasOwn(config,"constructor"),true);
  assert.equal(config.constructor,undefined);
  assert.equal(Object.getPrototypeOf(config),Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(config,"__proto__"),{value:reference,writable:true,enumerable:true,configurable:true});
  assert.equal(config.hidden,"own");
  assert.deepEqual(keys,["10","2","__proto__","constructor","hidden","x","y"]);
  assert.equal(lower.x,1);
  assert.equal(lower.y,2);
  assert.equal(higher.x,null);
  assert.notStrictEqual(config,higher);
  assert.notStrictEqual(resolveConfig(layers),config);
});

test("empty and all-disabled inputs produce fresh empty configs",()=>{
  assert.deepEqual(readConfig([]),{config:{},keys:[]});
  assert.deepEqual(readConfig([{id:"off",priority:0,enabled:false,values:{x:1}}]),{config:{},keys:[]});
  assert.notStrictEqual(resolveConfig([]),resolveConfig([]));
});
