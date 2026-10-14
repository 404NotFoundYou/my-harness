import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

test("read-only layers use priority then JavaScript id order, never disabled overrides",()=>{
  const layers=Object.freeze([
    {id:"z",priority:1,enabled:true,values:{x:"z"}},
    {id:"off",priority:9,enabled:false,values:{x:"off",hidden:true}},
    {id:"a",priority:1,enabled:true,values:{x:"a"}},
    {id:"Z",priority:1,enabled:true,values:{x:"Z"}},
    {id:"base",priority:0,enabled:true,values:{x:"base"}}
  ].map(layer=>Object.freeze({...layer,values:Object.freeze(layer.values)})));
  const before=[...layers];
  const ordered=orderedLayers(layers);
  assert.deepEqual(ordered.map(layer=>layer.id),["base","Z","a","z"]);
  assert.equal(ordered[0],layers[4]);
  assert.deepEqual(readConfig(layers),{config:{x:"z"},keys:["x"]});
  assert.deepEqual(layers,before);
  assert.notEqual(ordered,layers);
});

test("arbitrary own string keys and values survive without changing the result prototype",()=>{
  const reference={nested:true};
  const values=Object.freeze(Object.defineProperty({["__proto__"]:reference,constructor:null,toString:undefined,"2":2,"10":10,z:reference},"nonEnumerable",{value:7}));
  const layers=Object.freeze([
    Object.freeze({id:"later",priority:2,enabled:true,values:Object.freeze({nullable:null,cleared:undefined})}),
    Object.freeze({id:"first",priority:0,enabled:true,values}),
    Object.freeze({id:"base",priority:1,enabled:true,values:Object.freeze({nullable:1,cleared:2})})
  ]);
  const {config,keys}=readConfig(layers);
  assert.equal(Object.getPrototypeOf(config),Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(config,"__proto__").value,reference);
  assert.equal(config.constructor,null);
  assert.equal(config.toString,undefined);
  assert.equal(config.nonEnumerable,7);
  assert.equal(config.z,reference);
  assert.equal(config.nullable,null);
  assert.equal(Object.hasOwn(config,"cleared"),true);
  assert.equal(config.cleared,undefined);
  assert.deepEqual(keys,["10","2","__proto__","cleared","constructor","nonEnumerable","nullable","toString","z"]);
  assert.equal(values.__proto__,reference);
  assert.notEqual(config,values);
  assert.notEqual(resolveConfig(layers),config);
});

test("empty and all-disabled inputs yield independent empty configs",()=>{
  assert.deepEqual(readConfig([]),{config:{},keys:[]});
  assert.deepEqual(readConfig([{id:"off",priority:0,enabled:false,values:{x:1}}]),{config:{},keys:[]});
  assert.notEqual(resolveConfig([]),resolveConfig([]));
});
