import { test, expect } from 'bun:test'
import { Effect } from 'effect'
import { driver } from '../src/protocols/open-responses-continuation'
const mode = (previous: Readonly<Record<string, unknown>>, current: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(driver({ id:'test', name:'test', request:current, base:()=>Effect.die('unused') }).create({
    protocol:'open-responses.websocket.v1',value:{version:1,responseID:'response_test',request:previous,output:[]},
  })).then(x=>x.mode)

test('retains continuation with reordered keys and omitted undefined fields',async()=>{
 expect(await mode({model:'test',input:[{b:2,a:1,omit:undefined}]},{input:[{a:1,b:2},{type:'message',content:'new'}],model:'test'})).toBe('incremental')
})
test('changed nested content or model forces full request',async()=>{
 expect(await mode({model:'test',input:[{nested:[1,2]}]},{model:'test',input:[{nested:[1,3]},{}]})).toBe('full')
 expect(await mode({model:'a',input:[{}]},{model:'b',input:[{},{}]})).toBe('full')
})
test('large separately materialized media strings compare without changing protocol',async()=>{
 const a=Buffer.alloc(4*1024*1024,65).toString('base64');const b=Buffer.alloc(4*1024*1024,65).toString('base64')
 const previous={model:'test',input:[{type:'input_image',image_url:`data:image/png;base64,${a}`} ]}
 const current={model:'test',input:[{image_url:`data:image/png;base64,${b}`,type:'input_image'},{type:'message',content:'new'}]}
 expect(await mode(previous,current)).toBe('incremental')
 expect(await mode(previous,{...current,input:[{type:'input_image',image_url:`data:image/png;base64,${b.slice(0,-1)}x`},{}]})).toBe('full')
})
test('tool argument JSON key order remains equivalent',async()=>{
 expect(await mode({model:'test',input:[{type:'function_call',call_id:'call',name:'read',arguments:'{"b":2,"a":1}'}]},
 {model:'test',input:[{type:'function_call',call_id:'call',name:'read',arguments:'{"a":1,"b":2}'},{}]})).toBe('incremental')
})
